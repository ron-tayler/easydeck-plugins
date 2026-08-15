import { createHash } from 'node:crypto';

import WebSocket from 'ws';

/**
 * A connection to OBS, and the protocol it speaks.
 *
 * obs-websocket version 5: a WebSocket carrying JSON messages tagged with an
 * opcode. The whole of it that matters here is a handshake, a request/response
 * pair keyed by an id we invent, and a stream of events. Kept apart from the
 * plugin so that what is protocol and what is EasyDeck stay separable — the
 * plugin below decides what a scene change *means*; this decides what one
 * looks like on the wire.
 *
 * Written against `ws` rather than the official client library: the protocol
 * needed here is a hundred lines, and a dependency that ships its own
 * reconnection policy, its own event emitter and its own opinions about
 * logging would be more to argue with than to gain.
 */

/** Opcodes, from the protocol document. */
const OP = {
  hello: 0,
  identify: 1,
  identified: 2,
  reidentify: 3,
  event: 5,
  request: 6,
  requestResponse: 7,
} as const;

/**
 * `EventSubscription::InputVolumeMeters`, which OBS keeps behind its own flag.
 *
 * Measured on the developer's machine: twenty events a second carrying every
 * input at once, whether or not anything is making a sound. That is the reason
 * it is a flag rather than part of the ordinary set, and the reason this
 * connection asks for it only while a key is showing a meter.
 */
export const VOLUME_METERS = 1 << 16;

/**
 * Which event categories to receive.
 *
 * General, Config, Scenes, Inputs, Transitions, Filters, Outputs and scene
 * items — everything a key can be bound to. Left off: media playback and the
 * high-volume streams OBS keeps behind separate flags, which nothing here
 * shows and which arrive many times a second.
 *
 * Every event is a message parsed and mostly discarded, so this is not free —
 * but the alternative is a deck that quietly fails to notice a filter being
 * switched off in OBS's own window, which is the thing this plugin exists to
 * avoid.
 */
const SUBSCRIPTIONS = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;

/** Long enough for OBS to answer while busy, short enough to notice a hang. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Waits between attempts, growing and then holding.
 *
 * OBS is usually not running rather than briefly unavailable, so the point is
 * to keep trying forever without keeping the machine busy. Half a minute is
 * where it settles: a person who has just started OBS should not wait longer
 * than that for the deck to notice.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** What obs-websocket closes with when the challenge is answered wrongly. */
const AUTH_FAILED_CODE = 4009;

export interface ObsAddress {
  readonly host: string;
  readonly port: number;
  readonly password: string;
}

export interface ObsConnectionOptions extends ObsAddress {
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
  readonly onEvent: (type: string, data: Record<string, unknown>) => void;
  /** Called on every change worth showing: connecting, connected, failed. */
  readonly onState: (state: 'connecting' | 'ready' | 'error', message?: string) => void;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface Pending {
  readonly resolve: (data: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class ObsConnection {
  private socket?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private closing = false;
  private ready = false;
  /** Whether this connection ever got as far as being identified. */
  private everReady = false;
  /**
   * Event flags asked for beyond the ordinary set.
   *
   * Kept rather than passed once, because it has to survive a reconnection: a
   * meter on screen when OBS restarts must still be a meter afterwards, and
   * the handshake that comes back knows nothing of what was asked before it.
   */
  private extra = 0;

  constructor(private readonly options: ObsConnectionOptions) {}

  get connected(): boolean {
    return this.ready;
  }

  /**
   * Asks for a high-volume event stream, or stops asking.
   *
   * OBS lets a live connection change its mind — that is what `Reidentify` is
   * for — so nothing is torn down and no request in flight is lost. Quiet when
   * the answer would not change anything, since this is called from a page
   * turn and most page turns do not involve a meter.
   */
  subscribeExtra(flags: number): void {
    if (flags === this.extra) return;
    this.extra = flags;

    if (!this.ready) return;
    this.socket?.send(
      JSON.stringify({ op: OP.reidentify, d: { eventSubscriptions: SUBSCRIPTIONS | this.extra } }),
    );
  }

  start(): void {
    this.closing = false;
    this.open();
  }

  /** Closes for good; a connection stopped this way never retries. */
  stop(): void {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;

    this.failPending(new Error('Disconnected from OBS'));
    this.ready = false;

    const socket = this.socket;
    this.socket = undefined;
    // Removed first: closing deliberately must not look like a connection
    // lost, or it would schedule a retry on the way out.
    socket?.removeAllListeners();
    // Terminated rather than closed: a polite close waits for the other end
    // to answer, and the usual reason for stopping is that OBS has gone.
    silence(socket);
    socket?.terminate();
  }

  /**
   * Sends a request and waits for the answer OBS gives it.
   *
   * Rejects rather than resolving empty when OBS refuses: an action that
   * quietly did nothing is the failure mode this whole plugin exists to
   * avoid, and a rejected action already shows a warning on the key.
   */
  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.ready) throw new Error('Not connected to OBS');

    const requestId = String(this.nextId++);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS did not answer '${requestType}' within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(requestId, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
        timer,
      });

      socket.send(
        JSON.stringify({
          op: OP.request,
          d: { requestType, requestId, ...(requestData ? { requestData } : {}) },
        }),
      );
    });
  }

  private open(): void {
    if (this.closing) return;

    const { host, port } = this.options;
    this.options.onState('connecting');

    const socket = new WebSocket(`ws://${host}:${port}`);
    this.socket = socket;

    socket.on('message', (raw) => this.receive(String(raw)));

    socket.on('error', (error: Error) => {
      // Reported here, retried in `close`: ws always follows an error with a
      // close, and scheduling from both would double every retry.
      this.options.onState('error', describeSocketError(error, host, port));
    });

    socket.on('close', (code: number) => {
      const wasReady = this.ready;
      this.ready = false;
      this.failPending(new Error('Connection to OBS closed'));

      if (wasReady) this.options.onState('error', 'Connection to OBS was lost');
      // Closed before the handshake finished, which OBS does when it does not
      // like the password. Reported here because nothing else will: the socket
      // opened perfectly well, so no error event ever fires, and without this
      // a wrong password looked exactly like OBS taking its time.
      else if (code === AUTH_FAILED_CODE) {
        this.options.onState('error', 'OBS refused the password');
      } else if (!this.everReady) {
        this.options.onState('error', `OBS at ${host}:${port} closed the connection`);
      }

      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.closing || this.retry) return;

    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;

    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.open();
    }, delay);
    this.retry.unref?.();
  }

  private receive(raw: string): void {
    let message: { op?: number; d?: Record<string, unknown> };
    try {
      message = JSON.parse(raw) as { op?: number; d?: Record<string, unknown> };
    } catch {
      this.options.log?.('warn', 'OBS sent something that is not JSON');
      return;
    }

    const data = message.d ?? {};

    switch (message.op) {
      case OP.hello:
        this.identify(data);
        return;

      /*
       * OBS answers a `Reidentify` with another `Identified`, so this arrives
       * again every time the subscriptions change — which is every time a page
       * with a meter on it is turned to. Announcing "connected" each time would
       * make the plugin re-read all of OBS and re-photograph every thumbnail
       * for a connection that never went anywhere.
       */
      case OP.identified: {
        const wasReady = this.ready;
        this.attempt = 0;
        this.ready = true;
        this.everReady = true;
        if (!wasReady) this.options.onState('ready');
        return;
      }

      case OP.event:
        this.options.onEvent(
          String(data['eventType'] ?? ''),
          (data['eventData'] as Record<string, unknown>) ?? {},
        );
        return;

      case OP.requestResponse:
        this.settle(data);
        return;

      default:
        // Batch responses and anything a newer OBS invents. Ignored rather
        // than logged: unknown opcodes are how the protocol grows.
        return;
    }
  }

  /**
   * Answers the handshake, with a password if one was asked for.
   *
   * The scheme is theirs: hash the password with the salt, hash that with the
   * challenge, and send the result — so the password itself never crosses the
   * socket, even on the loopback address where nobody could be listening
   * anyway.
   */
  private identify(hello: Record<string, unknown>): void {
    const auth = hello['authentication'] as { challenge?: string; salt?: string } | undefined;
    const identify: Record<string, unknown> = {
      rpcVersion: 1,
      // Whatever was asked for beyond the ordinary set is asked for again:
      // a meter that was on screen when OBS restarted is still on screen.
      eventSubscriptions: SUBSCRIPTIONS | this.extra,
    };

    if (auth?.challenge !== undefined && auth.salt !== undefined) {
      if (this.options.password === '') {
        this.options.onState('error', 'OBS wants a password, and none is set');
        this.stopWithoutRetryReset();
        return;
      }

      const secret = sha256(`${this.options.password}${auth.salt}`);
      identify['authentication'] = sha256(`${secret}${auth.challenge}`);
    }

    this.socket?.send(JSON.stringify({ op: OP.identify, d: identify }));
  }

  /**
   * Closes without giving up on retrying.
   *
   * Used when the settings are wrong rather than the connection: the user is
   * about to fix the password, and the plugin should notice when they do.
   */
  private stopWithoutRetryReset(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    silence(socket);
    socket?.terminate();
    this.scheduleRetry();
  }

  private settle(data: Record<string, unknown>): void {
    const requestId = String(data['requestId'] ?? '');
    const waiting = this.pending.get(requestId);
    if (!waiting) return;

    this.pending.delete(requestId);
    clearTimeout(waiting.timer);

    const status = (data['requestStatus'] as { result?: boolean; comment?: string }) ?? {};
    if (status.result === false) {
      waiting.reject(new Error(status.comment ?? `OBS refused '${data['requestType']}'`));
      return;
    }

    waiting.resolve((data['responseData'] as Record<string, unknown>) ?? {});
  }

  private failPending(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Keeps a discarded socket from throwing on its way out.
 *
 * Terminating one that has not finished connecting makes `ws` emit an error,
 * and an emitter with no error listener throws it at the process — so
 * stopping the plugin while OBS was unreachable could take the daemon down
 * with it. The listener is added back after the others are removed, on
 * purpose: it exists to be ignored.
 */
function silence(socket: WebSocket | undefined): void {
  socket?.on('error', () => undefined);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/**
 * Turns a socket error into something worth reading on a key.
 *
 * "connect ECONNREFUSED 127.0.0.1:4455" is accurate and tells a streamer
 * nothing they can act on; "OBS is not listening" tells them to start it or
 * to check the port.
 */
function describeSocketError(error: Error, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ECONNREFUSED') {
    return `Nothing is listening on ${host}:${port} — is OBS running with the WebSocket server enabled?`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENOTFOUND') return `Cannot reach ${host}`;
  if (code === 'ETIMEDOUT') return `${host}:${port} did not answer`;

  return error.message;
}

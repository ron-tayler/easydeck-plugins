import { WebSocket } from 'ws';

/**
 * A connection to VTube Studio, and the protocol it speaks.
 *
 * A WebSocket carrying JSON with a flat envelope: every message names its own
 * type and carries an id we invent, and an answer comes back tagged with the
 * same id. Simpler than obs-websocket — no opcodes, no challenge — with one
 * complication that shapes everything here.
 *
 * **A token cannot be asked for quietly.** Requesting one makes VTube Studio
 * put a dialog in front of the streamer, and answering it means switching
 * windows. So a plugin with no token does not reach for one on connect: it
 * says it needs authorising and waits to be told, which is what the button in
 * its settings is for. With a token, the whole thing is silent and survives
 * restarts on both sides.
 *
 * Kept apart from the plugin so what is protocol and what is EasyDeck stay
 * separable, exactly as with OBS.
 */

const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';

/** Long enough for VTube Studio to answer while rendering, short enough to notice a hang. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * How long a token request may take.
 *
 * This one waits on a person: the dialog appears in VTube Studio, they have to
 * find that window and press a button. A five second timeout would report a
 * failure while they were still reaching for the mouse.
 */
export const AUTHORISE_TIMEOUT_MS = 90_000;

/**
 * Waits between attempts, growing and then holding.
 *
 * VTube Studio is usually not running rather than briefly unavailable, so the
 * point is to keep trying forever without keeping the machine busy.
 */
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/** Refused by the user, or by a plugin allow-list; retrying will not help. */
const DENIED_ERRORS = new Set([50, 51]);

export interface VtsAddress {
  readonly host: string;
  readonly port: number;
}

export interface VtsConnectionOptions extends VtsAddress {
  /** What VTube Studio shows the user when asking them to allow this plugin. */
  readonly pluginName: string;
  readonly pluginDeveloper: string;
  /** Empty until the user has authorised once; then it is reused for good. */
  readonly token: () => string;
  /**
   * Called with a token VTube Studio has just granted, to be stored.
   *
   * Awaited before the session is authenticated: a token that failed to store
   * would leave the plugin working now and asking again after a restart, with
   * nothing said at the moment it could have been noticed.
   */
  readonly onToken: (token: string) => void | Promise<void>;
  readonly onEvent: (type: string, data: Record<string, unknown>) => void;
  readonly onState: (
    state: 'connecting' | 'ready' | 'error' | 'unauthorised',
    message?: string,
  ) => void;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
}

interface Pending {
  readonly resolve: (data: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** What VTube Studio answered, when it answered with a refusal. */
export class VtsError extends Error {
  constructor(
    message: string,
    readonly errorId: number,
  ) {
    super(message);
    this.name = 'VtsError';
  }
}

export class VtsConnection {
  private socket?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private closing = false;
  /** Authenticated, not merely connected: nothing else may be asked for. */
  private ready = false;
  private everReady = false;

  constructor(private readonly options: VtsConnectionOptions) {}

  get connected(): boolean {
    return this.ready;
  }

  /** Whether the socket is up, whether or not this session is authenticated. */
  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closing = false;
    this.connect();
  }

  stop(): void {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;

    this.failPending(new Error('Disconnected from VTube Studio'));
    this.ready = false;

    const socket = this.socket;
    this.socket = undefined;
    // Removed first, so closing deliberately does not look like a connection
    // lost and schedule a retry on the way out.
    socket?.removeAllListeners();
    silence(socket);
    socket?.terminate();
  }

  /**
   * Sends a request and waits for the answer.
   *
   * Rejects rather than resolving empty when VTube Studio refuses: an action
   * that quietly did nothing is the failure this plugin exists to avoid, and a
   * rejected action already shows a warning on the key.
   */
  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    messageType: string,
    data: Record<string, unknown> = {},
    options: { timeoutMs?: number; beforeAuth?: boolean } = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to VTube Studio');
    }
    // Authentication itself has to travel before there is a session, and
    // nothing else may.
    if (!this.ready && !options.beforeAuth) throw new Error('Not connected to VTube Studio');

    const requestID = `easydeck-${this.nextId++}`;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`VTube Studio did not answer '${messageType}' within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(requestID, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
        timer,
      });

      socket.send(JSON.stringify({ apiName: API_NAME, apiVersion: API_VERSION, requestID, messageType, data }));
    });
  }

  /**
   * Asks VTube Studio for a token, which puts a dialog in front of the user.
   *
   * Only ever called because somebody pressed the button: see the note on this
   * class. The token that comes back is handed over to be stored and used at
   * once, so authorising also connects.
   */
  async authorise(): Promise<void> {
    const granted = await this.request<{ authenticationToken?: string }>(
      'AuthenticationTokenRequest',
      { pluginName: this.options.pluginName, pluginDeveloper: this.options.pluginDeveloper },
      { timeoutMs: AUTHORISE_TIMEOUT_MS, beforeAuth: true },
    );

    const token = String(granted['authenticationToken'] ?? '');
    if (token === '') throw new Error('VTube Studio granted no token');

    await this.options.onToken(token);
    await this.authenticate(token);
  }

  /** Subscribes to one event; the answers arrive through `onEvent`. */
  async subscribe(eventName: string): Promise<void> {
    await this.request('EventSubscriptionRequest', { eventName, subscribe: true, config: {} });
  }

  private connect(): void {
    if (this.closing) return;

    const { host, port } = this.options;
    this.options.onState('connecting');

    const socket = new WebSocket(`ws://${host}:${port}`);
    this.socket = socket;

    socket.on('open', () => {
      void this.begin();
    });

    socket.on('message', (raw) => this.receive(String(raw)));

    socket.on('error', (error: Error) => {
      // Reported here, retried in `close`: ws always follows an error with a
      // close, and scheduling from both would double every retry.
      this.options.onState('error', describeSocketError(error, host, port));
    });

    socket.on('close', () => {
      const wasReady = this.ready;
      this.ready = false;
      this.failPending(new Error('Connection to VTube Studio closed'));

      if (wasReady) this.options.onState('error', 'Connection to VTube Studio was lost');
      else if (!this.everReady) {
        this.options.onState('error', `VTube Studio at ${host}:${port} closed the connection`);
      }

      this.scheduleRetry();
    });
  }

  /**
   * What happens the moment the socket opens.
   *
   * With a token, authenticate and say nothing. Without one, stop here and
   * report that authorising is needed — reaching for a token would throw a
   * dialog at somebody who is probably live.
   */
  private async begin(): Promise<void> {
    const token = this.options.token();

    if (token === '') {
      this.attempt = 0;
      this.options.onState('unauthorised');
      return;
    }

    try {
      await this.authenticate(token);
    } catch (error) {
      this.options.onState('error', (error as Error).message);
    }
  }

  private async authenticate(token: string): Promise<void> {
    const answer = await this.request<{ authenticated?: boolean; reason?: string }>(
      'AuthenticationRequest',
      {
        pluginName: this.options.pluginName,
        pluginDeveloper: this.options.pluginDeveloper,
        authenticationToken: token,
      },
      { beforeAuth: true },
    );

    if (answer['authenticated'] !== true) {
      // A token VTube Studio no longer recognises — the user cleared the
      // plugin list, or the file moved. Said plainly, because the fix is to
      // press Authorise again.
      throw new Error(String(answer['reason'] ?? 'VTube Studio refused the stored token'));
    }

    this.attempt = 0;
    this.ready = true;
    this.everReady = true;
    this.options.onState('ready');
  }

  private scheduleRetry(): void {
    if (this.closing || this.retry) return;

    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;

    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, delay);
    this.retry.unref?.();
  }

  private receive(raw: string): void {
    let message: { messageType?: string; requestID?: string; data?: Record<string, unknown> };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      this.options.log?.('warn', 'VTube Studio sent something that is not JSON');
      return;
    }

    const type = String(message.messageType ?? '');
    const data = message.data ?? {};
    const waiting = message.requestID ? this.pending.get(message.requestID) : undefined;

    if (waiting) {
      this.pending.delete(message.requestID!);
      clearTimeout(waiting.timer);

      if (type === 'APIError') {
        waiting.reject(
          new VtsError(String(data['message'] ?? 'VTube Studio refused the request'), Number(data['errorID'] ?? 0)),
        );
        return;
      }

      waiting.resolve(data);
      return;
    }

    // An event carries the requestID of the subscription that asked for it,
    // which is long since settled — so anything left is news rather than an
    // answer.
    if (type.endsWith('Event')) this.options.onEvent(type, data);
  }

  private failPending(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}

/** Whether a refusal is one that trying again cannot mend. */
export function isDenial(error: unknown): boolean {
  return error instanceof VtsError && DENIED_ERRORS.has(error.errorId);
}

/**
 * Keeps a discarded socket from throwing on its way out.
 *
 * Terminating one that has not finished connecting makes `ws` emit an error,
 * and an emitter with no error listener throws it at the process. The listener
 * is added back after the others are removed, on purpose: it exists to be
 * ignored.
 */
function silence(socket: WebSocket | undefined): void {
  socket?.on('error', () => undefined);
}

/**
 * Turns a socket error into something worth reading on a key.
 *
 * "connect ECONNREFUSED 127.0.0.1:8001" is accurate and tells a streamer
 * nothing they can act on; "VTube Studio is not listening" tells them to start
 * it, or to switch its API on.
 */
function describeSocketError(error: Error, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ECONNREFUSED') {
    return `VTube Studio is not listening on ${host}:${port} — start it, and switch its API on in Settings`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENOTFOUND') return `Cannot reach ${host}`;

  return error.message;
}

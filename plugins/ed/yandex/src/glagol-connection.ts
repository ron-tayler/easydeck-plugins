import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

/**
 * One speaker, over the local network.
 *
 * The protocol is called Glagol and it is the plainest thing in this plugin: a
 * WebSocket carrying JSON, where everything sent is a command in an envelope
 * and everything received is the speaker's entire state. There is no request
 * and no reply — a command is sent, and the next state says what came of it.
 *
 * Two details are not obvious and both are load-bearing.
 *
 * **The certificate is self-signed.** A speaker on a home network has no name
 * to be issued a certificate for, so it signs its own. Verification is off,
 * which is the same bargain every other program that speaks to these makes.
 *
 * **A bad token is a close, not an answer.** Code 4000 with `Invalid token`,
 * and no message before it. So a socket that opens and immediately shuts is
 * not a network problem — it means the token has gone stale, and the next
 * attempt needs a fresh one rather than the same one again.
 */

/** What the speaker says about itself, and all this plugin reads. */
export interface SpeakerState {
  readonly aliceState?: string;
  readonly playing?: boolean;
  readonly volume?: number;
  readonly playerState?: PlayerState;
}

export interface PlayerState {
  readonly title?: string;
  /** The artist, despite the name. */
  readonly subtitle?: string;
  readonly duration?: number;
  readonly progress?: number;
  readonly hasNext?: boolean;
  readonly hasPrev?: boolean;
  readonly hasPause?: boolean;
  readonly hasPlay?: boolean;
  readonly hasProgressBar?: boolean;
  readonly id?: string;
  readonly playlistType?: string;
  readonly entityInfo?: {
    readonly type?: string;
    readonly repeatMode?: string;
    readonly shuffled?: boolean;
  };
  readonly extra?: {
    /** `avatars.yandex.net/…/%%`, where `%%` is where a size goes. */
    readonly coverURI?: string;
    readonly stateType?: string;
  };
}

export type ConnectionState = 'connecting' | 'ready' | 'error' | 'rejected';

export interface GlagolOptions {
  readonly host: string;
  readonly port: number;
  /**
   * The key for this speaker, fetched for the attempt about to be made.
   *
   * Asynchronous because it usually is not held: a speaker's token is
   * short-lived, so it is asked for when a connection is opened rather than
   * kept. `stale` says the last one was refused, which is what turns a retry
   * into a fresh request instead of the same refusal again.
   */
  readonly token: (stale: boolean) => Promise<string>;
  readonly onState: (state: SpeakerState) => void;
  readonly onConnection: (state: ConnectionState, message?: string) => void;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
  /**
   * Off only in tests, where the stand-in speaker is a plain socket.
   *
   * Nothing about the protocol changes with it. The speaker's certificate is
   * self-signed and therefore unverified either way, so the encryption here
   * buys secrecy on the wire and no assurance about who is on the other end —
   * which is why a test can drop it without testing something else.
   */
  readonly secure?: boolean;
}

/**
 * Waits between attempts, growing and then holding.
 *
 * A speaker is usually unplugged or rebooting rather than briefly busy, so
 * this keeps trying for ever without keeping the machine awake.
 */
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/** The speaker's own close code for a token it will not accept. */
const INVALID_TOKEN = 4000;

/**
 * How often to say something into a quiet socket.
 *
 * The speaker sends its state unprompted every second or so while anything is
 * happening, and roughly every three when nothing is. A ping under that keeps
 * the connection from being reaped by a router that has decided it is idle.
 */
const PING_EVERY_MS = 30_000;

export class GlagolConnection {
  private socket?: WebSocket;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private stopped = false;
  /** The token this connection is using, sent with every command. */
  private current = '';
  /** The last token was refused, so the next attempt must not reuse it. */
  private refused = false;

  constructor(private readonly options: GlagolOptions) {}

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.retry = undefined;
    this.ping = undefined;

    const socket = this.socket;
    this.socket = undefined;
    // Listeners off first: closing deliberately must not look like a drop and
    // schedule a reconnect to a speaker nobody is watching any more.
    socket?.removeAllListeners();
    socket?.close();
  }

  /**
   * Sends a command. Nothing comes back — watch the state instead.
   *
   * Throwing when the socket is shut is deliberate: a key that did nothing
   * should say so, and the runtime turns a thrown action into a message rather
   * than a silence.
   */
  send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('The speaker is not connected');

    socket.send(
      JSON.stringify({
        conversationToken: this.current,
        id: randomUUID(),
        sentTime: Date.now(),
        payload,
      }),
    );
  }

  private connect(): void {
    if (this.stopped) return;

    clearTimeout(this.retry);
    this.retry = undefined;

    this.options.onConnection('connecting');
    void this.openSocket();
  }

  /**
   * Gets a key for this attempt and opens the socket with it.
   *
   * Apart from `connect` only because asking for the token is a request over
   * the network now: it used to be a value held in settings, which is what
   * made a deck stop working overnight.
   */
  private async openSocket(): Promise<void> {
    let token: string;
    try {
      token = await this.options.token(this.refused);
      this.refused = false;
    } catch (error) {
      this.options.onConnection('error', (error as Error).message);
      this.scheduleRetry();
      return;
    }

    if (this.stopped) return;
    if (token === '') {
      // Nothing to try with — not signed in, or this speaker belongs to
      // somebody else. Said once rather than attempted every few seconds.
      this.options.onConnection('rejected', 'No token for this speaker yet');
      return;
    }

    this.current = token;

    const scheme = this.options.secure === false ? 'ws' : 'wss';
    const socket = new WebSocket(`${scheme}://${this.options.host}:${this.options.port}`, {
      rejectUnauthorized: false,
      handshakeTimeout: 5000,
    });
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.options.onConnection('ready');

      // The first ping is what proves the token: a wrong one is answered with
      // a close rather than an error, and until something is sent the socket
      // looks perfectly healthy.
      this.safely(() => this.send({ command: 'ping' }));
      clearInterval(this.ping);
      this.ping = setInterval(() => this.safely(() => this.send({ command: 'ping' })), PING_EVERY_MS);
      this.ping.unref?.();
    });

    socket.on('message', (raw) => {
      let message: { state?: SpeakerState };
      try {
        message = JSON.parse(String(raw)) as { state?: SpeakerState };
      } catch {
        this.options.log?.('warn', 'The speaker sent something that is not JSON');
        return;
      }

      // Everything interesting is under `state`; the rest of the envelope is
      // experiment flags and base64 the deck has no use for.
      if (message.state) this.options.onState(message.state);
    });

    socket.on('error', (error: Error) => {
      this.options.log?.('warn', `${this.options.host}: ${error.message}`);
    });

    socket.on('close', (code, reason) => {
      clearInterval(this.ping);
      this.ping = undefined;
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;

      if (code === INVALID_TOKEN) {
        /*
         * The key has gone stale, which happens on its own within a day.
         *
         * This used to give up and wait for somebody to press "Find speakers"
         * — a deck that worked yesterday and not this morning. Now the next
         * attempt asks for a new token instead of offering the same one.
         */
        this.refused = true;
        this.options.onConnection('error', String(reason) || 'The speaker refused the token');
        this.scheduleRetry();
        return;
      }

      this.options.onConnection('error', String(reason) || `Connection closed (${code})`);
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 30_000;
    this.attempt += 1;

    this.retry = setTimeout(() => this.connect(), delay);
    this.retry.unref?.();
  }

  /** Sending can throw on a socket that shut between the check and the write. */
  private safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.log?.('warn', (error as Error).message);
    }
  }
}

import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';

/**
 * The pipe Discord listens on, and the protocol it speaks over it.
 *
 * Nothing to do with the bot API: the desktop client opens a local socket and
 * answers questions about *this* person's Discord — what they are muted to,
 * which voice channel they are in, who is talking. That is the only way a
 * deck key can mute a microphone, because muting is a thing the client does
 * and the server never hears about.
 *
 * The framing is four bytes of opcode, four of length, then JSON — all
 * little-endian, which is the one detail worth stating because every other
 * length prefix in this codebase is big-endian.
 *
 * Kept apart from the plugin so what is Discord and what is EasyDeck stay
 * separable, exactly as with OBS and VTube Studio.
 */

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** The RPC version every client has spoken since 2017. */
const RPC_VERSION = 1;

/**
 * Discord numbers its pipes: the second copy running takes the next one.
 *
 * Ten is what every client library tries, and it is enough — the tenth would
 * mean ten Discord clients on one machine.
 */
const PIPES = 10;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a person has to answer the authorisation dialog.
 *
 * This one waits on somebody finding the Discord window and reading it, so
 * the ordinary timeout would report a failure while they were still moving
 * the mouse.
 */
export const AUTHORIZE_TIMEOUT_MS = 120_000;

export type ConnectionState = 'connecting' | 'ready' | 'error';

export interface DiscordIpcOptions {
  readonly clientId: () => string;
  readonly onEvent: (event: string, data: Record<string, unknown>) => void;
  readonly onState: (state: ConnectionState, message?: string) => void;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
  /** Overridden by tests, which listen on a socket of their own. */
  readonly path?: string;
}

/** What Discord answered, when it answered with a refusal. */
export class DiscordError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'DiscordError';
  }
}

/**
 * Waits between attempts, growing and then holding.
 *
 * Discord is usually not running rather than briefly unavailable, so this
 * keeps trying for ever without keeping the machine busy.
 */
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

interface Pending {
  readonly resolve: (data: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class DiscordIpc {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  /** True once the handshake has been answered; commands wait for it. */
  private handshaken = false;

  constructor(private readonly options: DiscordIpcOptions) {}

  get connected(): boolean {
    return this.handshaken && this.socket !== undefined;
  }

  start(): void {
    this.stopped = false;
    this.connect(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;

    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Disconnected from Discord'));
    }
    this.pending.clear();

    const socket = this.socket;
    this.socket = undefined;
    this.handshaken = false;
    // Listeners off first: closing deliberately must not look like a drop and
    // schedule a reconnect to a Discord nobody is watching any more.
    socket?.removeAllListeners();
    socket?.destroy();
  }

  /**
   * Sends a command and waits for the answer with the same nonce.
   *
   * Every RPC command is a request/response pair keyed by a nonce we invent —
   * events arrive with no nonce at all, which is how the two are told apart.
   */
  async command<T = Record<string, unknown>>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.handshaken) throw new Error('Discord is not connected');

    const nonce = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`Discord did not answer '${cmd}'`));
      }, timeoutMs);

      this.pending.set(nonce, { resolve: resolve as Pending['resolve'], reject, timer });
      this.write(OP_FRAME, { cmd, args, nonce });
    });
  }

  /**
   * Asks to be told when something changes.
   *
   * Most events need an argument saying *what* to watch — a channel id for
   * who is speaking in it — and Discord answers a bare subscription with an
   * error rather than watching everything.
   */
  async subscribe(event: string, args: Record<string, unknown> = {}): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.handshaken) throw new Error('Discord is not connected');

    const nonce = randomUUID();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`Discord did not answer a subscription to '${event}'`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(nonce, { resolve: () => resolve(), reject, timer });
      this.write(OP_FRAME, { cmd: 'SUBSCRIBE', evt: event, args, nonce });
    });
  }

  async unsubscribe(event: string, args: Record<string, unknown> = {}): Promise<void> {
    if (!this.connected) return;

    const nonce = randomUUID();
    await new Promise<void>((resolve) => {
      // Failing to unsubscribe is not worth an error: the subscription dies
      // with the socket anyway, and this is called while tidying up.
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        resolve();
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(nonce, { resolve: () => resolve(), reject: () => resolve(), timer });
      this.write(OP_FRAME, { cmd: 'UNSUBSCRIBE', evt: event, args, nonce });
    });
  }

  // --- the socket -----------------------------------------------------------

  private connect(pipe: number): void {
    if (this.stopped) return;

    clearTimeout(this.retry);
    this.retry = undefined;

    const clientId = this.options.clientId();
    if (clientId === '') {
      // Nothing to introduce ourselves as. Said once rather than attempted
      // and refused every few seconds for as long as the program runs.
      this.options.onState('error', 'No application id yet');
      return;
    }

    if (pipe === 0) this.options.onState('connecting');

    const socket = connect(this.options.path ?? pipePath(pipe));
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;

    socket.on('connect', () => {
      // The handshake is opcode 0 and carries no nonce: Discord answers it
      // with a READY event rather than with a response.
      this.write(OP_HANDSHAKE, { v: RPC_VERSION, client_id: clientId });
    });

    socket.on('data', (chunk) => this.receive(chunk));

    socket.on('error', (error: Error) => {
      if (this.socket !== socket || this.stopped) return;
      this.options.log?.('warn', error.message);
    });

    socket.on('close', () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      this.handshaken = false;

      /*
       * The next pipe, before giving up.
       *
       * A second Discord — a beta build beside the stable one — takes
       * `discord-ipc-1`, and the first pipe then refuses instantly. Walking
       * the numbers costs nothing when Discord is not running at all, since
       * every one of them refuses at once.
       */
      if (pipe + 1 < PIPES) {
        this.connect(pipe + 1);
        return;
      }

      this.options.onState('error', 'Discord is not running');
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 30_000;
    this.attempt += 1;

    this.retry = setTimeout(() => this.connect(0), delay);
    this.retry.unref?.();
  }

  private write(opcode: number, payload: unknown): void {
    const socket = this.socket;
    if (!socket) return;

    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    // Little-endian, unlike every other length prefix in this codebase.
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.byteLength, 4);

    socket.write(Buffer.concat([header, body]));
  }

  /**
   * Reassembles frames out of whatever the socket handed over.
   *
   * A pipe delivers bytes, not messages: one read can hold half a frame or
   * three of them, and Discord sends bursts of voice-state events that make
   * both happen.
   */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.byteLength < 8) return;

      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.byteLength < 8 + length) return;

      const body = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        this.options.log?.('warn', 'Discord sent something that is not JSON');
        continue;
      }

      this.handle(opcode, message);
    }
  }

  private handle(opcode: number, message: Record<string, unknown>): void {
    if (opcode === OP_PING) {
      this.write(OP_PONG, message);
      return;
    }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CLOSE) {
      const code = Number(message['code'] ?? 0);
      const reason = String(message['message'] ?? 'Discord closed the connection');
      this.options.log?.('warn', `${reason} (${code})`);
      this.socket?.destroy();
      return;
    }

    const nonce = typeof message['nonce'] === 'string' ? message['nonce'] : undefined;
    const event = typeof message['evt'] === 'string' ? message['evt'] : undefined;
    const data = (message['data'] as Record<string, unknown> | undefined) ?? {};

    /*
     * READY is the handshake's answer, and arrives without a nonce.
     *
     * Everything else has to wait for it: a command sent between connecting
     * and this is answered with an error about not being ready.
     */
    if (event === 'READY') {
      this.attempt = 0;
      this.handshaken = true;
      this.options.onState('ready');
      return;
    }

    // An answer to something asked. Errors come back the same way, tagged.
    if (nonce) {
      const waiting = this.pending.get(nonce);
      if (!waiting) return;

      this.pending.delete(nonce);
      clearTimeout(waiting.timer);

      if (event === 'ERROR') {
        waiting.reject(
          new DiscordError(String(data['message'] ?? 'Discord refused'), Number(data['code'] ?? 0)),
        );
        return;
      }

      waiting.resolve(data);
      return;
    }

    // No nonce and not READY: something changed on its own.
    if (event) this.options.onEvent(event, data);
  }
}

/**
 * Where the client listens.
 *
 * A named pipe on Windows and a socket file everywhere else — and on Linux
 * the file lives in whichever runtime directory the session has, which is
 * why the search is a list rather than a path.
 */
export function pipePath(index: number): string {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;

  const base =
    process.env['XDG_RUNTIME_DIR'] ??
    process.env['TMPDIR'] ??
    process.env['TMP'] ??
    process.env['TEMP'] ??
    '/tmp';

  return `${base}/discord-ipc-${index}`;
}

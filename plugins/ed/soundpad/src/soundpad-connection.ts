import { connect } from 'node:net';
import type { Socket } from 'node:net';

/**
 * A connection to Soundpad, and the protocol it speaks.
 *
 * A Windows named pipe carrying plain text: the command as written in its
 * remote-control documentation — `DoPlaySound(3)`, `GetVolume()` — and the
 * answer straight back. No handshake, no password, no event stream. One pipe
 * serves any number of requests, and each answer arrives as its own write.
 *
 * Everything here was measured against Soundpad 4.0.30, remote control 1.1.2:
 *
 * - a `Do…` command answers `R-200` when it worked and another `R-` code when
 *   it did not — `R-204: Category not found.` for something that is not there;
 * - a `Get…` command answers with the bare value: `100`, `STOPPED`, `0`;
 * - an unknown command answers `R-404: Command not found.`;
 * - a list answers with an XML document.
 *
 * Kept apart from the plugin so that what is protocol and what is EasyDeck stay
 * separable — the plugin decides what a sound *is*; this decides what asking
 * for one looks like on the wire.
 */

/** Where Soundpad listens. Fixed by Soundpad, not a setting. */
export const SOUNDPAD_PIPE = '\\\\.\\pipe\\sp_remote_control';

/** The one answer that means a command did what it was asked. */
const OK = 'R-200';

/** Long enough for Soundpad to answer while busy, short enough to notice a hang. */
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Waits between attempts, growing and then holding.
 *
 * Soundpad is usually not running rather than briefly unavailable, so the point
 * is to keep trying forever without keeping the machine busy. Half a minute is
 * where it settles.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface SoundpadConnectionOptions {
  /** Overridden by tests, which listen on a pipe of their own. */
  readonly pipe?: string;
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
  /** Called on every change worth showing: connecting, connected, failed. */
  readonly onState: (state: 'connecting' | 'ready' | 'error', message?: string) => void;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface Pending {
  readonly command: string;
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
}

export class SoundpadConnection {
  private socket?: Socket;
  private ready = false;
  private closing = false;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  /** Whether this connection ever got as far as being usable. */
  private everReady = false;

  /**
   * One request at a time, the rest waiting their turn.
   *
   * The protocol has nothing to match an answer to a question by — no request
   * id, no length, no terminator — so the only thing that says which answer is
   * which is that only one question is outstanding. Two in flight would be two
   * answers nobody could tell apart.
   */
  private readonly waiting: Pending[] = [];
  private current?: Pending;
  private timer?: NodeJS.Timeout;
  private buffer = '';

  constructor(private readonly options: SoundpadConnectionOptions) {}

  get connected(): boolean {
    return this.ready;
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

    this.failAll(new Error('Disconnected from Soundpad'));
    this.ready = false;

    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    // Added back on purpose, to be ignored: destroying a pipe that has not
    // finished connecting makes Node emit an error, and an emitter with no
    // listener throws it at the process.
    socket?.on('error', () => undefined);
    socket?.destroy();
  }

  /**
   * Asks a question and gives back the answer as Soundpad wrote it.
   *
   * For the `Get…` commands, whose answer is the value itself. A refusal comes
   * back as its `R-` code rather than as a rejection, because for a question
   * "no" is an answer.
   */
  async ask(command: string): Promise<string> {
    if (!this.socket || !this.ready) throw new Error('Not connected to Soundpad');

    return new Promise<string>((resolve, reject) => {
      this.waiting.push({ command, resolve, reject });
      this.pump();
    });
  }

  /**
   * Gives an order and insists it was carried out.
   *
   * Rejects rather than returning quietly when Soundpad refuses: an action that
   * silently did nothing is the failure mode a deck cannot afford, and a
   * rejected action already shows a warning on the key. A sound deleted from
   * the list since the profile named it answers `R-204`, and that is exactly
   * the case worth seeing.
   */
  async tell(command: string): Promise<void> {
    const answer = (await this.ask(command)).trim();
    if (answer === OK) return;

    throw new Error(`Soundpad refused '${command}': ${answer}`);
  }

  private open(): void {
    if (this.closing) return;

    const path = this.options.pipe ?? SOUNDPAD_PIPE;
    this.options.onState('connecting');

    const socket = connect(path);
    this.socket = socket;

    socket.on('connect', () => {
      this.attempt = 0;
      this.ready = true;
      this.everReady = true;
      this.options.onState('ready');
      this.pump();
    });

    socket.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));

    socket.on('error', (error: Error) => {
      // Reported here, retried in `close`: Node always follows an error with a
      // close, and scheduling from both would double every retry.
      this.options.onState('error', describe(error));
    });

    socket.on('close', () => {
      const wasReady = this.ready;
      this.ready = false;
      this.failAll(new Error('Connection to Soundpad closed'));

      if (wasReady) this.options.onState('error', 'Soundpad closed the connection');
      else if (!this.everReady) this.options.onState('error', notRunning());

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

  /** Sends the next question, if there is one and nothing is outstanding. */
  private pump(): void {
    if (this.current || !this.ready || !this.socket) return;

    const next = this.waiting.shift();
    if (!next) return;

    this.current = next;
    this.buffer = '';

    this.timer = setTimeout(() => {
      const late = this.current;
      this.current = undefined;
      this.buffer = '';
      late?.reject(
        new Error(`Soundpad did not answer '${late.command}' within ${REQUEST_TIMEOUT_MS}ms`),
      );
      this.pump();
    }, REQUEST_TIMEOUT_MS);
    this.timer.unref?.();

    this.socket.write(next.command, 'utf8');
  }

  private receive(text: string): void {
    const answering = this.current;
    if (!answering) {
      // Nothing asked for it. Logged rather than dropped silently, because the
      // only way this happens is a request that timed out and then answered.
      this.options.log?.('warn', `Soundpad said '${text.trim()}' with nothing outstanding`);
      return;
    }

    this.buffer += text;
    if (!isComplete(this.buffer)) return;

    const answer = this.buffer;
    this.buffer = '';
    this.current = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    answering.resolve(answer);
    this.pump();
  }

  private failAll(error: Error): void {
    const outstanding = this.current;
    this.current = undefined;
    this.buffer = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    outstanding?.reject(error);
    while (this.waiting.length > 0) this.waiting.shift()?.reject(error);
  }
}

/**
 * Whether the whole answer has arrived.
 *
 * Nothing frames these — no length, no terminator — so this is the one place
 * that decides. A code or a value is a handful of bytes and arrives whole; a
 * sound list is a document that may well not, and waiting for its root element
 * to close is the only honest test. The root's name is read from the document
 * rather than listed here, so a list this plugin has never heard of still
 * arrives in one piece.
 */
export function isComplete(text: string): boolean {
  const start = text.indexOf('<?xml');
  if (start < 0) return true;

  const root = /<([A-Za-z][\w.-]*)([^>]*)>/.exec(text.slice(text.indexOf('?>', start) + 2));
  if (!root) return false;

  // `<Categories/>`: a document with nothing in it is already finished.
  if (root[2]?.trimEnd().endsWith('/') === true) return true;

  return text.includes(`</${root[1]}>`);
}

/**
 * What a person can act on, instead of what Node said.
 *
 * "connect ENOENT \\.\pipe\sp_remote_control" is accurate and tells a streamer
 * nothing; the pipe is absent for exactly one reason worth naming.
 */
function describe(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' ? notRunning() : error.message;
}

function notRunning(): string {
  return 'Soundpad is not running — start it, and this connects on its own';
}

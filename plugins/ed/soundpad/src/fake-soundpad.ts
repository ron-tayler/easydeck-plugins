import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A Soundpad that is not Soundpad, for the tests.
 *
 * Answers by command name and nothing else. Written rather than mocked because
 * the parts worth testing only exist on a real socket: a request matched to its
 * answer with nothing in the protocol to match them by, a document that arrives
 * in pieces, a far end that vanishes. A fake connection object would agree with
 * any client at all.
 *
 * Not a test file itself, so it compiles but never runs on its own.
 */

export interface FakeSoundpadOptions {
  /** Answers by command, name and parentheses included. */
  readonly answers?: Record<string, string>;
  /**
   * Documents to hand over a few bytes at a time.
   *
   * The one thing a fake can do that the real one will not do on demand: split
   * an answer across writes, which is the case the framing exists for.
   */
  readonly inPieces?: boolean;
}

export class FakeSoundpad {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  /** Every command that arrived, in order, for assertions. */
  readonly commands: string[] = [];
  /** Answers put here override the ones it was built with. */
  readonly answers: Record<string, string>;
  readonly path: string;

  constructor(private readonly options: FakeSoundpadOptions = {}) {
    this.answers = { ...(options.answers ?? {}) };

    /*
     * A Windows named pipe where there is one, a socket file where there is
     * not. `net` treats both as a path, so nothing above this line has to know
     * which — and the plugin is handed the path rather than finding it, which
     * is the only reason these tests can run at all while Soundpad is closed.
     */
    const name = `easydeck-soundpad-${process.pid}-${this.sockets.size}-${Math.random().toString(36).slice(2)}`;
    this.path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), name);

    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => this.receive(socket, chunk.toString('utf8')));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(this.path, resolve));
    return this.path;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drops every connection without shutting down: what a restart looks like. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private receive(socket: Socket, command: string): void {
    this.commands.push(command);

    const answer = this.answers[command];
    if (answer === undefined) {
      // What a real one says, and the reason a plugin must not read `R-404` as
      // "it worked".
      socket.write('R-404: Command not found.');
      return;
    }

    if (!this.options.inPieces || answer.length < 8) {
      socket.write(answer);
      return;
    }

    // Two writes with a gap: an answer that arrives whole by accident would
    // pass whatever the framing did.
    const cut = Math.floor(answer.length / 2);
    socket.write(answer.slice(0, cut));
    setTimeout(() => {
      if (!socket.destroyed) socket.write(answer.slice(cut));
    }, 15);
  }
}

/** A sound list of the shape Soundpad really produces, for the fake to hand over. */
export function soundlist(
  sounds: readonly { index: number; title?: string; url?: string; tag?: string }[],
): string {
  const rows = sounds
    .map(
      (sound) =>
        `  <Sound index="${sound.index}" url="${sound.url ?? ''}" artist="" ` +
        `title="${sound.title ?? ''}" duration="0:02" playCount="0" ` +
        `tag="${sound.tag ?? sound.title ?? ''}"/>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Soundlist>\n${rows}\n</Soundlist>\n`;
}

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A Discord client, for tests that must not need one running.
 *
 * Speaks the same framing — opcode, length, JSON, all little-endian — and
 * answers the handful of commands this plugin sends. What it deliberately
 * does model is the awkward half: the handshake answered with a READY event
 * rather than a response, errors that come back tagged rather than thrown,
 * and a nonce on every answer.
 */

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

export interface FakeDiscordOptions {
  /** What GET_VOICE_SETTINGS answers with, and what SET_ changes. */
  readonly voice?: VoiceSettings;
  /** The channel the person is in, or nothing at all. */
  readonly channel?: FakeChannel;
  /** Commands to refuse, by name, with Discord's own error shape. */
  readonly refuse?: Readonly<Record<string, string>>;
}

export interface VoiceSettings {
  mute?: boolean;
  deaf?: boolean;
  input?: { volume?: number };
  output?: { volume?: number };
}

export interface FakeChannel {
  readonly id: string;
  readonly name: string;
  readonly voice_states: {
    readonly user: { id: string; username?: string; global_name?: string };
    readonly nick?: string;
  }[];
}

export class FakeDiscord {
  private readonly server: Server;
  private readonly open = new Set<Socket>();
  readonly path: string;

  /** Every command received, in order, for a test to assert against. */
  readonly commands: { cmd: string; args: Record<string, unknown> }[] = [];

  voice: VoiceSettings;
  channel?: FakeChannel;

  constructor(private readonly options: FakeDiscordOptions = {}) {
    this.voice = options.voice ?? { mute: false, deaf: false, input: { volume: 100 }, output: { volume: 100 } };
    if (options.channel) this.channel = options.channel;

    this.path =
      process.platform === 'win32'
        ? `\\\\?\\pipe\\easydeck-fake-discord-${randomUUID()}`
        : join(tmpdir(), `easydeck-fake-discord-${randomUUID()}`);

    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<string> {
    await new Promise<void>((ready) => this.server.listen(this.path, ready));
    return this.path;
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  /** Sends an event nobody asked for, the way the real client does. */
  emit(event: string, data: Record<string, unknown>): void {
    for (const socket of this.open) write(socket, OP_FRAME, { cmd: 'DISPATCH', evt: event, data });
  }

  private accept(socket: Socket): void {
    this.open.add(socket);
    socket.on('close', () => this.open.delete(socket));

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (buffer.byteLength < 8) return;
        const opcode = buffer.readInt32LE(0);
        const length = buffer.readInt32LE(4);
        if (buffer.byteLength < 8 + length) return;

        const body = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);

        const message = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        this.onMessage(socket, opcode, message);
      }
    });
  }

  private onMessage(socket: Socket, opcode: number, message: Record<string, unknown>): void {
    if (opcode === OP_HANDSHAKE) {
      // Answered with an event rather than a response, and with no nonce —
      // which is the one thing about this protocol worth getting wrong once.
      write(socket, OP_FRAME, {
        cmd: 'DISPATCH',
        evt: 'READY',
        data: { v: 1, user: { id: 'me', username: 'tester' } },
      });
      return;
    }

    const cmd = String(message['cmd'] ?? '');
    const nonce = String(message['nonce'] ?? '');
    const args = (message['args'] as Record<string, unknown> | undefined) ?? {};

    if (cmd !== 'SUBSCRIBE' && cmd !== 'UNSUBSCRIBE') this.commands.push({ cmd, args });

    const refusal = this.options.refuse?.[cmd];
    if (refusal) {
      write(socket, OP_FRAME, {
        cmd,
        nonce,
        evt: 'ERROR',
        data: { code: 4006, message: refusal },
      });
      return;
    }

    write(socket, OP_FRAME, { cmd, nonce, data: this.answer(cmd, args) });
  }

  private answer(cmd: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (cmd) {
      case 'AUTHENTICATE':
        return { user: { id: 'me', username: 'tester', global_name: 'Тестер' } };

      case 'AUTHORIZE':
        return { code: 'one-time-code' };

      case 'GET_VOICE_SETTINGS':
        return { ...this.voice };

      case 'SET_VOICE_SETTINGS': {
        // The real client applies what it was given and answers with the whole
        // of the settings afterwards.
        this.voice = {
          ...this.voice,
          ...args,
          input: { ...this.voice.input, ...((args['input'] as object) ?? {}) },
          output: { ...this.voice.output, ...((args['output'] as object) ?? {}) },
        };
        // Deafening mutes, which the plugin publishes without waiting.
        if (args['deaf'] === true) this.voice.mute = true;
        return { ...this.voice };
      }

      case 'GET_SELECTED_VOICE_CHANNEL':
        return this.channel ? { ...this.channel } : {};

      case 'SELECT_VOICE_CHANNEL':
        return this.channel ? { ...this.channel } : {};

      case 'GET_GUILDS':
        return { guilds: [{ id: 'g1', name: 'Дом' }] };

      case 'GET_CHANNELS':
        return {
          channels: [
            { id: 'c-voice', name: 'Общий', type: 2 },
            { id: 'c-text', name: 'болталка', type: 0 },
          ],
        };

      default:
        return {};
    }
  }
}

function write(socket: Socket, opcode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.byteLength, 4);
  socket.write(Buffer.concat([header, body]));
}

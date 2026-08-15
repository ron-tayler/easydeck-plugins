import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

/**
 * A speaker, for tests that must not depend on one being plugged in.
 *
 * Answers the way the real thing does and in the same order: a state the
 * moment the socket opens, a fresh one after every command, and — for a token
 * it does not recognise — close code 4000 with `Invalid token`, which is the
 * one piece of protocol that is easy to get wrong and impossible to notice.
 *
 * Plain rather than TLS. The real speaker's certificate is self-signed and
 * verified by nobody, so encryption here would test the socket library rather
 * than this plugin; `GlagolConnection` takes `secure: false` for exactly this.
 */

/** Everything the speaker says about itself, in the shape it says it. */
export interface FakeState {
  aliceState?: string;
  playing?: boolean;
  volume?: number;
  playerState?: Record<string, unknown>;
}

export interface FakeStationOptions {
  readonly token?: string;
  readonly state?: FakeState;
  /**
   * How long the speaker takes to mention that something changed.
   *
   * Zero here and about a second in the flat, because the real one reports on
   * a beat of its own rather than answering. A test about what a key shows
   * *before* the speaker has spoken needs that gap to exist.
   */
  readonly lagMs?: number;
}

const DEFAULT_TOKEN = 'device-token';

export class FakeStation {
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly open = new Set<WebSocket>();

  /** Every command received, in order, for a test to assert against. */
  readonly commands: Record<string, unknown>[] = [];

  private state: FakeState;

  constructor(private readonly options: FakeStationOptions = {}) {
    this.state = options.state ?? { aliceState: 'IDLE', playing: false, volume: 0.5 };

    this.server = createServer();
    this.server.on('upgrade', (request, socket, head) => {
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((ready) => this.server.listen(0, '127.0.0.1', ready));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.terminate();
    this.open.clear();
    this.sockets.close();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  /** Changes what the speaker reports and tells everyone listening. */
  publish(state: FakeState): void {
    this.state = state;
    for (const socket of this.open) this.announce(socket);
  }

  private accept(socket: WebSocket): void {
    this.open.add(socket);
    socket.on('close', () => this.open.delete(socket));

    socket.on('message', (raw) => {
      let message: { conversationToken?: string; payload?: Record<string, unknown> };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }

      if (message.conversationToken !== (this.options.token ?? DEFAULT_TOKEN)) {
        // Exactly what a real speaker does, down to the code: no error
        // message, no reply, just a close nobody asked for.
        socket.close(4000, 'Invalid token');
        return;
      }

      if (message.payload) {
        this.commands.push(message.payload);
        this.apply(message.payload);
      }

      const lag = this.options.lagMs ?? 0;
      if (lag === 0) this.announce(socket);
      else setTimeout(() => this.announce(socket), lag).unref?.();
    });

    // The real thing volunteers its state as soon as the socket is up, before
    // anything has been asked of it.
    this.announce(socket);
  }

  /**
   * Does what it was told, for the commands that plainly change the state.
   *
   * Only these three: everything else a real speaker answers by consulting a
   * cloud this cannot stand in for, and a fake that pretended otherwise would
   * be teaching tests something untrue.
   */
  private apply(payload: Record<string, unknown>): void {
    switch (payload['command']) {
      case 'play':
        this.state = { ...this.state, playing: true };
        return;
      case 'stop':
        this.state = { ...this.state, playing: false };
        return;
      case 'setVolume':
        this.state = { ...this.state, volume: Number(payload['volume']) };
        return;
      default:
        return;
    }
  }

  private announce(socket: WebSocket): void {
    socket.send(
      JSON.stringify({
        id: 'fake',
        sentTime: 0,
        status: 'ok',
        // Sent because the real one sends them, and because a reader that
        // mistook this envelope for the state would pass a test without them.
        experiments: {},
        supported_features: ['absolute_volume_change'],
        state: this.state,
      }),
    );
  }
}

/** What a speaker with music on it reports, cover and all. */
export function playingState(): FakeState {
  return {
    aliceState: 'IDLE',
    playing: true,
    volume: 0.4,
    playerState: {
      title: 'TAKE ME',
      subtitle: 'D A N N Y',
      duration: 129,
      progress: 16,
      hasNext: true,
      hasPrev: true,
      hasPause: true,
      hasPlay: false,
      id: '151597596',
      playlistType: 'Playlist',
      entityInfo: { type: 'Playlist', repeatMode: 'None', shuffled: true },
      extra: { coverURI: 'avatars.example/cover/%%', stateType: 'music' },
    },
  };
}

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

/**
 * An OBS that is not OBS, for the tests.
 *
 * Speaks the handshake, the request/response pair and the event stream, and
 * nothing else. Written rather than mocked because the parts worth testing —
 * the challenge-response, an id matched to its answer, a reconnection after
 * the far end vanishes — only exist on a real socket. A fake connection object
 * would agree with any client at all, including one that never authenticates.
 *
 * Not a test file itself, so it compiles but never runs on its own.
 */

/** The requests a real OBS turns down for a source that carries no audio. */
const AUDIO_REQUESTS = new Set([
  'GetInputAudioTracks',
  'GetInputMute',
  'SetInputMute',
  'ToggleInputMute',
  'GetInputVolume',
  'SetInputVolume',
  'GetInputAudioMonitorType',
  'SetInputAudioMonitorType',
]);

export interface FakeObsOptions {
  /** Absent means the server does not ask for one. */
  readonly password?: string;
  /** Answers by request type; anything unlisted is refused. */
  readonly responses?: Record<string, Record<string, unknown>>;
}

export class FakeObs {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  /** Every request that arrived, in order, for assertions. */
  readonly requests: Array<{ type: string; data: Record<string, unknown> }> = [];
  /**
   * Names this OBS refuses to know anything about.
   *
   * What a real one does for a source that has been renamed or deleted since
   * a profile mentioned it — the request is answered, and the answer is no.
   */
  readonly unknown = new Set<string>();
  /**
   * Inputs with no sound in them: an image, a colour, a text.
   *
   * A real OBS refuses the audio requests for these rather than answering
   * about silence, which is the only way to tell from the outside that a
   * source is not something to mute.
   */
  readonly silent = new Set<string>();
  private challenge = '';
  private closed = false;

  constructor(private readonly options: FakeObsOptions = {}) {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });

    this.wss.on('connection', (socket) => {
      if (this.closed) {
        socket.terminate();
        return;
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (raw) => this.receive(socket, String(raw)));

      this.challenge = `challenge-${this.sockets.size}`;
      socket.send(
        JSON.stringify({
          op: 0,
          d: {
            obsWebSocketVersion: '5.5.0',
            rpcVersion: 1,
            ...(options.password === undefined
              ? {}
              : { authentication: { challenge: this.challenge, salt: 'salt' } }),
          },
        }),
      );
    });
  }

  /** Starts on a free port and reports which one. */
  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    const address = this.http.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    return address.port;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();

    // `closeAllConnections` covers what upgrade left behind: an upgraded
    // socket is no longer the HTTP server's to close, and without this the
    // server waits for it forever.
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Drops every connection without shutting down: what a restart looks like. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  emit(eventType: string, eventData: Record<string, unknown>): void {
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventData } }));
    }
  }

  private receive(socket: WebSocket, raw: string): void {
    const message = JSON.parse(raw) as { op?: number; d?: Record<string, unknown> };
    const data = message.d ?? {};

    if (message.op === 1) {
      if (this.options.password !== undefined) {
        const secret = sha256(`${this.options.password}salt`);
        const expected = sha256(`${secret}${this.challenge}`);

        if (data['authentication'] !== expected) {
          socket.close(4009, 'Authentication failed');
          return;
        }
      }
      socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      return;
    }

    if (message.op === 6) {
      const type = String(data['requestType'] ?? '');
      this.requests.push({
        type,
        data: (data['requestData'] as Record<string, unknown>) ?? {},
      });

      const named = Object.values((data['requestData'] as Record<string, unknown>) ?? {}).map(String);
      const refused =
        named.some((value) => this.unknown.has(value)) ||
        (AUDIO_REQUESTS.has(type) && named.some((value) => this.silent.has(value)));
      const responseData = refused ? undefined : this.options.responses?.[type];
      socket.send(
        JSON.stringify({
          op: 7,
          d: {
            requestType: type,
            requestId: data['requestId'],
            requestStatus:
              responseData === undefined
                ? { result: false, code: 204, comment: `No such request '${type}' here` }
                : { result: true, code: 100 },
            ...(responseData ? { responseData } : {}),
          },
        }),
      );
    }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

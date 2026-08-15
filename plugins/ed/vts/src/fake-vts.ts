import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

/**
 * A VTube Studio that is not VTube Studio, for the tests.
 *
 * Speaks the envelope, the token dance and the event stream, and nothing else.
 * Written rather than mocked because the parts worth testing — a token granted
 * and reused, an id matched to its answer, a reconnection after the far end
 * vanishes — only exist on a real socket.
 *
 * Not a test file itself, so it compiles but never runs on its own.
 */

export interface FakeVtsOptions {
  /** What the token request grants. Absent means it refuses, as a user can. */
  readonly token?: string;
  /** Answers by message type; anything unlisted comes back as an APIError. */
  readonly responses?: Record<string, Record<string, unknown>>;
}

export class FakeVts {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  /** Every request that arrived, in order, for assertions. */
  readonly requests: Array<{ type: string; data: Record<string, unknown> }> = [];
  /** Tokens this VTube Studio considers valid, as a real one remembers them. */
  readonly issued = new Set<string>();
  /** Held rather than answered, so a test can watch what waiting looks like. */
  withheld = new Set<string>();
  private closed = false;

  constructor(private readonly options: FakeVtsOptions = {}) {
    // Known from the start, the way a real one remembers a token it granted in
    // an earlier session — which is the whole point of storing it.
    if (options.token !== undefined) this.issued.add(options.token);

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
      // No greeting: VTube Studio says nothing until it is asked something.
    });
  }

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

    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Drops every connection without shutting down: what a restart looks like. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  /** An event, carrying the subscription's id exactly as the real one does. */
  emit(messageType: string, data: Record<string, unknown>): void {
    for (const socket of this.sockets) {
      socket.send(
        JSON.stringify({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          requestID: 'subscription',
          messageType,
          data,
        }),
      );
    }
  }

  private receive(socket: WebSocket, raw: string): void {
    const message = JSON.parse(raw) as {
      requestID?: string;
      messageType?: string;
      data?: Record<string, unknown>;
    };

    const type = String(message.messageType ?? '');
    const data = message.data ?? {};
    this.requests.push({ type, data });

    if (this.withheld.has(type)) return;

    const answer = (messageType: string, payload: Record<string, unknown>) =>
      socket.send(
        JSON.stringify({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          timestamp: 0,
          requestID: message.requestID,
          messageType,
          data: payload,
        }),
      );

    const refuse = (errorID: number, text: string) => answer('APIError', { errorID, message: text });

    switch (type) {
      case 'AuthenticationTokenRequest': {
        if (this.options.token === undefined) {
          // Error 50 is what a real one sends when the user presses Deny.
          refuse(50, 'User has denied API access for your plugin.');
          return;
        }
        this.issued.add(this.options.token);
        answer('AuthenticationTokenResponse', { authenticationToken: this.options.token });
        return;
      }

      case 'AuthenticationRequest': {
        const token = String(data['authenticationToken'] ?? '');
        const ok = this.issued.has(token);
        answer('AuthenticationResponse', {
          authenticated: ok,
          reason: ok ? 'Token valid.' : 'Token is invalid.',
        });
        return;
      }

      case 'EventSubscriptionRequest':
        answer('EventSubscriptionResponse', { subscribedEvents: [String(data['eventName'] ?? '')] });
        return;

      default: {
        const response = this.options.responses?.[type];
        if (response === undefined) {
          refuse(100, `No such request '${type}' here`);
          return;
        }
        answer(`${type.replace(/Request$/, '')}Response`, response);
      }
    }
  }
}

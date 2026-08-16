import type { DiscordIpc } from './discord-ipc.js';
import { AUTHORIZE_TIMEOUT_MS } from './discord-ipc.js';

/**
 * Getting far enough into somebody's Discord to mute their microphone.
 *
 * Three steps, and the middle one is the reason this file exists:
 *
 * 1. `AUTHORIZE` over the pipe — Discord shows the person a dialog naming the
 *    application and the scopes, and answers with a one-time code.
 * 2. That code is exchanged for an access token over HTTPS, and *that*
 *    requires the application's secret — which is why the plugin asks for one.
 * 3. `AUTHENTICATE` hands the token back over the pipe, and the connection is
 *    allowed to do things.
 *
 * **Why each person registers their own application.** Discord says plainly:
 * "We currently do not allow access to RPC for unapproved apps without being
 * on the game's list of testers". An application the plugin shipped would
 * work for its author and for fifty invited testers, and for nobody else,
 * until Discord approved it. An application somebody made themselves has them
 * as its owner, and an owner is always allowed — so the plugin asks for two
 * fields once instead of asking everybody to wait for an approval that may
 * never come.
 *
 * The token is kept, so this happens once rather than at every start.
 */

/** What the plugin asks for, and what the dialog will list. */
export const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'] as const;

/**
 * Where Discord is told to send the code back to.
 *
 * Nothing listens there and nothing needs to: over the pipe the code comes
 * back through the pipe. It is sent because the exchange refuses without one
 * and it must match what the application has registered — which is why the
 * plugin says to put exactly this in the portal.
 */
export const REDIRECT_URI = 'http://localhost';

const TOKEN_URL = 'https://discord.com/api/oauth2/token';

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Asks the person, in Discord's own window, and comes back with a token.
 *
 * Only ever called from the button in the plugin's settings: an authorisation
 * dialog thrown in front of somebody who is live, because a socket happened
 * to reconnect, is the thing this must never do.
 */
export async function authorize(
  ipc: DiscordIpc,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const granted = await ipc.command<{ code?: string }>(
    'AUTHORIZE',
    { client_id: credentials.clientId, scopes: [...SCOPES] },
    AUTHORIZE_TIMEOUT_MS,
  );

  if (!granted.code) throw new Error('Discord gave no code — the dialog was refused or timed out');

  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'authorization_code',
      code: granted.code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const token = (await response.json()) as { access_token?: string; error_description?: string; error?: string };

  if (!token.access_token) {
    // Discord's own words where it gave any: "invalid_grant" alone is a
    // riddle, and "Invalid redirect_uri" tells somebody exactly what to fix.
    throw new Error(
      token.error_description ?? token.error ?? 'Discord would not exchange the code for a token',
    );
  }

  return token.access_token;
}

/** Hands a token back over the pipe. Cheap, and done on every connect. */
export async function authenticate(ipc: DiscordIpc, accessToken: string): Promise<AuthenticatedAs> {
  const result = await ipc.command<{ user?: { id?: string; username?: string; global_name?: string } }>(
    'AUTHENTICATE',
    { access_token: accessToken },
  );

  return {
    userId: String(result.user?.id ?? ''),
    // `global_name` is the display name Discord moved to; `username` is what
    // is left for accounts that never took one.
    name: String(result.user?.global_name ?? result.user?.username ?? ''),
  };
}

export interface AuthenticatedAs {
  readonly userId: string;
  readonly name: string;
}

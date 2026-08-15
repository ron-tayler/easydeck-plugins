/**
 * Getting far enough into a Yandex account to talk to its speakers.
 *
 * Four keys, each opening a different door, and they are not interchangeable:
 *
 * - **x-token** — the account itself, granted once by confirming a link on a
 *   phone. Lasts about a year. Everything below is made from it.
 * - **music token** — made from the x-token with one request. The only thing
 *   `glagol/token` accepts, and the only key the local protocol needs.
 * - **device token** — one per speaker, from `glagol/token`. This is what the
 *   speaker's own socket checks.
 * - **cookies** — made from the x-token, and needed by nothing except the
 *   smart-home API, which is where the names of rooms live.
 *
 * None of this is documented by Yandex. It is what the app does, worked out by
 * the Home Assistant integration (`AlexxIT/YandexStation`) and confirmed here
 * against real speakers.
 *
 * No password is ever asked for, seen or stored. The one thing that reaches
 * this program is a token, and it is handed over by a phone the user is
 * already holding.
 */
import { randomUUID } from 'node:crypto';

/** The Yandex app's own client, which is what makes a token an *x*-token. */
const PASSPORT_CLIENT = {
  id: 'c0ebe342af7d48fbbbfcf2d2eedb8f9e',
  secret: 'ad0a908f0aa341a182a37ecd75bc319e',
};

/** Yandex Music's client. Its token is the one `glagol/token` recognises. */
const MUSIC_CLIENT = {
  id: '23cabbbdc6cd418abb4b39c32c41195d',
  secret: '53bc75238f0c4d08a118e51fe9203300',
};

/**
 * What this program calls itself to Yandex.
 *
 * Sent where the account will store it, so the entry under "your devices" says
 * EasyDeck rather than nothing. What the *phone* shows while confirming a
 * sign-in is Yandex's own wording and is derived from the request that started
 * it — this is the only handle on it there is.
 */
const DEVICE_NAME = 'EasyDeck';

/**
 * Passport answers a bare fetch with a page that asks for JavaScript.
 *
 * Not an attempt to look like a browser to something that would refuse us —
 * the account is the user's own and the flow is the one their phone confirms.
 * It is that the endpoint serves a different page to a client with no
 * user agent at all.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** How long a person has to reach for their phone before this gives up. */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_EVERY_MS = 3000;

/** A speaker as the account describes it, which is how a person recognises it. */
export interface CloudSpeaker {
  readonly deviceId: string;
  readonly platform: string;
  readonly name: string;
  readonly room?: string;
  readonly house?: string;
  /**
   * Whether this is a speaker at all.
   *
   * The device list answers with everything the account has ever spoken to:
   * the smart-home hub, the TV module, and one entry per phone that has the
   * Yandex app or Yandex Maps on it. Only the smart-home API distinguishes
   * them, and `undefined` means it could not be asked — see `cloudSpeakers`.
   */
  readonly isSpeaker?: boolean;
}

/**
 * A sign-in waiting to be confirmed.
 *
 * Split in two because the two halves happen at different times and in
 * different places: the link has to reach the user before anything can be
 * waited for.
 */
export interface PendingLogin {
  /** Open on a phone, or scan it. Confirming it is the whole authentication. */
  readonly link: string;
  /** Resolves with the x-token once confirmed; rejects if nobody does. */
  confirm(): Promise<string>;
}

// --- signing in ----------------------------------------------------------

/**
 * Starts the sign-in and hands back the link to confirm.
 *
 * The cookie jar lives inside this call: passport hands out several cookies
 * across two hosts on the way through, and they matter only until the x-token
 * is in hand.
 */
export async function beginLogin(fetcher: Fetcher = fetch): Promise<PendingLogin> {
  const http = new Session(fetcher);

  const page = await http.text('https://passport.yandex.ru/pwl-yandex');
  const csrf = /__CSRF__ = "([^"]+)/.exec(page)?.[1];
  if (!csrf) throw new Error('Yandex changed its sign-in page: no CSRF token in it');

  const headers = { 'X-CSRF-Token': csrf };

  const track = await http.json<{ track_id?: string }>(
    'https://passport.yandex.ru/pwl-yandex/api/passport/auth/password/submit',
    { method: 'POST', headers, json: { retpath: 'https://passport.yandex.ru/' } },
  );
  if (!track.track_id) throw new Error('Yandex refused to start a sign-in');

  const magic = await http.json<{ link?: string }>(
    'https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code',
    {
      method: 'POST',
      headers,
      form: { location_id: '0', magic_track_id: track.track_id, track_id: '' },
    },
  );
  if (!magic.link) throw new Error('Yandex did not hand out a confirmation link');

  return {
    link: magic.link,
    confirm: async () => {
      const until = Date.now() + CONFIRM_TIMEOUT_MS;
      let confirmed: { trackId?: string } | undefined;

      while (Date.now() < until) {
        await new Promise((wait) => setTimeout(wait, POLL_EVERY_MS));

        const status = await http.json<{ state?: string; trackId?: string }>(
          'https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code/status',
          { method: 'POST', headers, json: track },
        );

        if (status.state === 'otp_auth_finished') {
          confirmed = status;
          break;
        }
      }

      if (!confirmed?.trackId) throw new Error('Nobody confirmed the sign-in');

      // Turns the confirmed track into session cookies, which is what the
      // exchange below reads. Its own answer is of no interest.
      await http.json('https://passport.yandex.ru/pwl-yandex/api/passport/sessions/get_session', {
        method: 'POST',
        headers,
        form: { track_id: confirmed.trackId },
      });

      const oauth = await http.json<{ access_token?: string }>(
        'https://mobileproxy.passport.yandex.net/1/bundle/oauth/token_by_sessionid',
        {
          method: 'POST',
          headers: { 'Ya-Client-Host': 'passport.yandex.ru', 'Ya-Client-Cookie': http.cookies() },
          form: {
            client_id: PASSPORT_CLIENT.id,
            client_secret: PASSPORT_CLIENT.secret,
            /*
             * What the account calls this token afterwards.
             *
             * Without them the entry in "your devices" is a nameless client
             * somebody has to guess at months later, when the only sensible
             * thing to do with an entry you cannot identify is revoke it. The
             * id is fresh each sign-in rather than stored, which costs a
             * duplicate entry if somebody signs in twice and saves keeping a
             * machine identifier on disk.
             */
            device_id: randomUUID(),
            device_name: DEVICE_NAME,
          },
        },
      );

      if (!oauth.access_token) throw new Error('Yandex confirmed the sign-in but gave no token');
      return oauth.access_token;
    },
  };
}

/** Which account this token belongs to, for a settings window to show. */
export async function accountName(xToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const info = await new Session(fetcher).json<{ display_login?: string; display_name?: string }>(
    'https://mobileproxy.passport.yandex.net/1/bundle/account/short_info/?avatar_size=islands-300',
    { headers: { Authorization: `OAuth ${xToken}` } },
  );

  return info.display_login ?? info.display_name ?? '';
}

// --- the keys the speakers want -----------------------------------------

/** The music token, which is the only key `glagol/token` will look at. */
export async function musicToken(xToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const answer = await new Session(fetcher).json<{ access_token?: string }>(
    'https://oauth.mobile.yandex.net/1/token',
    {
      method: 'POST',
      form: {
        client_id: MUSIC_CLIENT.id,
        client_secret: MUSIC_CLIENT.secret,
        grant_type: 'x-token',
        access_token: xToken,
      },
    },
  );

  if (!answer.access_token) throw new Error('Yandex would not grant a music token');
  return answer.access_token;
}

/**
 * The token one speaker's own socket checks.
 *
 * Worth keeping once it is granted: it does not expire on its own, and this
 * endpoint answers 429 to anyone who asks too often. A plugin that fetched
 * these on every start would lock itself out of its own speakers.
 */
export async function deviceToken(
  music: string,
  deviceId: string,
  platform: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const answer = await new Session(fetcher).json<{ status?: string; token?: string; message?: string }>(
    `https://quasar.yandex.net/glagol/token?device_id=${encodeURIComponent(deviceId)}&platform=${encodeURIComponent(platform)}`,
    { headers: { Authorization: `OAuth ${music}` } },
  );

  if (answer.status !== 'ok' || !answer.token) {
    // The everyday case is a speaker on the network that belongs to somebody
    // else — a flatmate's, a neighbour's — and saying so plainly is better
    // than a failure to connect ten seconds later.
    throw new Error(answer.message ?? 'Yandex would not grant a token for this speaker');
  }

  return answer.token;
}

// --- what a person calls them -------------------------------------------

/**
 * The speakers of this account, named, and placed in their rooms.
 *
 * Two requests to two different APIs because no single one answers both. The
 * names come with the music token alone; the rooms need cookies, which cost
 * two more requests, and are worth it — "Кабинет · Яндекс станция" is a
 * choice somebody can make, and `yandexmini_2 M00K2R300K5PKR` is not.
 *
 * The rooms are allowed to fail on their own: a plugin that could not read the
 * smart-home API still knows the names, and a list of names beats no list.
 */
export async function cloudSpeakers(
  xToken: string,
  music: string,
  fetcher: Fetcher = fetch,
): Promise<CloudSpeaker[]> {
  const named = await new Session(fetcher).json<{
    devices?: { id?: string; platform?: string; name?: string }[];
  }>('https://quasar.yandex.net/glagol/device_list', {
    headers: { Authorization: `OAuth ${music}` },
  });

  const speakers = new Map<string, CloudSpeaker>();
  for (const device of named.devices ?? []) {
    if (!device.id || !device.platform) continue;
    speakers.set(device.id, {
      deviceId: device.id,
      platform: device.platform,
      name: device.name?.trim() || device.id,
    });
  }

  let known: Map<string, CloudDeviceInfo>;
  try {
    known = await smartHomeDevices(xToken, fetcher);
  } catch {
    // Without the smart-home API there is no way to tell a speaker from a
    // phone, and `isSpeaker` is left unanswered rather than guessed at: the
    // caller knows something this does not — which of them answered on the
    // network — and can decide on that instead.
    return [...speakers.values()];
  }

  return [...speakers.values()].map((speaker) => {
    const where = known.get(`${speaker.deviceId}.${speaker.platform}`);
    return where
      ? { ...speaker, room: where.room, house: where.house, isSpeaker: where.isSpeaker }
      : { ...speaker, isSpeaker: false };
  });
}

/** What kind of thing each device is, and where it stands. */
interface CloudDeviceInfo {
  readonly room: string;
  readonly house: string;
  readonly isSpeaker: boolean;
}

/**
 * Everything the smart home knows about the account's devices.
 *
 * Keyed by `external_id`, which is exactly `<deviceId>.<platform>` — the two
 * fields mDNS already hands over. So the local list and the cloud list join on
 * a string match rather than on a guess about names or addresses.
 */
async function smartHomeDevices(
  xToken: string,
  fetcher: Fetcher,
): Promise<Map<string, CloudDeviceInfo>> {
  const http = new Session(fetcher);

  const auth = await http.json<{ status?: string; passport_host?: string; track_id?: string }>(
    'https://mobileproxy.passport.yandex.net/1/bundle/auth/x_token/',
    {
      method: 'POST',
      headers: { 'Ya-Consumer-Authorization': `OAuth ${xToken}` },
      form: { type: 'x-token', retpath: 'https://www.yandex.ru' },
    },
  );
  if (auth.status !== 'ok' || !auth.passport_host) throw new Error('Could not open a session');

  // Sets the cookies the smart-home API reads. Answers with a redirect, which
  // is why nothing here follows one.
  await http.text(`${auth.passport_host}/auth/session/?track_id=${auth.track_id}`);

  const iot = await http.json<{
    status?: string;
    households?: { name?: string; all?: CloudDevice[] }[];
  }>('https://iot.quasar.yandex.ru/m/v3/user/devices');

  if (iot.status !== 'ok') throw new Error('The smart-home API would not answer');

  const devices = new Map<string, CloudDeviceInfo>();
  for (const household of iot.households ?? []) {
    for (const device of household.all ?? []) {
      if (!device.external_id) continue;
      devices.set(device.external_id, {
        room: device.room_name ?? '',
        house: household.name ?? '',
        // Everything else in this list is a hub, a TV module, a lamp, or a
        // phone with the Yandex app on it. None of them speaks Glagol.
        isSpeaker: (device.type ?? '').startsWith(SPEAKER_TYPE),
      });
    }
  }

  return devices;
}

/** What the smart home calls a speaker: `devices.types.smart_speaker.yandex.station.micro`. */
const SPEAKER_TYPE = 'devices.types.smart_speaker';

interface CloudDevice {
  readonly external_id?: string;
  readonly room_name?: string;
  readonly type?: string;
}

// --- plumbing ------------------------------------------------------------

export type Fetcher = typeof fetch;

interface Options {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly form?: Record<string, string>;
}

/**
 * A handful of requests that remember their cookies.
 *
 * Written out rather than pulled in: what is needed is one `Map`, and a cookie
 * jar that understands domains, paths and expiry would be answering questions
 * this flow never asks. Every request here is to a Yandex host, in one
 * sequence, over a few seconds.
 */
class Session {
  private readonly jar = new Map<string, string>();

  constructor(private readonly fetcher: Fetcher) {}

  cookies(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async json<T>(url: string, options: Options = {}): Promise<T> {
    const response = await this.send(url, options);
    const body = await response.text();

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Yandex answered ${response.status} with something that is not JSON`);
    }
  }

  async text(url: string, options: Options = {}): Promise<string> {
    return (await this.send(url, options)).text();
  }

  private async send(url: string, options: Options): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      ...(this.jar.size > 0 ? { Cookie: this.cookies() } : {}),
      ...options.headers,
    };

    let body: string | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }

    const response = await this.fetcher(url, {
      method: options.method ?? 'GET',
      headers,
      // Manual, because one step of the sign-in *is* a redirect: following it
      // would drop the cookies it was sent to set.
      redirect: 'manual',
      ...(body !== undefined ? { body } : {}),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';', 1)[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) this.jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }

    return response;
  }
}

/**
 * Faces, fetched once and kept.
 *
 * Discord hands out a hash rather than a picture, so an avatar is an address
 * to be built and then downloaded — from a CDN, over the internet, which is
 * the one thing in this plugin that does not go down the pipe. Everything
 * else here is local, and this is the part that must therefore never be on
 * the path of a key press or of drawing a frame.
 *
 * So it is a cache with a doorbell: asking for a face answers with what is
 * held, and if nothing is held it starts a download and rings back when it
 * lands. Nothing waits.
 */

/**
 * How big a face is asked for.
 *
 * A key is 112 pixels and a widget spanning two is 224, so 256 is the size
 * that never has to be scaled up. The CDN resizes for us, and asking for the
 * original would fetch a 1024-pixel picture to draw a quarter of a key with.
 */
const SIZE = 256;

/** As much of a Discord user as an address needs. */
export interface AvatarOwner {
  readonly id?: string;
  readonly avatar?: string | null;
  readonly discriminator?: string;
}

/**
 * Where somebody's face lives.
 *
 * Two schemes, because Discord has two. A person with an avatar has a hash,
 * and the address is built from it. A person without one gets a coloured
 * default, chosen by their discriminator on the old accounts and by their id
 * on the new ones — where the discriminator is gone and reads as `0`.
 */
export function avatarAddress(user: AvatarOwner): string {
  const id = String(user.id ?? '');
  if (id === '') return '';

  if (user.avatar) {
    // `.png` even for an animated hash, which the CDN answers with the still
    // frame. A key redrawn on speech has no use for an animation it would
    // have to drive itself.
    return `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=${SIZE}`;
  }

  const legacy = Number(user.discriminator ?? '0');
  if (Number.isFinite(legacy) && legacy > 0) {
    return `https://cdn.discordapp.com/embed/avatars/${legacy % 5}.png`;
  }

  /*
   * The new scheme, and the only place a snowflake is taken apart here.
   *
   * The top bits of an id are a timestamp, and Discord picks the default from
   * them. Big integers because an id does not fit in a double — and guarded,
   * because this runs while the room is being read: an id that is not a number
   * would otherwise throw there and lose the whole list of who is in the call.
   */
  const index = /^\d+$/.test(id) ? Number((BigInt(id) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** What a fetch that failed leaves behind, so it is not tried again in a loop. */
const MISSING = 'missing';

export interface AvatarsOptions {
  /** Overridden by tests, which must not reach a CDN. */
  readonly fetcher?: typeof fetch;
  /** Called when a face has arrived and the key wants redrawing. */
  readonly onArrived?: () => void;
  readonly log?: (message: string) => void;
}

export class Avatars {
  private readonly held = new Map<string, string>();
  private readonly fetching = new Set<string>();

  constructor(private readonly options: AvatarsOptions = {}) {}

  /**
   * The picture at an address, if it is here.
   *
   * Starts fetching it when it is not, and answers nothing meanwhile — the
   * caller draws a stand-in and is called back to draw it again properly.
   */
  picture(address: string): string | undefined {
    if (address === '') return undefined;

    const kept = this.held.get(address);
    if (kept !== undefined) return kept === MISSING ? undefined : kept;

    void this.fetch(address);
    return undefined;
  }

  /**
   * Forgets a face that failed, so a key is not blank for ever.
   *
   * Called when the connection comes back: the common reason a fetch failed is
   * that the machine was not on the network yet, and that is exactly the state
   * a reconnect ends.
   */
  forgetFailures(): void {
    for (const [address, picture] of this.held) {
      if (picture === MISSING) this.held.delete(address);
    }
  }

  private async fetch(address: string): Promise<void> {
    if (this.fetching.has(address)) return;
    this.fetching.add(address);

    try {
      const get = this.options.fetcher ?? fetch;
      const response = await get(address);
      if (!response.ok) throw new Error(`avatar ${response.status}`);

      const bytes = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get('content-type') ?? 'image/png';

      this.held.set(address, `data:${type};base64,${bytes.toString('base64')}`);
      this.options.onArrived?.();
    } catch (cause) {
      // Remembered as missing rather than left unknown: unknown means "ask
      // again", and a CDN that is not answering would then be asked on every
      // repaint for as long as somebody is talking.
      this.held.set(address, MISSING);
      this.options.log?.(`Could not fetch an avatar: ${(cause as Error).message}`);
    } finally {
      this.fetching.delete(address);
    }
  }
}

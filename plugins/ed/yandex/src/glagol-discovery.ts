import { networkInterfaces } from 'node:os';

import { Bonjour } from 'bonjour-service';

/**
 * Which Yandex speakers are on this network.
 *
 * They announce themselves over mDNS as `_yandexio._tcp`, carrying the two
 * things needed to talk to one: the id the cloud knows it by and the platform
 * name that goes with it. Everything else — what it is called, which room it
 * stands in — is the cloud's to say; see yandex-account.ts.
 *
 * **One browser per interface, and that is the whole reason this file is not
 * three lines.** Multicast leaves by one adapter, and the default choice is
 * whichever the operating system lists first. On the machine this was written
 * on that was a VPN tunnel, and the answer was not "no speakers" but silence:
 * no speakers, no router, no printer, nothing at all. A person with a VPN, a
 * WSL install or Hyper-V — which is to say most people this program is for —
 * would have been told their speakers do not exist.
 */

export interface DiscoveredSpeaker {
  /** As the cloud knows it: `M00K2R300K5PKR`. */
  readonly deviceId: string;
  /** `yandexmini_2`, `yandexmicro`, `yandexmodule_2`. */
  readonly platform: string;
  readonly host: string;
  readonly port: number;
}

export interface DiscoveryOptions {
  /**
   * How long to listen.
   *
   * A speaker answers a query in well under a second; the rest of the wait is
   * for the one that is busy or on the far side of a mesh node.
   */
  readonly forMs?: number;
  /** Overridden by tests, which have no network to look at. */
  readonly browse?: BrowseFunction;
}

/** Listens on one interface and reports what turns up. See `browseWithBonjour`. */
export type BrowseFunction = (
  address: string,
  found: (speaker: DiscoveredSpeaker) => void,
) => () => void;

const DEFAULT_FOR_MS = 4000;

/**
 * Every speaker visible from any of this machine's addresses.
 *
 * Deduplicated by device id: a speaker reachable from two interfaces is one
 * speaker, and the first address to answer is as good as the second.
 */
export async function discoverSpeakers(
  options: DiscoveryOptions = {},
): Promise<DiscoveredSpeaker[]> {
  const browse = options.browse ?? browseWithBonjour;
  const found = new Map<string, DiscoveredSpeaker>();

  const stops = localAddresses().map((address) =>
    browse(address, (speaker) => {
      if (!found.has(speaker.deviceId)) found.set(speaker.deviceId, speaker);
    }),
  );

  try {
    await new Promise((done) => setTimeout(done, options.forMs ?? DEFAULT_FOR_MS));
  } finally {
    // In a finally because a browser left running holds a socket open, and a
    // discovery that was abandoned is exactly when that matters.
    for (const stop of stops) stop();
  }

  return [...found.values()].sort((one, other) => one.deviceId.localeCompare(other.deviceId));
}

/** Every IPv4 address this machine answers on, loopback aside. */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
}

/**
 * The real thing: one Bonjour browser bound to one address.
 *
 * The TXT record spells the id `deviceId` — camel case, unlike the lower-cased
 * keys mDNS libraries often hand back — and a speaker that answers without one
 * is not something this plugin can talk to, so it is passed over rather than
 * guessed at.
 */
const browseWithBonjour: BrowseFunction = (address, found) => {
  const bonjour = new Bonjour(bindTo(address));
  const browser = bonjour.find({ type: 'yandexio', protocol: 'tcp' });

  browser.on('up', (service) => {
    const txt = (service.txt ?? {}) as Record<string, string | undefined>;
    const deviceId = txt['deviceId'] ?? txt['deviceid'];
    const platform = txt['platform'];
    const host = (service.addresses ?? []).find((candidate) => !candidate.includes(':'));

    if (!deviceId || !platform || !host) return;
    found({ deviceId, platform, host, port: service.port });
  });

  return () => {
    browser.stop();
    bonjour.destroy();
  };
};

/**
 * Which address to send the queries from.
 *
 * Cast because bonjour-service types its constructor as the options for
 * *publishing* a service, while what it actually does with them is hand them
 * to multicast-dns — where `interface` is the one that matters, and the only
 * one this file sets. The types are narrower than the library.
 */
function bindTo(address: string): ConstructorParameters<typeof Bonjour>[0] {
  return { interface: address } as unknown as ConstructorParameters<typeof Bonjour>[0];
}

import dgram from 'node:dgram';
import os from 'node:os';

import { parseDiscoverReply } from './protocol.js';

/**
 * UDP to the lamps: one socket, one command in flight per lamp.
 *
 * The firmware answers the sender of each datagram and holds no session, so
 * matching a reply to a command is matching addresses — which only works if
 * a lamp is never asked two things at once. Hence the queue: commands to one
 * lamp go out one at a time, each waiting for its reply or its timeout, and
 * commands to different lamps do not wait on each other at all.
 *
 * A datagram can simply vanish, so a command may retry once before giving
 * up. The caller says how many attempts a command is worth: a key press is
 * worth two, the poll is worth one — the next poll is two seconds away
 * anyway, and a missed one is how "not connected" is noticed.
 */

export interface LampAddress {
  readonly host: string;
  readonly port: number;
}

export const LAMP_PORT = 8888;

/** `192.168.1.90`, with the port only when it is not the lamp's usual one. */
export function formatAddress(address: LampAddress): string {
  return address.port === LAMP_PORT ? address.host : `${address.host}:${address.port}`;
}

export function parseAddress(text: string): LampAddress | undefined {
  const found = /^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/.exec(text.trim());
  if (!found) return undefined;

  const port = found[2] === undefined ? LAMP_PORT : Number(found[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  return { host: found[1]!, port };
}

interface Job {
  readonly command: string;
  attempts: number;
  readonly timeoutMs: number;
  readonly resolve: (reply: string) => void;
  readonly reject: (error: Error) => void;
}

interface Lane {
  readonly address: LampAddress;
  readonly queue: Job[];
  current?: Job;
  timer?: NodeJS.Timeout;
  /**
   * Until when the lane keeps quiet after a timeout, swallowing strays.
   *
   * A reply that misses its deadline still arrives — the lamp answered,
   * only late — and with the next command already in flight it would be
   * taken for that command's answer, shifting every reply after it by one.
   * Observed against the real lamp: one late reply after a discovery storm
   * and every state published from then on was the previous command's. So
   * a timeout is followed by a short silence in which nothing is in flight
   * and a landing stray meets no job to poison.
   */
  quietUntil?: number;
}

/** Longer than a late reply is ever late by, shorter than a person notices. */
const QUIET_MS = 500;

export class LampSocket {
  private socket?: dgram.Socket;
  private readonly lanes = new Map<string, Lane>();
  private closed = false;

  /**
   * Sends one command and settles on the reply.
   *
   * Rejects when every attempt timed out, when the socket failed to send, or
   * when the socket was closed under it — all of which mean the same thing
   * to a caller: the lamp did not answer.
   */
  request(
    address: LampAddress,
    command: string,
    options: { timeoutMs?: number; attempts?: number } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('The socket is closed'));
        return;
      }

      const key = formatAddress(address);
      let lane = this.lanes.get(key);
      if (!lane) {
        lane = { address, queue: [] };
        this.lanes.set(key, lane);
      }

      lane.queue.push({
        command,
        attempts: Math.max(1, options.attempts ?? 1),
        timeoutMs: options.timeoutMs ?? 1200,
        resolve,
        reject,
      });

      if (!lane.current) this.next(lane);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;

    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      const waiting = lane.current ? [lane.current, ...lane.queue] : lane.queue;
      for (const job of waiting) job.reject(new Error('The socket is closed'));
    }
    this.lanes.clear();
  }

  private next(lane: Lane): void {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = undefined;
    lane.current = undefined;
    if (lane.queue.length === 0) return;

    // Nothing is put in flight while the lane is quiet: a stray landing now
    // finds no current job and is dropped, which is the whole point.
    const wait = (lane.quietUntil ?? 0) - Date.now();
    if (wait > 0) {
      lane.timer = setTimeout(() => this.next(lane), wait);
      return;
    }

    const job = lane.queue.shift()!;
    lane.current = job;
    this.fire(lane, job);
  }

  private fire(lane: Lane, job: Job): void {
    job.attempts -= 1;

    this.ensureSocket().send(
      Buffer.from(job.command, 'utf8'),
      lane.address.port,
      lane.address.host,
      (error) => {
        if (error && lane.current === job) {
          if (lane.timer) clearTimeout(lane.timer);
          lane.current = undefined;
          job.reject(error);
          this.next(lane);
        }
      },
    );

    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(() => {
      if (lane.current !== job) return;

      if (job.attempts > 0) {
        // A retry repeats the same command, so a late reply to the first
        // send answers the retry just as truthfully — no quiet needed here.
        this.fire(lane, job);
        return;
      }

      lane.quietUntil = Date.now() + QUIET_MS;
      job.reject(new Error(`${formatAddress(lane.address)} did not answer ${job.command}`));
      this.next(lane);
    }, job.timeoutMs);
  }

  /**
   * The socket, made when first needed.
   *
   * Never bound explicitly: the first send binds it to an ephemeral port,
   * and replies land on the same socket — which also keeps the firewall
   * happy, since every reply matches a flow this socket started.
   */
  private ensureSocket(): dgram.Socket {
    if (this.socket) return this.socket;

    const socket = dgram.createSocket('udp4');
    socket.on('error', () => undefined);
    socket.on('message', (message, rinfo) => {
      const lane = this.lanes.get(formatAddress({ host: rinfo.address, port: rinfo.port }));
      const job = lane?.current;
      if (!lane || !job) return;

      if (lane.timer) clearTimeout(lane.timer);
      lane.current = undefined;
      job.resolve(message.toString('utf8'));
      this.next(lane);
    });

    this.socket = socket;
    return socket;
  }
}

/** A lamp the sweep heard back from. */
export interface DiscoveredLamp {
  readonly host: string;
  readonly port: number;
  readonly name?: string;
}

/**
 * Finds the lamps by asking every host of every small local subnet.
 *
 * A broadcast would be one datagram instead of a few hundred, and it fails
 * twice on the machine this runs on: it leaves through whichever interface
 * holds the default route — a VPN, when one is up — and even aimed right,
 * the reply comes from the lamp's own address while the outbound flow was to
 * the broadcast one, so the stateful firewall drops it. Unicast to each host
 * makes every reply match a flow, and 254 empty datagrams cost nothing a
 * person can notice. Verified against the real lamp; the broadcast was too.
 *
 * Subnets wider than /24 are skipped rather than swept: a /20 is four
 * thousand datagrams into what is usually a virtual switch with no lamp on
 * it, and every observed lamp sits on an ordinary home /24.
 */
export async function discoverLamps(timeoutMs = 2500): Promise<DiscoveredLamp[]> {
  const targets: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;

      const prefix = prefixOf(entry.netmask);
      if (prefix === undefined || prefix < 24 || prefix > 30) continue;

      const own = numberOf(entry.address);
      const base = (own & maskOf(prefix)) >>> 0;
      const hosts = 2 ** (32 - prefix) - 2;
      for (let at = 1; at <= hosts; at += 1) {
        const candidate = base + at;
        if (candidate !== own) targets.push(addressOf(candidate));
      }
    }
  }

  if (targets.length === 0) return [];

  const found = new Map<string, DiscoveredLamp>();
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => undefined);
  socket.on('message', (message, rinfo) => {
    const reply = parseDiscoverReply(message.toString('utf8'));
    if (!reply) return;

    // The address the datagram came from rather than the one in its text:
    // a lamp behind any address translation names an address this machine
    // cannot reach, and the one that answered plainly can be.
    found.set(rinfo.address, { host: rinfo.address, ...reply });
  });

  const probe = Buffer.from('DISCOVER', 'utf8');
  for (const host of targets) socket.send(probe, LAMP_PORT, host);

  await new Promise((settle) => setTimeout(settle, timeoutMs));
  socket.close();

  return [...found.values()].sort((one, other) => one.host.localeCompare(other.host));
}

function prefixOf(netmask: string): number | undefined {
  const value = numberOf(netmask);
  if (Number.isNaN(value)) return undefined;

  // A netmask is ones then zeroes; anything else is not a prefix at all.
  const bits = 32 - Math.log2(2 ** 32 - value);
  return Number.isInteger(bits) ? bits : undefined;
}

function numberOf(address: string): number {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return Number.NaN;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function maskOf(prefix: number): number {
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function addressOf(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

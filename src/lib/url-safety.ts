/**
 * Destination checks for URLs the server dials on its own (#264).
 *
 * Two callers fetch a URL a human wrote: the webhook dispatcher (an operator's
 * endpoint) and the provider metadata fetcher (a URI from on-chain data that
 * anyone registering a clinic controls). A mistyped or hostile URL must not
 * turn either into a request to the instance's own metadata service, an admin
 * port, or another host on the private network.
 *
 * The check resolves the host and refuses every address in a loopback,
 * private, link-local, unique-local, multicast or otherwise reserved range.
 * It refuses by *address*, not by hostname spelling: `127.1`, decimal IPv4
 * and `::ffff:169.254.169.254` all resolve to something this refuses.
 *
 * A redirect is a new destination, so callers that follow one must call this
 * again for the new URL — `fetch(..., {redirect: 'follow'})` would skip it.
 *
 * `WEBHOOK_ALLOW_PRIVATE=true` (or `allowPrivate`) is the documented opt-out
 * for local development, where `http://localhost:3000` is the whole point.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** One answer from a resolver. Mirrors `dns.lookup(..., {all: true})`. */
export type ResolvedAddress = { address: string; family: number };

/** Resolver seam for tests; defaults to `dns.lookup`. */
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** A destination refused for where it points, not for how it failed to load. */
export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDestinationError';
  }
}

const systemResolve: ResolveHost = async (hostname) => {
  const family = isIP(hostname);
  if (family !== 0) return [{ address: hostname, family }];
  return dnsLookup(hostname, { all: true, verbatim: true });
};

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/** Expands an IPv6 literal into eight 16-bit groups, or null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let value = ip;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  // An embedded dotted quad occupies the last two groups.
  let tail: number[] = [];
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (embedded) {
    const octets = ipv4Octets(embedded[1]!);
    if (!octets) return null;
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    value = value.slice(0, embedded.index);
    if (value.endsWith(':')) value = value.slice(0, -1);
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parse = (group: string): number =>
    /^[0-9a-fA-F]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN;
  const headGroups = head.map(parse);
  const restGroups = rest.map(parse);
  if ([...headGroups, ...restGroups].some((group) => Number.isNaN(group))) return null;

  const missing = 8 - tail.length - headGroups.length - restGroups.length;
  if (missing < 0) return null;
  // No `::` means the address must already be complete.
  if (halves.length === 1 && missing !== 0) return null;
  const zeros = halves.length === 2 ? Array<number>(missing).fill(0) : [];
  return [...headGroups, ...zeros, ...restGroups, ...tail];
}

function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, e.g. the cloud metadata service
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast and reserved, up to 255.255.255.255
  );
}

function isPrivateIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return true;

  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 hat.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  }
  // :: (unspecified) and ::1 (loopback).
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // Deprecated IPv4-compatible ::/96.
  if (groups.slice(0, 6).every((g) => g === 0)) {
    return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  }

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True for any address an outbound request must not reach by default. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // Not an IP at all: refuse rather than guess.
  return true;
}

export type DestinationOptions = {
  /** Skip the check; set by `WEBHOOK_ALLOW_PRIVATE=true` for local dev. */
  allowPrivate?: boolean;
  /** Resolver seam for tests. */
  resolve?: ResolveHost;
};

/**
 * Throws `UnsafeDestinationError` when `url` is not an http(s) URL or any
 * address its host resolves to is in a private or reserved range.
 */
export async function assertSafeDestination(
  url: string | URL,
  opts: DestinationOptions = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    throw new UnsafeDestinationError('destination is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeDestinationError(`destination scheme ${parsed.protocol} is not http(s)`);
  }
  if (opts.allowPrivate === true) return;

  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (opts.resolve ?? systemResolve)(host);
  } catch (err) {
    throw new Error(`could not resolve ${host}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) throw new Error(`could not resolve ${host}: no addresses`);

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeDestinationError(
        `refusing ${host}: ${address} is a private, loopback, link-local or unique-local address`,
      );
    }
  }
}

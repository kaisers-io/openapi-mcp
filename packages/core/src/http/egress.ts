import { isIP } from 'node:net';
import { validationError } from '../errors.ts';

// M2a scope (Plan Decision D4): address validation for remote-controlled
// redirect targets. The initial --spec URL is operator intent and is not
// checked here. M3 replaces this post-resolution validation with a DNS-pinning
// dispatcher that closes the remaining resolve-vs-connect TOCTOU window (§7.4).

export type DnsLookup = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

export interface EgressPolicyOptions {
  allowPrivateNetwork: boolean;
}

export type AddressClass = 'public' | 'private' | 'metadata';

// Cloud metadata/credential endpoints: denied even with --allow-private-network.
// Maintained deny set (D4): IMDS at 169.254.169.254 (AWS/GCP/Azure/OpenStack/
// DigitalOcean), AWS ECS task credentials, Alibaba Cloud metadata, GCP hostnames.
const METADATA_IPV4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

const classifyIpv4 = (address: string): AddressClass => {
  if (METADATA_IPV4.has(address)) {
    return 'metadata';
  }
  const [octetA = -1, octetB = -1] = address.split('.').map(Number);
  if (
    octetA === 0 || // "This network"
    octetA === 10 || // RFC1918
    octetA === 127 || // Loopback
    (octetA === 100 && octetB >= 64 && octetB <= 127) || // CGNAT 100.64/10
    (octetA === 169 && octetB === 254) || // Link-local
    (octetA === 172 && octetB >= 16 && octetB <= 31) || // RFC1918
    (octetA === 192 && octetB === 168) || // RFC1918
    octetA >= 224 // Multicast, reserved, broadcast
  ) {
    return 'private';
  }
  return 'public';
};

// Parses a valid IPv6 literal (isIP === 6) into its eight 16-bit groups,
// converting an embedded dotted-IPv4 tail into two hex groups first
const ipv6Groups = (raw: string): readonly number[] | undefined => {
  let address = raw.toLowerCase();
  const dotted = /^(?<head>.*:)(?<v4>\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (dotted?.groups !== undefined) {
    const [octet1 = 0, octet2 = 0, octet3 = 0, octet4 = 0] = (dotted.groups['v4'] ?? '')
      .split('.')
      .map(Number);
    address = `${dotted.groups['head']}${(octet1 * 256 + octet2).toString(16)}:${(
      octet3 * 256 +
      octet4
    ).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail =
    halves.length < 2 || halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':');
  const zeros = 8 - head.length - tail.length;
  if ((halves.length === 2 && zeros < 1) || (halves.length === 1 && zeros !== 0)) {
    return undefined;
  }
  const groups = [...head, ...Array.from({ length: zeros }, () => '0'), ...tail].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.some((value) => Number.isNaN(value) || value < 0 || value > 0xffff)
    ? undefined
    : groups;
};

export const classifyAddress = (address: string): AddressClass => {
  const family = isIP(address);
  if (family === 4) {
    return classifyIpv4(address);
  }
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (groups === undefined) {
      // IsIP said valid but the parse failed: fail closed
      return 'private';
    }
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      // IPv4-mapped ::ffff:0:0/96 — classify the embedded IPv4 regardless of
      // spelling (WHATWG URLs canonicalize dotted forms to hex groups)
      return classifyIpv4(
        `${Math.floor(g6 / 256)}.${g6 % 256}.${Math.floor(g7 / 256)}.${g7 % 256}`,
      );
    }
    if (groups.every((value) => value === 0)) {
      // Unspecified ::
      return 'private';
    }
    if (
      g0 === 0 &&
      g1 === 0 &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      g6 === 0 &&
      g7 === 1
    ) {
      // Loopback ::1
      return 'private';
    }
    if ((g0 >= 0xfc00 && g0 <= 0xfdff) || (g0 >= 0xfe80 && g0 <= 0xfebf)) {
      // Unique-local fc00::/7, link-local fe80::/10
      return 'private';
    }
    return 'public';
  }
  // Not an IP literal: callers must resolve hostnames via DNS first
  return 'public';
};

const hostnameOf = (url: URL): string => {
  const raw = url.hostname;
  // URL.hostname keeps brackets around IPv6 literals; strip them for isIP()
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
};

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const assertAllowedRedirectTarget = async (
  url: URL,
  opts: EgressPolicyOptions,
  lookup: DnsLookup,
  signal: AbortSignal,
): Promise<void> => {
  const hostname = hostnameOf(url);
  const lower = hostname.toLowerCase();
  const check = (address: string): void => {
    if (isIP(address) === 0) {
      // Fail closed: a DnsLookup implementation must return IP addresses
      throw validationError(
        `DNS lookup for redirect target "${lower}" returned a non-IP answer — failing closed`,
      );
    }
    const classified = classifyAddress(address);
    if (classified === 'metadata') {
      throw validationError(
        `redirect target "${lower}" points at the cloud-metadata address ${address} — never allowed`,
      );
    }
    if (classified === 'private' && !opts.allowPrivateNetwork) {
      throw validationError(
        `redirect target "${lower}" points at the private/loopback address ${address} — pass --allow-private-network to permit it`,
      );
    }
  };
  if (METADATA_HOSTNAMES.has(lower)) {
    throw validationError(
      `redirect target "${lower}" is a cloud-metadata endpoint — never allowed`,
    );
  }
  if (isIP(lower) !== 0) {
    check(lower);
    return;
  }
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    if (!opts.allowPrivateNetwork) {
      throw validationError(
        `redirect target "${lower}" is loopback — pass --allow-private-network to permit it`,
      );
    }
    return;
  }
  let addresses: readonly string[];
  try {
    // Bound to the caller's whole-chain deadline: a hanging resolver must not
    // outlive the §4.1 fetch timeout budget
    addresses = await lookup(hostname, signal);
  } catch (err) {
    throw validationError(`cannot resolve redirect target "${lower}": ${describeCause(err)}`);
  }
  if (addresses.length === 0) {
    throw validationError(`redirect target "${lower}" did not resolve to any address`);
  }
  // Post-resolution validation of EVERY answer (spec §7.4). The remaining
  // resolve-vs-connect TOCTOU window is closed by M3's DNS-pinning dispatcher.
  for (const address of addresses) {
    check(address);
  }
};

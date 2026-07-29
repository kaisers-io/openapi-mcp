import { isIP } from 'node:net';
import { validationError } from '../errors.ts';

// Address validation for remote-controlled redirect targets. The initial
// --spec URL is operator intent and is not checked here. This is
// post-resolution validation; the DNS-pinning dispatcher in
// pinned-dispatcher.ts closes the remaining resolve-vs-connect TOCTOU window.
//
// classifyAddress fails closed on the full set of SSRF-relevant IANA
// special-purpose ranges (IANA "IPv4 Special-Purpose Address Registry" and
// "IPv6 Special-Purpose Address Registry"), plus the NAT64 IPv4-embedding
// rules of RFC 6052/8215. Only the well-known NAT64 prefix 64:ff9b::/96 has a
// fixed "embedded IPv4 = low 32 bits" layout; every OTHER 64:ff9b:x:: prefix
// (incl. the RFC 8215 local-use 64:ff9b:1::/48) places the embedded IPv4 at a
// translator-prefix-dependent bit offset that cannot be soundly decoded, so it
// is classified metadata (always denied, non-overridable) WITHOUT decoding: a
// merely-private classification there would still be allowed under
// --allow-private-network/baseTrusted, and a /96 translator inside that
// prefix can map onto the metadata address (see classifyAddress below).

export type DnsLookup = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

export interface EgressPolicyOptions {
  allowPrivateNetwork: boolean;
}

export type AddressClass = 'public' | 'private' | 'metadata';

// Cloud metadata/credential endpoints: denied even with --allow-private-network.
// Maintained deny set: IMDS at 169.254.169.254 (AWS/GCP/Azure/OpenStack/
// DigitalOcean), AWS ECS task credentials, AWS EKS Pod Identity Agent
// (169.254.170.23), Alibaba Cloud metadata, Azure WireServer (168.63.129.16 —
// Microsoft's reserved platform IP; no customer workload serves there, so it
// is reachable ALWAYS, even without --allow-private-network), GCP hostnames.
const METADATA_IPV4 = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  '100.100.100.200',
  '168.63.129.16',
]);
// GCP metadata hostnames, plus the Tencent Cloud CAM/STS credential endpoint
// hostname (metadata.tencentyun.com) — no reliable Tencent IP is added here
// (sources conflict and both candidates already classify 'private').
export const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.tencentyun.com',
]);

const classifyIpv4 = (address: string): AddressClass => {
  if (METADATA_IPV4.has(address)) {
    return 'metadata';
  }
  const [octetA = -1, octetB = -1, octetC = -1] = address.split('.').map(Number);
  if (
    octetA === 0 || // "This network"
    octetA === 10 || // RFC1918
    octetA === 127 || // Loopback
    (octetA === 100 && octetB >= 64 && octetB <= 127) || // CGNAT 100.64/10
    (octetA === 169 && octetB === 254) || // Link-local
    (octetA === 172 && octetB >= 16 && octetB <= 31) || // RFC1918
    (octetA === 192 && octetB === 168) || // RFC1918
    (octetA === 192 && octetB === 0 && octetC === 0) || // IETF protocol assignments 192.0.0.0/24
    (octetA === 192 && octetB === 0 && octetC === 2) || // Documentation (TEST-NET-1) 192.0.2.0/24
    (octetA === 198 && octetB === 51 && octetC === 100) || // Documentation (TEST-NET-2) 198.51.100.0/24
    (octetA === 203 && octetB === 0 && octetC === 113) || // Documentation (TEST-NET-3) 203.0.113.0/24
    (octetA === 198 && (octetB === 18 || octetB === 19)) || // Benchmarking 198.18.0.0/15
    (octetA === 192 && octetB === 88 && octetC === 99) || // 6to4 relay anycast 192.88.99.0/24
    octetA >= 224 // Multicast, reserved, broadcast
  ) {
    return 'private';
  }
  return 'public';
};

// Decodes the low 32 bits of two IPv6 groups into a dotted-quad IPv4 string.
// Shared by the IPv4-mapped (::ffff:0:0/96) and well-known-NAT64
// (64:ff9b::/96) decode paths below.
const ipv4FromGroups = (high: number, low: number): string =>
  `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;

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
  return groups.some((value) => Number.isNaN(value) || value < 0 || value > 0xff_ff)
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
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xff_ff) {
      // IPv4-mapped ::ffff:0:0/96 — classify the embedded IPv4 regardless of
      // spelling (WHATWG URLs canonicalize dotted forms to hex groups)
      return classifyIpv4(ipv4FromGroups(g6, g7));
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
    if (g0 === 0x00_64 && g1 === 0xff_9b) {
      // NAT64 (RFC 6052/8215; IANA IPv6 Special-Purpose Address Registry).
      // Only the well-known prefix 64:ff9b::/96 has a fixed "embedded IPv4 =
      // low 32 bits" layout — decode it and classify with classifyIpv4 so a
      // NAT64-wrapped metadata/private address is denied rather than passed
      // as public.
      if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
        return classifyIpv4(ipv4FromGroups(g6, g7));
      }
      // Every OTHER 64:ff9b:x:: prefix — including the RFC 8215 local-use
      // 64:ff9b:1::/48 — places the embedded IPv4 at a translator-prefix-dependent bit
      // offset (/32../64, with the reserved "u" octet at bits 64-71 per
      // RFC 6052 §2.2), so a fixed low-32 decode there is unsound and a /96
      // translator inside the prefix could map e.g.
      // 64:ff9b:1:...:a9fe:a9fe onto the metadata address 169.254.169.254.
      // A merely-'private' classification here would still be ALLOWED under
      // --allow-private-network/baseTrusted, breaking the "metadata always
      // denied" invariant, so this undecodable prefix is classified
      // 'metadata' (always denied, non-overridable) WITHOUT decoding rather
      // than 'private'. KNOWN LIMITATION: an arbitrary RFC 8215
      // network-specific NAT64 prefix living INSIDE ordinary global unicast
      // (a provider's own /32../64 unrelated to the 64:ff9b::/16 block) is
      // indistinguishable client-side from a normal global-unicast address
      // and cannot be identified here at all — closing that gap requires an
      // OS/network-layer metadata deny, out of scope for this client-side
      // egress guard.
      return 'metadata';
    }
    if (g0 === 0x20_01 && g1 === 0) {
      // Teredo 2001::/32 (RFC 4380; IANA registry) — a tunneling prefix we
      // cannot soundly decode; fail closed rather than classify public.
      return 'private';
    }
    if (g0 === 0x20_01 && g1 === 0x0d_b8) {
      // Documentation 2001:db8::/32 (IANA registry)
      return 'private';
    }
    if (g0 === 0x20_01 && g1 === 2 && g2 === 0) {
      // Benchmarking 2001:2::/48 (IANA registry)
      return 'private';
    }
    if (g0 === 0x20_02) {
      // 6to4 2002::/16 (RFC 3056; IANA registry) — another undecodable
      // tunneling prefix; fail closed rather than classify public.
      return 'private';
    }
    if (g0 === 0x01_00 && g1 === 0 && g2 === 0 && g3 === 0) {
      // Discard-only 100::/64 (IANA registry)
      return 'private';
    }
    // AWS IPv6 IMDS fd00:ec2::254 and AWS EKS Pod Identity Agent fd00:ec2::23
    // — metadata/credential endpoints (denied even with
    // --allow-private-network). Matched before the fc00::/7 ULA range below,
    // which would otherwise class them merely private.
    if (
      g0 === 0xfd_00 &&
      g1 === 0x0e_c2 &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      g6 === 0 &&
      (g7 === 0x02_54 || g7 === 0x00_23)
    ) {
      return 'metadata';
    }
    // GCP Compute metadata server (IPv6) fd20:ce::254 — same rationale as
    // above; matched before the fc00::/7 ULA range.
    if (
      g0 === 0xfd_20 &&
      g1 === 0x00_ce &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      g6 === 0 &&
      g7 === 0x02_54
    ) {
      return 'metadata';
    }
    if ((g0 >= 0xfc_00 && g0 <= 0xfd_ff) || (g0 >= 0xfe_80 && g0 <= 0xfe_bf) || g0 >= 0xff_00) {
      // Unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8
      return 'private';
    }
    // Fail-closed allow-list posture: classify public
    // ONLY within global-unicast 2000::/3 (IANA registry), minus the two
    // carve-outs below. Every other range (e.g. discard-only 100::/8 beyond
    // the 100::/64 handled above, SRv6 SIDs 5f00::/16, and any future or
    // unallocated non-global-unicast block) falls through to private instead
    // of the previous fail-open "return 'public'" default.
    if (g0 === 0x3f_ff) {
      // Documentation 3fff::/20 (RFC 9637; IANA registry), over-approximated
      // to the containing 3fff::/16 — no real public address lives here.
      return 'private';
    }
    if (g0 === 0x20_01 && g1 <= 0x01_ff) {
      // IETF Protocol Assignments 2001::/23 (IANA registry). Teredo
      // (2001::/32), benchmarking (2001:2::/48), and documentation
      // (2001:db8::/32) above are explicit sub-block matches within this
      // range kept for clarity; this closes the remaining sub-blocks (e.g.
      // ORCHID 2001:20::/28) fail-closed. Real global-unicast allocations
      // (2001:4860::, 2606:4700::, 2a00::, ...) all lie outside 2001::/23.
      return 'private';
    }
    if (g0 >= 0x20_00 && g0 <= 0x3f_ff) {
      // Global unicast 2000::/3 (IANA registry), excluding the
      // documentation/protocol-assignment carve-outs above.
      return 'public';
    }
    return 'private';
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
    // outlive the fetch timeout budget
    addresses = await lookup(hostname, signal);
  } catch (error) {
    throw validationError(`cannot resolve redirect target "${lower}": ${describeCause(error)}`);
  }
  if (addresses.length === 0) {
    throw validationError(`redirect target "${lower}" did not resolve to any address`);
  }
  // Post-resolution validation of EVERY answer. The remaining
  // resolve-vs-connect TOCTOU window is closed by the DNS-pinning dispatcher
  // in pinned-dispatcher.ts.
  for (const address of addresses) {
    check(address);
  }
};

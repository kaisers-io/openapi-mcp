import { describe, expect, it } from 'vitest';
import { assertAllowedRedirectTarget, classifyAddress } from '../src/index.ts';

const allow = { allowPrivateNetwork: true };
const deny = { allowPrivateNetwork: false };
const { signal } = new AbortController();
const noLookup = (): Promise<readonly string[]> =>
  Promise.reject(new Error('lookup must not be called for literals'));

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.10', 'private'],
    ['169.254.0.1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['0.0.0.0', 'private'],
    ['224.0.0.1', 'private'],
    ['255.255.255.255', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['169.254.170.23', 'metadata'], // AWS EKS Pod Identity Agent (IPv4)
    ['169.254.170.24', 'private'], // Adjacent address stays private (proves the metadata match is exact)
    ['100.100.100.200', 'metadata'],
    ['168.63.129.16', 'metadata'], // Azure WireServer — reachable always, no customer workload serves there
    ['168.63.129.17', 'public'], // Adjacent address stays public (proves the metadata match is exact)
    ['93.184.216.34', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['192.0.0.1', 'private'], // IETF protocol assignments 192.0.0.0/24
    ['192.0.2.1', 'private'], // Documentation (TEST-NET-1) 192.0.2.0/24
    ['198.51.100.1', 'private'], // Documentation (TEST-NET-2) 198.51.100.0/24
    ['203.0.113.1', 'private'], // Documentation (TEST-NET-3) 203.0.113.0/24
    ['198.18.0.1', 'private'], // Benchmarking 198.18.0.0/15 (lower half)
    ['198.19.255.255', 'private'], // Benchmarking 198.18.0.0/15 (upper half)
    ['192.88.99.1', 'private'], // 6to4 relay anycast 192.88.99.0/24
    ['::1', 'private'],
    ['::', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:93.184.216.34', 'public'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:a9fe:aa02', 'metadata'],
    ['::ffff:5db8:d822', 'public'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'public'],
    ['fd00:ec2::254', 'metadata'], // AWS IPv6 IMDS — denied even with --allow-private-network
    ['fd00:ec2::23', 'metadata'], // AWS EKS Pod Identity Agent (IPv6)
    ['fd00:ec2::24', 'private'], // Adjacent ULA stays merely private (proves the metadata match is exact)
    ['fd20:ce::254', 'metadata'], // GCP Compute metadata server (IPv6)
    ['fd20:ce::255', 'private'], // Adjacent ULA stays merely private (proves the metadata match is exact)
    ['fd20:ce::1', 'private'], // Different tail within the same ULA prefix stays merely private
    ['ff02::1', 'private'], // IPv6 multicast (was public)
    ['ff00::', 'private'],
    ['fd00:ec2::255', 'private'], // Adjacent ULA stays merely private (proves the metadata match is exact)
    ['100::1', 'private'], // Discard-only 100::/64
    ['2001:db8::1', 'private'], // Documentation 2001:db8::/32
    ['2001:2::1', 'private'], // Benchmarking 2001:2::/48
    ['64:ff9b::a9fe:a9fe', 'metadata'], // Well-known NAT64 embeds AWS IMDS (169.254.169.254) — must decode
    ['64:ff9b::a00:1', 'private'], // Well-known NAT64 embeds a private address (10.0.0.1) — must decode
    // Local-use NAT64 /48 (RFC 8215) — NOT decoded, whole prefix denied as
    // metadata (final-review fix, HIGH): a /96 translator inside this
    // prefix could map onto the metadata address, so a merely-private
    // classification (still allowed under --allow-private-network) is unsafe.
    ['64:ff9b:1::a9fe:a9fe', 'metadata'],
    ['64:ff9b:2::1', 'metadata'], // Any other unallocated 64:ff9b:x:: prefix — same fail-closed rule
    ['2001::1', 'private'], // Teredo 2001::/32 — undecodable tunnel prefix, fail closed
    ['2002::1', 'private'], // 6to4 2002::/16 — undecodable tunnel prefix, fail closed
    ['100:0:0:1::1', 'private'], // Discard-only 100::/8 beyond the decoded 100::/64 — fail-closed fallthrough
    ['5f00::1', 'private'], // SRv6 SIDs 5f00::/16 — outside global-unicast 2000::/3, fail-closed fallthrough
    ['5f00::', 'private'], // Same block, network address
    ['3fff::1', 'private'], // Documentation 3fff::/20 (RFC 9637), over-approximated to 3fff::/16
    ['3fff:ffff::1', 'private'], // Still within the 3fff::/16 over-approximation
    ['2001:1::4', 'private'], // IETF protocol assignments 2001::/23 sub-block
    ['2001:20::1', 'private'], // ORCHID 2001:20::/28, a 2001::/23 sub-block
    ['2606:4700::1', 'public'], // Genuine global unicast (Cloudflare), outside every carve-out
    ['2a00:1450::1', 'public'], // Genuine global unicast, outside every carve-out
    ['2001:4860:4860::8888', 'public'], // Google DNS — 2001::/16 but outside the 2001::/23 carve-out
  ])('classifies %s as %s', (address, expected) => {
    // Hex-group entries are the WHATWG-canonical spellings of mapped literals:
    // ::ffff:7f00:1 = 127.0.0.1, ::ffff:a00:1 = 10.0.0.1,
    // ::ffff:a9fe:a9fe = 169.254.169.254, ::ffff:a9fe:aa02 = 169.254.170.2,
    // ::ffff:5db8:d822 = 93.184.216.34
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('assertAllowedRedirectTarget', () => {
  it('rejects private IP-literal targets by default, naming the flag', async () => {
    await expect(
      assertAllowedRedirectTarget(new URL('http://10.0.0.5/spec'), deny, noLookup, signal),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('--allow-private-network') as string,
    });
  });

  it('rejects IPv6 loopback literals (bracket form)', async () => {
    await expect(
      assertAllowedRedirectTarget(new URL('http://[::1]:8080/spec'), deny, noLookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects hex IPv4 literals via WHATWG URL normalization', async () => {
    // The URL parser normalizes 0x7f000001 to 127.0.0.1 before classification
    await expect(
      assertAllowedRedirectTarget(new URL('http://0x7f000001/spec'), deny, noLookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('classifies mapped IPv6 literals after WHATWG URL canonicalization', async () => {
    // The call new URL('http://[::ffff:127.0.0.1]/') canonicalizes the hostname
    // to hexadecimal groups ([::ffff:7f00:1]) — classification must still hit
    await expect(
      assertAllowedRedirectTarget(new URL('http://[::ffff:127.0.0.1]/x'), deny, noLookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      assertAllowedRedirectTarget(new URL('http://[::ffff:10.0.0.1]/x'), deny, noLookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      assertAllowedRedirectTarget(
        new URL('http://[::ffff:169.254.169.254]/x'),
        allow,
        noLookup,
        signal,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
  });

  it('rejects the AWS IPv6 IMDS even with --allow-private-network', async () => {
    await expect(
      assertAllowedRedirectTarget(new URL('http://[fd00:ec2::254]/'), allow, noLookup, signal),
    ).rejects.toThrow(/metadata/u);
  });

  it.each(['fd00:ec2::23', 'fd20:ce::254'])(
    'rejects the IPv6 cloud credential endpoint %s even with --allow-private-network',
    async (address) => {
      await expect(
        assertAllowedRedirectTarget(new URL(`http://[${address}]/`), allow, noLookup, signal),
      ).rejects.toThrow(/metadata/u);
    },
  );

  it('rejects the local-use NAT64 /48 even with --allow-private-network (final-review fix)', async () => {
    await expect(
      assertAllowedRedirectTarget(
        new URL('http://[64:ff9b:1::a9fe:a9fe]/'),
        allow,
        noLookup,
        signal,
      ),
    ).rejects.toThrow(/metadata/u);
  });

  it('always rejects the metadata IP, even with allowPrivateNetwork', async () => {
    await expect(
      assertAllowedRedirectTarget(
        new URL('http://169.254.169.254/latest'),
        allow,
        noLookup,
        signal,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
  });

  it.each(['169.254.170.2', '169.254.170.23', '100.100.100.200', '168.63.129.16'])(
    'always rejects the cloud credential endpoint %s, even with allowPrivateNetwork',
    async (address) => {
      await expect(
        assertAllowedRedirectTarget(new URL(`http://${address}/creds`), allow, noLookup, signal),
      ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
    },
  );

  it.each(['metadata.google.internal', 'metadata.goog', 'metadata.tencentyun.com'])(
    'always rejects the metadata hostname %s',
    async (host) => {
      // Asserts the specific cloud-metadata-hostname deny message (not a bare
      // 'metadata' substring match, which the hostname itself would satisfy
      // even via the unrelated DNS-lookup-failure path through noLookup).
      await expect(
        assertAllowedRedirectTarget(new URL(`http://${host}/x`), allow, noLookup, signal),
      ).rejects.toMatchObject({
        message: expect.stringContaining('is a cloud-metadata endpoint') as string,
      });
    },
  );

  it.each(['localhost', 'dev.localhost'])('treats %s as loopback by name', async (host) => {
    await expect(
      assertAllowedRedirectTarget(new URL(`http://${host}/x`), deny, noLookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      assertAllowedRedirectTarget(new URL(`http://${host}/x`), allow, noLookup, signal),
    ).resolves.toBeUndefined();
  });

  it('allows private literals with allowPrivateNetwork', async () => {
    await expect(
      assertAllowedRedirectTarget(new URL('http://192.168.1.1/x'), allow, noLookup, signal),
    ).resolves.toBeUndefined();
  });

  it('validates every DNS answer of hostname targets', async () => {
    const lookup = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34', '10.0.0.7']);
    await expect(
      assertAllowedRedirectTarget(new URL('https://mixed.example.net/x'), deny, lookup, signal),
    ).rejects.toMatchObject({ message: expect.stringContaining('10.0.0.7') as string });
  });

  it('rejects DNS answers in canonical hex mapped form', async () => {
    const lookup = (): Promise<readonly string[]> => Promise.resolve(['::ffff:a00:1']);
    await expect(
      assertAllowedRedirectTarget(new URL('https://sneaky.example.net/x'), deny, lookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('fails closed on non-IP DNS answers', async () => {
    const lookup = (): Promise<readonly string[]> => Promise.resolve(['not-an-ip']);
    await expect(
      assertAllowedRedirectTarget(new URL('https://weird.example.net/x'), deny, lookup, signal),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('non-IP') as string,
    });
  });

  it('accepts hostnames whose answers are all public', async () => {
    const lookup = (): Promise<readonly string[]> =>
      Promise.resolve(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    await expect(
      assertAllowedRedirectTarget(new URL('https://ok.example.net/x'), deny, lookup, signal),
    ).resolves.toBeUndefined();
  });

  it('fails closed on DNS resolution errors', async () => {
    const lookup = (): Promise<readonly string[]> => Promise.reject(new Error('ENOTFOUND'));
    await expect(
      assertAllowedRedirectTarget(new URL('https://gone.example.net/x'), deny, lookup, signal),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('ENOTFOUND') as string,
    });
  });

  it('fails closed on empty DNS answers', async () => {
    const lookup = (): Promise<readonly string[]> => Promise.resolve([]);
    await expect(
      assertAllowedRedirectTarget(new URL('https://empty.example.net/x'), deny, lookup, signal),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

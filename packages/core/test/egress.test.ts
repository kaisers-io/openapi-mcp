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
    ['100.100.100.200', 'metadata'],
    ['93.184.216.34', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
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

  it.each(['169.254.170.2', '100.100.100.200'])(
    'always rejects the cloud credential endpoint %s, even with allowPrivateNetwork',
    async (address) => {
      await expect(
        assertAllowedRedirectTarget(new URL(`http://${address}/creds`), allow, noLookup, signal),
      ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
    },
  );

  it.each(['metadata.google.internal', 'metadata.goog'])(
    'always rejects the metadata hostname %s',
    async (host) => {
      await expect(
        assertAllowedRedirectTarget(new URL(`http://${host}/x`), allow, noLookup, signal),
      ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
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

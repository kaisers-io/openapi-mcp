import { describe, expect, it } from 'vitest';
import { MAX_REDIRECTS, fetchSpec, fetchSpecConditional, hashContent } from '../src/index.ts';

interface RecordedCall {
  url: string;
  headers: Headers;
}

// Builds a fetcher that pops queued responses and records every request
const fakeFetcher = (
  responses: readonly Response[],
): { fetcher: typeof fetch; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fake fetcher exhausted'));
    }
    return Promise.resolve(next);
  }) as typeof fetch;
  return { fetcher, calls };
};

const redirectTo = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

const AUTH = [{ name: 'Authorization', value: 'Bearer secret-token' }] as const;

// All redirect-target hostnames in these tests resolve to a public address
const publicLookup = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);
const rejectingLookup = (): Promise<readonly string[]> =>
  Promise.reject(new Error('lookup must not be called'));

describe('fetchSpec', () => {
  it('fetches a 200 body and returns text, hash, and redacted display source', async () => {
    const { fetcher, calls } = fakeFetcher([new Response('{"openapi":"3.1.0"}')]);
    const loaded = await fetchSpec(
      new URL('https://api.example.com/openapi.json?tenant=alpha'),
      { headers: AUTH },
      { fetcher, lookup: rejectingLookup },
    );
    expect(loaded.text).toBe('{"openapi":"3.1.0"}');
    expect(loaded.contentHash).toBe(hashContent('{"openapi":"3.1.0"}'));
    expect(loaded.displaySource).toBe('https://api.example.com/openapi.json');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(calls[0]?.headers.get('accept')).toContain('application/json');
  });

  it('does not egress-check the operator-supplied initial URL (D4)', async () => {
    const { fetcher } = fakeFetcher([new Response('{}')]);
    const loaded = await fetchSpec(
      new URL('http://localhost:3000/openapi.json'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect(loaded.text).toBe('{}');
  });

  it('follows same-origin redirects and keeps auth headers', async () => {
    const { fetcher, calls } = fakeFetcher([redirectTo('/v2/openapi.json'), new Response('{}')]);
    const loaded = await fetchSpec(
      new URL('https://api.example.com/openapi.json'),
      { headers: AUTH },
      { fetcher, lookup: publicLookup },
    );
    expect(loaded.displaySource).toBe('https://api.example.com/v2/openapi.json');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://api.example.com/v2/openapi.json');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('strips auth headers on cross-origin redirects', async () => {
    const { fetcher, calls } = fakeFetcher([
      redirectTo('https://cdn.example.net/spec.json'),
      new Response('{}'),
    ]);
    await fetchSpec(
      new URL('https://api.example.com/openapi.json'),
      { headers: AUTH },
      { fetcher, lookup: publicLookup },
    );
    expect(calls[1]?.headers.get('authorization')).toBeNull();
    expect(calls[1]?.headers.get('accept')).not.toBeNull();
  });

  it('re-sends auth headers when a chain returns to the original origin', async () => {
    const { fetcher, calls } = fakeFetcher([
      redirectTo('https://cdn.example.net/spec.json'),
      redirectTo('https://api.example.com/final.json'),
      new Response('{}'),
    ]);
    await fetchSpec(
      new URL('https://api.example.com/openapi.json'),
      { headers: AUTH },
      { fetcher, lookup: publicLookup },
    );
    expect(calls[1]?.headers.get('authorization')).toBeNull();
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('rejects a redirect to a private IP literal', async () => {
    const { fetcher, calls } = fakeFetcher([redirectTo('http://10.0.0.5/spec.json')]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('private') as string,
    });
    // The private target was never fetched
    expect(calls).toHaveLength(1);
  });

  it('rejects a redirect whose hostname resolves to a private address', async () => {
    const { fetcher } = fakeFetcher([redirectTo('https://internal.example.net/spec.json')]);
    const lookup = (): Promise<readonly string[]> => Promise.resolve(['192.168.1.10']);
    await expect(
      fetchSpec(new URL('https://api.example.com/a'), { headers: [] }, { fetcher, lookup }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects a redirect target carrying credential-bearing query parameters (D8)', async () => {
    const { fetcher, calls } = fakeFetcher([
      redirectTo('https://cdn.example.net/spec.json?api_key=redirect-secret'),
    ]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.not.stringContaining('redirect-secret') as string,
    });
    // The redirect target was never fetched
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['LF', 'token%0Aforged'],
    ['U+2028 line separator', 'token%E2%80%A8forged'],
  ])(
    'sanitizes hostile query-parameter names (%s) in redirect diagnostics',
    async (_label, param) => {
      const { fetcher } = fakeFetcher([redirectTo(`https://cdn.example.net/spec.json?${param}=x`)]);
      try {
        await fetchSpec(
          new URL('https://api.example.com/a'),
          { headers: [] },
          { fetcher, lookup: publicLookup },
        );
        expect.unreachable('expected a validation error');
      } catch (err) {
        const { message } = err as Error;
        // The decoded name contained a line break; the display copy is single-line
        expect(message).toContain('token forged');
        expect(message).not.toMatch(/[\n\u2028\u2029]/u);
      }
    },
  );

  it('binds redirect DNS resolution to the whole-chain deadline', async () => {
    const { fetcher } = fakeFetcher([redirectTo('https://slow.example.net/spec.json')]);
    const neverResolves = (
      _hostname: string,
      abortSignal: AbortSignal,
    ): Promise<readonly string[]> =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted by deadline'));
          },
          { once: true },
        );
      });
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [], timeoutMs: 50 },
        { fetcher, lookup: neverResolves },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('aborted by deadline') as string,
    });
  });

  it('allows private redirect targets with allowPrivateNetwork, but never metadata', async () => {
    const { fetcher } = fakeFetcher([redirectTo('http://10.0.0.5/spec.json'), new Response('{}')]);
    const loaded = await fetchSpec(
      new URL('https://api.example.com/a'),
      { headers: [], allowPrivateNetwork: true },
      { fetcher, lookup: publicLookup },
    );
    expect(loaded.text).toBe('{}');
    const { fetcher: metadataFetcher } = fakeFetcher([redirectTo('http://169.254.169.254/latest')]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [], allowPrivateNetwork: true },
        { fetcher: metadataFetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('metadata') as string });
  });

  it(`rejects after ${MAX_REDIRECTS} redirects`, async () => {
    const { fetcher } = fakeFetcher(
      Array.from({ length: MAX_REDIRECTS + 1 }, () => redirectTo('/next')),
    );
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('redirect') as string,
    });
  });

  it('rejects a redirect without a Location header', async () => {
    const { fetcher } = fakeFetcher([new Response(null, { status: 302 })]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects a redirect with an unparsable Location header', async () => {
    const { fetcher } = fakeFetcher([redirectTo('http://[')]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('Location') as string,
    });
  });

  it('rejects a redirect to a non-http scheme', async () => {
    const { fetcher } = fakeFetcher([redirectTo('ftp://evil.example.com/spec')]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('scheme') as string,
    });
  });

  it('rejects a redirect target with userinfo', async () => {
    const { fetcher } = fakeFetcher([redirectTo('https://user:pw@example.com/spec')]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('userinfo') as string,
    });
  });

  it('maps HTTP failure statuses to validation errors', async () => {
    const { fetcher } = fakeFetcher([new Response('nope', { status: 404 })]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('404') as string,
    });
  });

  it('adds a --spec-header-env hint on 401 when headers are configured', async () => {
    const { fetcher } = fakeFetcher([new Response('denied', { status: 401 })]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: AUTH },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('--spec-header-env') as string,
    });
  });

  it('suggests --spec-header-env on 403 when no headers are configured', async () => {
    const { fetcher } = fakeFetcher([new Response('denied', { status: 403 })]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('authentication') as string,
    });
  });

  it('rejects on a content-length over the budget before reading the body', async () => {
    const { fetcher } = fakeFetcher([
      new Response('irrelevant', { status: 200, headers: { 'content-length': '99999' } }),
    ]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [], maxBytes: 1024 },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('budget') as string,
    });
  });

  it('rejects a streamed body exceeding the byte budget', async () => {
    const { fetcher } = fakeFetcher([new Response('x'.repeat(64))]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [], maxBytes: 16 },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('budget') as string,
    });
  });

  it('returns empty text for a 200 response without a body', async () => {
    const { fetcher } = fakeFetcher([new Response(null, { status: 200 })]);
    const loaded = await fetchSpec(
      new URL('https://api.example.com/a'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect(loaded.text).toBe('');
  });

  it('maps an abort/timeout rejection to a timeout validation error', async () => {
    const fetcher = (() =>
      Promise.reject(new DOMException('The operation timed out', 'TimeoutError'))) as typeof fetch;
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [], timeoutMs: 5 },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('timed out') as string,
    });
  });

  it('maps network failures to validation errors without dropping the cause', async () => {
    const fetcher = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(
      fetchSpec(
        new URL('https://api.example.com/a'),
        { headers: [] },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('fetch failed') as string,
    });
  });
});

const notModified = (headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 304, headers });

// The Fetch API's Headers implementation refuses to construct a header value
// containing a raw CR or LF byte (WHATWG Fetch "invalid header value"), so a
// real fetch() response can never surface a header-injection payload through
// response.headers.get() — the runtime already forecloses it below our code.
// These fixtures simulate the byte sequence arriving anyway (a non-conformant
// fetcher, or defense-in-depth against a future runtime being more lenient)
// by overriding just the headers accessor on an otherwise-real Response.
const withRawHeader = (response: Response, name: string, rawValue: string): Response => {
  const lower = name.toLowerCase();
  const original = response.headers;
  Object.defineProperty(response, 'headers', {
    value: { get: (n: string) => (n.toLowerCase() === lower ? rawValue : original.get(n)) },
    configurable: true,
  });
  return response;
};

describe('fetchSpecConditional', () => {
  it('reports not-modified for a 304 (D6)', async () => {
    // Probed: fetch surfaces a 304 with ok === false and body === null, so the
    // status must be checked before the generic !ok branch would reject it
    const { fetcher, calls } = fakeFetcher([notModified({ etag: '"v1"' })]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], etag: '"v1"' },
      { fetcher, lookup: rejectingLookup },
    );
    // D16(a2): the validators the 304 returned come back with it, so the entry
    // can refresh what it replays next time
    expect(result).toEqual({ kind: 'not-modified', etag: '"v1"' });
    expect(calls[0]?.headers.get('if-none-match')).toBe('"v1"');
    expect(calls[0]?.headers.get('if-modified-since')).toBeNull();
  });

  it('carries a refreshed validator back from a 304 (D16a2)', async () => {
    // A server may answer 304 while rotating the ETag it wants next time
    const { fetcher } = fakeFetcher([
      notModified({ etag: '"v2"', 'last-modified': 'Thu, 22 Oct 2026 07:28:00 GMT' }),
    ]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], etag: '"v1"' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(result).toEqual({
      kind: 'not-modified',
      etag: '"v2"',
      lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
    });
  });

  it('drops a header-hostile validator returned on a 304, as it does on a 200', async () => {
    const { fetcher } = fakeFetcher([withRawHeader(notModified(), 'etag', 'v1\r\nX-Evil: 1')]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], etag: '"v1"' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(result).toEqual({ kind: 'not-modified' });
  });

  it('sends If-Modified-Since only when a lastModified is cached', async () => {
    const { fetcher, calls } = fakeFetcher([notModified()]);
    await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(calls[0]?.headers.get('if-modified-since')).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(calls[0]?.headers.get('if-none-match')).toBeNull();
  });

  it('sends both validators when the entry recorded both', async () => {
    const { fetcher, calls } = fakeFetcher([notModified()]);
    await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(calls[0]?.headers.get('if-none-match')).toBe('"v1"');
    expect(calls[0]?.headers.get('if-modified-since')).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('performs a plain GET when the entry has no validators', async () => {
    const { fetcher, calls } = fakeFetcher([new Response('{"openapi":"3.1.0"}')]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect(calls[0]?.headers.get('if-none-match')).toBeNull();
    expect(calls[0]?.headers.get('if-modified-since')).toBeNull();
    expect(result).toMatchObject({ kind: 'fetched' });
  });

  it('treats a 304 answered to a validator-free request as unchanged (D6, fail-safe)', async () => {
    // The caller keeps serving its accepted baseline, which is the safe
    // direction: a server answering a question nobody asked cannot force a swap
    const { fetcher } = fakeFetcher([notModified()]);
    await expect(
      fetchSpecConditional(
        new URL('https://api.example.com/openapi.json'),
        { headers: [] },
        { fetcher, lookup: rejectingLookup },
      ),
    ).resolves.toEqual({ kind: 'not-modified' });
  });

  it('checks 304 before the redirect branch, so a 304 is never followed', async () => {
    const { fetcher, calls } = fakeFetcher([
      notModified({ location: 'https://evil.example.net/spec.json' }),
    ]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [], etag: '"v1"' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(result).toEqual({ kind: 'not-modified' });
    expect(calls).toHaveLength(1);
  });

  it('returns the body, hash, redacted source, and fresh validators on a 200', async () => {
    const body = '{"openapi":"3.1.0"}';
    const { fetcher } = fakeFetcher([
      new Response(body, {
        headers: { etag: '"v2"', 'last-modified': 'Thu, 22 Oct 2026 07:28:00 GMT' },
      }),
    ]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json?tenant=alpha'),
      { headers: AUTH, etag: '"v1"' },
      { fetcher, lookup: rejectingLookup },
    );
    expect(result).toEqual({
      kind: 'fetched',
      loaded: {
        text: body,
        contentHash: hashContent(body),
        displaySource: 'https://api.example.com/openapi.json',
      },
      etag: '"v2"',
      lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
    });
  });

  it('omits an absent validator rather than returning undefined', async () => {
    const { fetcher } = fakeFetcher([new Response('{}')]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect(Object.keys(result).toSorted()).toEqual(['kind', 'loaded']);
  });

  it.each([
    ['a control character', 'v1\u0007'],
    ['an over-long value', `"${'x'.repeat(400)}"`],
  ])('drops a returned validator carrying %s (native Headers)', async (_label, etag) => {
    const { fetcher } = fakeFetcher([new Response('{}', { headers: { etag } })]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect('etag' in result).toBe(false);
  });

  it('drops a returned validator carrying a CRLF header-injection sequence', async () => {
    // A raw CR/LF cannot be placed in a real Headers (WHATWG throws at
    // construction), so this hostile value is injected through withRawHeader —
    // the only row that genuinely needs it.
    const { fetcher } = fakeFetcher([withRawHeader(new Response('{}'), 'etag', 'v1\r\nX-Evil: 1')]);
    const result = await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: [] },
      { fetcher, lookup: rejectingLookup },
    );
    expect('etag' in result).toBe(false);
  });

  it('never replays validators or auth headers to a foreign origin', async () => {
    const { fetcher, calls } = fakeFetcher([
      redirectTo('https://cdn.example.net/spec.json'),
      new Response('{}'),
    ]);
    await fetchSpecConditional(
      new URL('https://api.example.com/openapi.json'),
      { headers: AUTH, etag: '"v1"' },
      { fetcher, lookup: publicLookup },
    );
    expect(calls[1]?.headers.get('if-none-match')).toBeNull();
    expect(calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('keeps the existing redirect, egress, and budget discipline', async () => {
    const { fetcher, calls } = fakeFetcher([redirectTo('http://10.0.0.5/spec.json')]);
    await expect(
      fetchSpecConditional(
        new URL('https://api.example.com/openapi.json'),
        { headers: [], etag: '"v1"' },
        { fetcher, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(calls).toHaveLength(1);
    const { fetcher: bigFetcher } = fakeFetcher([new Response('x'.repeat(64))]);
    await expect(
      fetchSpecConditional(
        new URL('https://api.example.com/openapi.json'),
        { headers: [], maxBytes: 16 },
        { fetcher: bigFetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('budget') as string });
  });

  it('still maps a real failure status to a validation error', async () => {
    const { fetcher } = fakeFetcher([new Response('denied', { status: 401 })]);
    await expect(
      fetchSpecConditional(
        new URL('https://api.example.com/openapi.json'),
        { headers: AUTH, etag: '"v1"' },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('--spec-header-env') as string,
    });
  });
});

describe('fetchSpec and 304', () => {
  it('rejects an unsolicited 304 for an unconditional fetch', async () => {
    const { fetcher } = fakeFetcher([notModified()]);
    await expect(
      fetchSpec(
        new URL('https://api.example.com/openapi.json'),
        { headers: [] },
        { fetcher, lookup: rejectingLookup },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('304') as string,
    });
  });
});

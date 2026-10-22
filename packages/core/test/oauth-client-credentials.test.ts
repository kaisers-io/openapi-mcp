import { describe, expect, it } from 'vitest';
import { Response } from 'undici';
import { clientSecretBasic, createClientCredentialsSource, createRedactor } from '../src/index.ts';
import type { ClientCredentialsConfig, PinnedDeps, RuntimeRedactor } from '../src/index.ts';

// Token-cache unit tests with a FAKE clock and a fake undici fetch — the
// real pinnedRequest still runs, so the egress/redirect behaviour asserted
// here is the production transport's, not a reimplementation.

type Call = { url: string; headers: Record<string, string>; body: string };

const TOKEN_URL = 'https://auth.example.test/oauth/token';

const harness = (
  respond: (call: Call, index: number) => Response | Promise<Response>,
  overrides: Partial<ClientCredentialsConfig> = {},
) => {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const fetch: PinnedDeps['fetch'] = async (input, init) => {
    const raw = init?.body as Uint8Array | undefined;
    const call: Call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw === undefined ? '' : new TextDecoder().decode(raw),
    };
    calls.push(call);
    return await respond(call, calls.length - 1);
  };
  const transport: PinnedDeps = {
    fetch,
    resolve: () => Promise.reject(new Error('no DNS in this suite')),
    timeoutSignal: () => new AbortController().signal,
  };
  const redactor: RuntimeRedactor = overrides.redactor ?? createRedactor([]);
  const source = createClientCredentialsSource(
    {
      tokenUrl: new URL(TOKEN_URL),
      clientId: 'demo-client',
      clientSecret: 'example-token-not-a-secret',
      scopes: [],
      clientAuth: 'client_secret_basic',
      allowPrivateNetwork: false,
      timeoutMs: 5000,
      redactor,
      now: () => clock,
      ...overrides,
    },
    transport,
  );
  return {
    source,
    calls,
    redactor,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const tokenResponse = (token: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, ...extra });

const numbered = (_call: Call, index: number): Response =>
  tokenResponse(`access-token-number-${String(index + 1)}`);

describe('client-credentials token source — request shape', () => {
  it('POSTs grant_type=client_credentials with client_secret_basic (RFC 6749 §2.3.1 encoding)', async () => {
    const { source, calls } = harness(numbered, {
      clientId: 'id with space',
      clientSecret: 'p@ss:wörd/+=',
      scopes: ['read', 'write'],
    });
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-1' });
    expect(calls[0]?.url).toBe(TOKEN_URL);
    // Form-urlencoded BEFORE Base64: space -> "+", ":" -> "%3A", etc.
    const decoded = Buffer.from(
      (calls[0]?.headers['authorization'] ?? '').replace('Basic ', ''),
      'base64',
    ).toString('utf8');
    expect(decoded).toBe('id+with+space:p%40ss%3Aw%C3%B6rd%2F%2B%3D');
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      grant_type: 'client_credentials',
      scope: 'read write',
    });
  });

  it('client_secret_post puts the credentials in the body and sends no Authorization', async () => {
    const { source, calls } = harness(numbered, { clientAuth: 'client_secret_post' });
    await source.getToken();
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'demo-client',
      client_secret: 'example-token-not-a-secret',
    });
  });

  it('clientSecretBasic matches a plain Basic credential for unreserved characters', () => {
    expect(clientSecretBasic('abc', 'def')).toBe(
      `Basic ${Buffer.from('abc:def').toString('base64')}`,
    );
  });
});

describe('client-credentials token source — cache, refresh margin, single-flight', () => {
  it('reuses the cached token until the refresh margin (60 s for a long-lived token)', async () => {
    const { source, calls, advance } = harness(numbered);
    await source.getToken();
    advance(3_600_000 - 60_001);
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-1' });
    advance(1);
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-2' });
    expect(calls).toHaveLength(2);
  });

  it('uses 10 % of the lifetime as the margin when that is smaller (expires_in: 30)', async () => {
    const { source, calls, advance } = harness((_call, index) =>
      tokenResponse(`short-lived-token-${String(index)}`, { expires_in: 30 }),
    );
    await source.getToken();
    advance(26_999);
    await source.getToken();
    expect(calls).toHaveLength(1);
    advance(1);
    await source.getToken();
    expect(calls).toHaveLength(2);
  });

  it('accepts a numeric-string expires_in; without one, reuses for at most an hour', async () => {
    const stringy = harness(() => tokenResponse('string-lifetime-token', { expires_in: '120' }));
    await stringy.source.getToken();
    stringy.advance(107_999);
    await stringy.source.getToken();
    expect(stringy.calls).toHaveLength(1);
    const unknown = harness((_call, index) =>
      Response.json({ access_token: `no-expiry-token-${String(index)}`, token_type: 'bearer' }),
    );
    await unknown.source.getToken();
    unknown.advance(3_599_999);
    await unknown.source.getToken();
    expect(unknown.calls).toHaveLength(1);
    unknown.advance(1);
    await unknown.source.getToken();
    expect(unknown.calls).toHaveLength(2);
  });

  it('N concurrent callers share ONE in-flight token request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { source, calls } = harness(async (call, index) => {
      await gate;
      return numbered(call, index);
    });
    const pending = Array.from({ length: 10 }, async () => await source.getToken());
    release?.();
    const results = await Promise.all(pending);
    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(
      new Set([JSON.stringify({ ok: 'access-token-number-1' })]),
    );
    expect(calls).toHaveLength(1);
  });

  it('invalidate drops the cached token; a stale token is ignored', async () => {
    const { source, calls } = harness(numbered);
    await source.getToken();
    source.invalidate('access-token-number-1');
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-2' });
    // A late 401 for the OLD token must not discard the fresh one.
    source.invalidate('access-token-number-1');
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-2' });
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failure: the next call tries again', async () => {
    const { source, calls } = harness((call, index) =>
      index === 0 ? new Response('down', { status: 503 }) : numbered(call, index),
    );
    expect(await source.getToken()).toEqual({
      error: 'could not obtain an OAuth2 access token: the token endpoint answered HTTP 503',
    });
    expect(await source.getToken()).toEqual({ ok: 'access-token-number-2' });
    expect(calls).toHaveLength(2);
  });
});

describe('client-credentials token source — redaction', () => {
  it('registers every issued token with the redactor before returning it', async () => {
    const { source, redactor } = harness(numbered);
    const result = await source.getToken();
    expect(result).toEqual({ ok: 'access-token-number-1' });
    expect(redactor.redactString('echo access-token-number-1 back')).toBe('echo [redacted] back');
    expect(redactor.scanForSecret({ nested: ['access-token-number-1'] })).toBe(true);
  });

  it('fails closed (never returns the token) when it cannot be registered', async () => {
    // "da" is a substring of the "[redacted]" marker: unredactable.
    const { source } = harness(() => tokenResponse('da'));
    expect(await source.getToken()).toEqual({
      error:
        'could not obtain an OAuth2 access token: the access token could not be registered for redaction',
    });
  });
});

describe('client-credentials token source — response validation', () => {
  const errorOf = async (response: () => Response): Promise<string> => {
    const { source } = harness(response);
    const result = await source.getToken();
    return 'error' in result ? result.error : 'unexpectedly ok';
  };

  it('names a registered RFC 6749 §5.2 error code, never the description', async () => {
    const message = await errorOf(() =>
      Response.json(
        { error: 'invalid_client', error_description: 'secret example-token-not-a-secret' },
        { status: 401 },
      ),
    );
    expect(message).toBe(
      'could not obtain an OAuth2 access token: the token endpoint answered HTTP 401 (invalid_client)',
    );
  });

  it('drops an unregistered (attacker-chosen) error code', async () => {
    const message = await errorOf(() =>
      Response.json({ error: 'click http://evil.example' }, { status: 400 }),
    );
    expect(message).toBe(
      'could not obtain an OAuth2 access token: the token endpoint answered HTTP 400',
    );
  });

  it('rejects a non-Bearer token type, a missing/invalid token and a non-JSON body', async () => {
    expect(await errorOf(() => tokenResponse('mac-token-value', { token_type: 'mac' }))).toContain(
      'not a Bearer token',
    );
    expect(await errorOf(() => Response.json({ token_type: 'bearer' }))).toContain(
      'no valid access_token',
    );
    expect(await errorOf(() => tokenResponse('line\r\nbreak-injection'))).toContain(
      'no valid access_token',
    );
    expect(await errorOf(() => new Response('<html>', { status: 200 }))).toContain(
      'not a JSON object',
    );
  });

  it('never follows a redirect from the token endpoint', async () => {
    const { source, calls } = harness(
      () => new Response(null, { status: 307, headers: { location: 'https://evil.example/t' } }),
    );
    expect(await source.getToken()).toEqual({
      error:
        'could not obtain an OAuth2 access token: the token endpoint redirected, which is never followed',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('client-credentials token source — egress policy', () => {
  it('refuses a cloud-metadata token URL even with allowPrivateNetwork', async () => {
    const { source, calls } = harness(numbered, {
      tokenUrl: new URL('http://169.254.169.254/latest/token'),
      allowPrivateNetwork: true,
    });
    expect(await source.getToken()).toEqual({
      error:
        'could not obtain an OAuth2 access token: the token endpoint address is not allowed by the egress policy',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a private token URL unless allowPrivateNetwork', async () => {
    const denied = harness(numbered, { tokenUrl: new URL('https://10.0.0.5/token') });
    expect(await denied.source.getToken()).toHaveProperty('error');
    expect(denied.calls).toHaveLength(0);
    const allowed = harness(numbered, {
      tokenUrl: new URL('https://10.0.0.5/token'),
      allowPrivateNetwork: true,
    });
    expect(await allowed.source.getToken()).toEqual({ ok: 'access-token-number-1' });
  });
});

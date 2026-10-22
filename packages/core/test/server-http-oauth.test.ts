import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthResourceServer } from '../src/index.ts';
import type {
  PinnedDeps,
  OAuthDecision,
  OAuthResourceServer,
  OAuthResourceServerConfig,
} from '../src/index.ts';
import { loopbackTransport, makeKey, signJwt, startIssuer } from './helpers/oauth-issuer.ts';
import type { IssuerOptions, TestIssuer, TestKey } from './helpers/oauth-issuer.ts';

const AUDIENCE = 'https://mcp.example.test/mcp';
const METADATA_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';

// A settable clock: every cache decision below is driven by it, never by
// sleeping.
type Clock = { now: () => number; advance: (ms: number) => void };
const makeClock = (startMs = 1_800_000_000_000): Clock => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

type Fixture = {
  issuer: TestIssuer;
  clock: Clock;
  server: OAuthResourceServer;
  // Authenticates a fresh token signed with `key`, carrying `over` claims.
  authWith: (key: TestKey, over?: Record<string, unknown>) => Promise<OAuthDecision>;
  // Key-set notices the server reported (deps.warn).
  warnings: string[];
};

describe('createOAuthResourceServer', () => {
  const issuers: TestIssuer[] = [];
  afterEach(async () => {
    await Promise.all(issuers.splice(0).map((issuer) => issuer.close()));
  });

  const issue = async (keys: readonly TestKey[], options: IssuerOptions = {}) => {
    const issuer = await startIssuer(keys, options);
    issuers.push(issuer);
    return issuer;
  };

  const build = (
    issuer: TestIssuer,
    clock: Clock,
    over: Partial<OAuthResourceServerConfig> = {},
    warnings: string[] = [],
  ): Promise<OAuthResourceServer> =>
    createOAuthResourceServer(
      {
        issuer: issuer.issuer,
        audience: AUDIENCE,
        requiredScopes: ['mcp:tools'],
        allowPrivateNetwork: false,
        timeoutMs: 5000,
        ...over,
      },
      {
        transport: loopbackTransport,
        now: clock.now,
        warn: (message) => {
          warnings.push(message);
        },
      },
    );

  const fixture = async (
    keys: readonly TestKey[],
    over: Partial<OAuthResourceServerConfig> = {},
  ): Promise<Fixture> => {
    const issuer = await issue(keys);
    const clock = makeClock();
    const warnings: string[] = [];
    const server = await build(issuer, clock, over, warnings);
    const authWith = (key: TestKey, claims: Record<string, unknown> = {}) => {
      const token = signJwt(key, {
        iss: issuer.issuer,
        aud: AUDIENCE,
        sub: 'user-1',
        scope: 'mcp:tools',
        exp: clock.now() / 1000 + 300,
        ...claims,
      });
      return server.authenticate(`Bearer ${token}`);
    };
    return { issuer, clock, server, authWith, warnings };
  };

  describe('discovery', () => {
    it('finds RFC 8414 metadata by path insertion for an issuer with a path, and publishes RFC 9728 metadata', async () => {
      const issuer = await issue([makeKey('ES256', 'k1')], { path: '/tenant1' });
      const server = await build(issuer, makeClock());
      expect(issuer.metadataPaths()).toStrictEqual([
        '/.well-known/oauth-authorization-server/tenant1',
      ]);
      expect(server.metadataPath).toBe('/.well-known/oauth-protected-resource/mcp');
      expect(server.publicHost).toBe('mcp.example.test');
      expect(server.metadataDocument).toStrictEqual({
        resource: AUDIENCE,
        authorization_servers: [issuer.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:tools'],
      });
    });

    it('falls back to OpenID Connect discovery in the order the MCP spec prescribes', async () => {
      const issuer = await issue([makeKey('RS256', 'k1')], { path: '/realm', style: 'oidc' });
      await build(issuer, makeClock());
      expect(issuer.metadataPaths()).toStrictEqual([
        '/.well-known/oauth-authorization-server/realm',
        '/.well-known/openid-configuration/realm',
      ]);
    });

    it('refuses metadata whose issuer differs from the configured one (RFC 8414 §3.3)', async () => {
      const issuer = await issue([makeKey('RS256', 'k1')], {
        advertisedIssuer: 'https://evil.example.test',
      });
      await expect(build(issuer, makeClock())).rejects.toThrow(/issuer does not match/u);
    });

    it('refuses metadata without a jwks_uri, and a JWKS with no usable key', async () => {
      const noJwks = await issue([makeKey('RS256', 'k1')], { omitJwksUri: true });
      await expect(build(noJwks, makeClock())).rejects.toThrow(/no jwks_uri/u);
      const empty = await issue([]);
      await expect(build(empty, makeClock())).rejects.toThrow(/usable JWKS/u);
    });

    it('applies the egress policy to a jwks_uri on another origin: a private address is denied without --allow-private-network', async () => {
      const keyHost = await issue([makeKey('RS256', 'k1')]);
      const issuer = await issue([makeKey('RS256', 'k1')], { jwksUri: `${keyHost.issuer}/jwks` });
      await expect(build(issuer, makeClock())).rejects.toThrow(/egress/u);
      await expect(
        build(issuer, makeClock(), { allowPrivateNetwork: true }),
      ).resolves.toBeDefined();
    });

    it('accepts a jwks_uri with a query string and fetches exactly that URL', async () => {
      const issuer = await issue([makeKey('RS256', 'k1')], { jwksQuery: '?keyset=signing' });
      await build(issuer, makeClock());
      expect(issuer.jwksRequests()).toStrictEqual(['/jwks?keyset=signing']);
    });

    it('still refuses a jwks_uri with credentials or a fragment', async () => {
      const issuer = await issue([makeKey('RS256', 'k1')], { jwksQuery: '#keys' });
      await expect(build(issuer, makeClock())).rejects.toThrow(/fragment/u);
    });

    describe('over https (injected transport)', () => {
      const ISSUER = 'https://auth.example.test/realm';
      const key = makeKey('ES256', 'k1');
      // A fake fetch answering https URLs; records every request it sees.
      const httpsTransport = (
        jwksUri: string,
        routes: Record<string, () => Response>,
      ): { transport: PinnedDeps; requested: string[] } => {
        const requested: string[] = [];
        const json = (body: unknown): Response => Response.json(body);
        const all: Record<string, () => Response> = {
          'https://auth.example.test/.well-known/oauth-authorization-server/realm': () =>
            json({ issuer: ISSUER, jwks_uri: jwksUri }),
          ...routes,
        };
        const fakeFetch = (input: URL): Promise<Response> => {
          requested.push(input.href);
          return Promise.resolve(all[input.href]?.() ?? new Response('', { status: 404 }));
        };
        return {
          requested,
          transport: {
            fetch: fakeFetch as unknown as PinnedDeps['fetch'],
            resolve: () => Promise.resolve(['93.184.216.34']),
            timeoutSignal: (ms) => AbortSignal.timeout(ms),
          },
        };
      };
      const create = (transport: PinnedDeps) =>
        createOAuthResourceServer(
          {
            issuer: ISSUER,
            audience: AUDIENCE,
            requiredScopes: [],
            allowPrivateNetwork: false,
            timeoutMs: 5000,
          },
          { transport, now: () => 0 },
        );

      it('fetches an Entra-style jwks_uri with its query intact', async () => {
        const jwksUri = 'https://auth.example.test/keys?appid=abc';
        const { transport, requested } = httpsTransport(jwksUri, {
          [jwksUri]: () => Response.json({ keys: [key.publicJwk] }),
        });
        await expect(create(transport)).resolves.toBeDefined();
        expect(requested.at(-1)).toBe(jwksUri);
      });

      it('refuses a JWKS redirect to cleartext http on every hop', async () => {
        const jwksUri = 'https://auth.example.test/keys';
        const { transport, requested } = httpsTransport(jwksUri, {
          [jwksUri]: () =>
            new Response('', {
              status: 302,
              headers: { location: 'http://auth.example.test/keys' },
            }),
        });
        await expect(create(transport)).rejects.toThrow(/egress.*not https/u);
        expect(requested).not.toContain('http://auth.example.test/keys');
      });
    });

    it.each([
      ['an http issuer on a non-loopback host', { issuer: 'http://auth.example.test' }, /https/u],
      ['an audience with a fragment', { audience: `${AUDIENCE}#x` }, /fragment/u],
      ['a relative audience', { audience: '/mcp' }, /absolute URL/u],
    ] as const)('rejects %s as a usage error', async (_label, over, message) => {
      const issuer = await issue([makeKey('RS256', 'k1')]);
      await expect(build(issuer, makeClock(), over)).rejects.toThrow(message);
    });
  });

  describe('authenticate', () => {
    it('answers a request without a token with 401 and the resource_metadata challenge (no error code)', async () => {
      const { server } = await fixture([makeKey('RS256', 'k1')]);
      expect(await server.authenticate()).toStrictEqual({
        outcome: 'deny',
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${METADATA_URL}", scope="mcp:tools"`,
        },
        body: '',
      });
      const basic = await server.authenticate('Basic dXNlcjpwYXNz');
      expect(basic).toMatchObject({ status: 401 });
    });

    it('answers an invalid token with 401 invalid_token, never echoing the token', async () => {
      const key = makeKey('RS256', 'k1');
      const { issuer, clock, server } = await fixture([key]);
      const token = signJwt(key, {
        iss: issuer.issuer,
        aud: 'https://other.example.test',
        exp: clock.now() / 1000 + 300,
      });
      const decision = await server.authenticate(`Bearer ${token}`);
      expect(decision).toMatchObject({
        outcome: 'deny',
        status: 401,
        reason: 'token rejected: aud does not name this resource',
        headers: {
          'www-authenticate': `Bearer error="invalid_token", error_description="The access token is invalid or expired", resource_metadata="${METADATA_URL}", scope="mcp:tools"`,
        },
      });
      expect(JSON.stringify(decision)).not.toContain(token);
    });

    it('answers a valid token lacking a required scope with 403 insufficient_scope', async () => {
      const key = makeKey('RS256', 'k1');
      const { authWith } = await fixture([key], { requiredScopes: ['mcp:tools', 'mcp:admin'] });
      expect(await authWith(key)).toMatchObject({
        outcome: 'deny',
        status: 403,
        reason: 'token lacks scope mcp:admin',
        headers: {
          'www-authenticate': `Bearer error="insufficient_scope", error_description="The access token lacks a required scope", resource_metadata="${METADATA_URL}", scope="mcp:tools mcp:admin"`,
        },
      });
    });

    it('allows a valid token and omits the scope parameter when no scope is required', async () => {
      const key = makeKey('EdDSA', 'k1');
      const { server, authWith } = await fixture([key], { requiredScopes: [] });
      expect(await authWith(key)).toMatchObject({ outcome: 'allow', token: { subject: 'user-1' } });
      expect(server.metadataDocument).not.toHaveProperty('scopes_supported');
      const missing = await server.authenticate();
      expect(missing).toMatchObject({
        headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA_URL}"` },
      });
    });
  });

  describe('JWKS cache', () => {
    it('fetches the JWKS once and serves later verifications from the cache until the TTL', async () => {
      const key = makeKey('RS256', 'k1');
      const { issuer, clock, authWith } = await fixture([key]);
      const results = await Promise.all([authWith(key), authWith(key), authWith(key)]);
      expect(results.map((result) => result.outcome)).toStrictEqual(['allow', 'allow', 'allow']);
      expect(issuer.jwksFetches()).toBe(1);
      clock.advance(300_000);
      // Stale-while-revalidate: answered from the cache, refreshed behind.
      expect(await authWith(key)).toMatchObject({ outcome: 'allow' });
      await vi.waitFor(() => expect(issuer.jwksFetches()).toBe(2));
    });

    it('after the TTL with a failing authorization server: junk bearers cause no fetch, valid tokens at most one per cooldown, and nobody waits', async () => {
      const key = makeKey('RS256', 'k1');
      const { issuer, clock, server, authWith, warnings } = await fixture([key]);
      issuer.failJwks(500);
      clock.advance(360_000);
      const junk = await Promise.all(
        Array.from({ length: 20 }, () => server.authenticate('Bearer garbage')),
      );
      expect(junk.every((decision) => decision.outcome === 'deny')).toBe(true);
      expect(issuer.jwksFetches()).toBe(1);
      for (let round = 0; round < 3; round += 1) {
        // Twenty requests 100 ms apart, all served from the last good set.
        for (let index = 0; index < 20; index += 1) {
          expect(await authWith(key)).toMatchObject({ outcome: 'allow' });
          clock.advance(100);
        }
        await vi.waitFor(() => expect(issuer.jwksFetches()).toBe(2 + round));
        clock.advance(30_000 - 2000);
      }
      await vi.waitFor(() => expect(warnings).toHaveLength(3));
      expect(warnings[0]).toMatch(/JWKS refresh failed \(.*HTTP 500\); still using the key set/u);
    });

    it('keeps the last good set when a refresh yields no usable key, but honours an empty set as revocation', async () => {
      const key = makeKey('RS256', 'k1');
      const { issuer, clock, authWith, warnings } = await fixture([key]);
      const encOnly = makeKey('RS256', 'enc');
      issuer.setKeys([{ ...encOnly, publicJwk: { ...encOnly.publicJwk, use: 'enc' } }]);
      clock.advance(300_000);
      await authWith(key);
      await vi.waitFor(() => expect(warnings).toHaveLength(1));
      expect(warnings[0]).toMatch(/no usable signing key/u);
      expect(await authWith(key)).toMatchObject({ outcome: 'allow' });

      issuer.setKeys([]);
      clock.advance(30_000);
      await authWith(key);
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(warnings[1]).toMatch(/EMPTY JWKS.*every access token is rejected/u);
      expect(await authWith(key)).toMatchObject({
        status: 401,
        reason: 'token rejected: kid not in the JWKS',
      });
    });

    it('refetches once for an unknown kid (key rotation), then rate-limits further refetches', async () => {
      const oldKey = makeKey('RS256', 'old');
      const newKey = makeKey('RS256', 'new');
      const { issuer, clock, authWith } = await fixture([oldKey]);
      issuer.setKeys([oldKey, newKey]);
      clock.advance(30_000);
      expect(await authWith(newKey)).toMatchObject({ outcome: 'allow' });
      expect(issuer.jwksFetches()).toBe(2);
      // Made-up kids within the cooldown never reach the authorization server.
      const bogus = makeKey('RS256', 'bogus');
      const rejected = await Promise.all([authWith(bogus), authWith(bogus), authWith(bogus)]);
      expect(rejected.map((result) => result.outcome === 'deny' && result.reason)).toStrictEqual(
        Array.from({ length: 3 }, () => 'token rejected: kid not in the JWKS'),
      );
      expect(issuer.jwksFetches()).toBe(2);
    });

    it('keeps the last good key set when a refresh fails, then fails closed with 503 once it is an hour old', async () => {
      const key = makeKey('RS256', 'k1');
      const { issuer, clock, authWith } = await fixture([key]);
      issuer.failJwks(500);
      clock.advance(600_000);
      expect(await authWith(key)).toMatchObject({ outcome: 'allow' });
      clock.advance(3_000_000);
      expect(await authWith(key)).toMatchObject({
        outcome: 'deny',
        status: 503,
        reason: 'the authorization server JWKS could not be refreshed',
      });
      issuer.failJwks();
      clock.advance(30_000);
      expect(await authWith(key)).toMatchObject({ outcome: 'allow' });
    });

    it('drops a rotated-out key on refresh: a token signed with it is rejected afterwards', async () => {
      const oldKey = makeKey('RS256', 'old');
      const { issuer, clock, authWith } = await fixture([oldKey]);
      issuer.setKeys([makeKey('RS256', 'new')]);
      clock.advance(300_000);
      await authWith(oldKey);
      await vi.waitFor(() => expect(issuer.jwksFetches()).toBe(2));
      await vi.waitFor(async () => expect(await authWith(oldKey)).toMatchObject({ status: 401 }));
    });
  });
});

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { parseJwks, verifyJwt } from '../src/index.ts';
import type { KeySet } from '../src/index.ts';
import {
  forgeHs256WithPublicKey,
  makeKey,
  signJwt,
  signWith,
  unsignedJwt,
} from './helpers/oauth-issuer.ts';
import type { TestKey } from './helpers/oauth-issuer.ts';

const ISSUER = 'https://auth.example.test/tenant1';
const AUDIENCE = 'https://mcp.example.test/mcp';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const rsa = makeKey('RS256', 'rsa-1');
const ec = makeKey('ES256', 'ec-1');
const keys: KeySet = new Map([rsa, ec].map((key) => [key.kid, key.publicJwk]));
const opts = { issuer: ISSUER, audience: AUDIENCE, nowMs: NOW_MS };

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'user-1',
      client_id: 'client-1',
      scope: 'mcp:tools other',
      iat: NOW_S - 10,
      exp: NOW_S + 300,
      ...over,
    }).filter(([, value]) => value !== undefined),
  );

const reasonOf = (token: string, keySet: KeySet = keys): string => {
  const result = verifyJwt(token, keySet, opts);
  return result.ok ? 'ok' : result.reason;
};
// The verdict for an RS256 token with these claim and header overrides.
const verdict = (over: Record<string, unknown>, header: Record<string, unknown> = {}): string =>
  reasonOf(signJwt(rsa, claims(over), header));

describe('verifyJwt — accepted tokens', () => {
  it.each(['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA'] as const)(
    'accepts a well-formed %s access token and exposes its subject, client and scopes',
    (alg) => {
      const key = makeKey(alg, `k-${alg}`);
      const result = verifyJwt(signJwt(key, claims()), new Map([[key.kid, key.publicJwk]]), opts);
      expect(result).toStrictEqual({
        ok: true,
        token: {
          subject: 'user-1',
          clientId: 'client-1',
          scopes: ['mcp:tools', 'other'],
          expiresAt: NOW_S + 300,
        },
      });
    },
  );

  it('accepts typ JWT, application/at+jwt or no typ at all, and an aud array naming this resource', () => {
    expect(verdict({}, { typ: 'JWT' })).toBe('ok');
    expect(verdict({}, { typ: 'application/at+jwt' })).toBe('ok');
    expect(verdict({}, { typ: undefined })).toBe('ok');
    expect(verdict({ aud: ['https://other.example', AUDIENCE] })).toBe('ok');
  });

  it('compares the audience as a resource URI: a trailing slash and upper-case scheme/host still match', () => {
    expect(verdict({ aud: `${AUDIENCE}/` })).toBe('ok');
    expect(verdict({ aud: 'HTTPS://MCP.EXAMPLE.TEST/mcp' })).toBe('ok');
  });

  it('tolerates 60 s of clock skew on exp and nbf, and no more', () => {
    expect(verdict({ exp: NOW_S - 59 })).toBe('ok');
    expect(verdict({ exp: NOW_S - 60 })).toBe('expired');
    expect(verdict({ nbf: NOW_S + 59 })).toBe('ok');
    expect(verdict({ nbf: NOW_S + 61 })).toBe('not-yet-valid');
  });
});

describe('verifyJwt — rejected tokens', () => {
  const other = makeKey('RS256', 'rsa-1');
  const tampered = (): string => {
    const [header, , signature] = signJwt(rsa, claims()).split('.');
    const payload = Buffer.from(JSON.stringify(claims({ scope: 'admin' }))).toString('base64url');
    return `${String(header)}.${payload}.${String(signature)}`;
  };

  it.each<[string, () => string, string]>([
    [
      'wrong aud',
      () => signJwt(rsa, claims({ aud: 'https://other.example.test/mcp' })),
      'wrong-audience',
    ],
    ['aud missing', () => signJwt(rsa, claims({ aud: undefined })), 'wrong-audience'],
    [
      'aud of a sibling path',
      () => signJwt(rsa, claims({ aud: `${AUDIENCE}/x` })),
      'wrong-audience',
    ],
    ['wrong iss', () => signJwt(rsa, claims({ iss: 'https://evil.example.test' })), 'wrong-issuer'],
    [
      'iss differing only by a trailing slash',
      () => signJwt(rsa, claims({ iss: `${ISSUER}/` })),
      'wrong-issuer',
    ],
    ['expired', () => signJwt(rsa, claims({ exp: NOW_S - 3600 })), 'expired'],
    ['no exp', () => signJwt(rsa, claims({ exp: undefined })), 'missing-exp'],
    ['non-numeric exp', () => signJwt(rsa, claims({ exp: String(NOW_S + 300) })), 'missing-exp'],
    ['nbf in the future', () => signJwt(rsa, claims({ nbf: NOW_S + 3600 })), 'not-yet-valid'],
    ['iat in the future', () => signJwt(rsa, claims({ iat: NOW_S + 3600 })), 'issued-in-future'],
    ['alg none (unsigned)', () => unsignedJwt(rsa.kid, claims()), 'unsupported-alg'],
    ['alg none with a signature', () => signJwt(rsa, claims(), { alg: 'none' }), 'unsupported-alg'],
    [
      'HS256 signed with the public key (algorithm confusion)',
      () => forgeHs256WithPublicKey(rsa, claims()),
      'unsupported-alg',
    ],
    [
      'an alg outside the allowlist',
      () => signJwt(rsa, claims(), { alg: 'RS1' }),
      'unsupported-alg',
    ],
    ['unknown kid', () => signJwt(rsa, claims(), { kid: 'rotated-away' }), 'unknown-kid'],
    ['no kid', () => signJwt(rsa, claims(), { kid: undefined }), 'missing-kid'],
    [
      'an RS256 header naming an EC key',
      () => signJwt(rsa, claims(), { kid: ec.kid }),
      'key-mismatch',
    ],
    ['a payload altered after signing', tampered, 'bad-signature'],
    [
      'a signature from another key under the same kid',
      () => signJwt(other, claims()),
      'bad-signature',
    ],
    ['a crit header', () => signJwt(rsa, claims(), { crit: ['exp'] }), 'crit'],
    [
      'typ of another token kind',
      () => signJwt(rsa, claims(), { typ: 'dpop+jwt' }),
      'unsupported-typ',
    ],
    ['two segments', () => signJwt(rsa, claims()).split('.').slice(0, 2).join('.'), 'malformed'],
    ['a non-base64url segment', () => `${signJwt(rsa, claims())}!`, 'malformed'],
    [
      'a non-JSON header',
      () => `bm90LWpzb24.${signJwt(rsa, claims()).split('.').slice(1).join('.')}`,
      'malformed',
    ],
    ['an oversized token', () => signJwt(rsa, claims({ pad: 'x'.repeat(20_000) })), 'malformed'],
  ])('rejects %s', (_label, makeToken, reason) => {
    expect(reasonOf(makeToken())).toBe(reason);
  });

  it('rejects a key whose own alg, use or key_ops disagree with the token', () => {
    const pinned = (extra: Record<string, unknown>): KeySet =>
      new Map([[rsa.kid, { ...rsa.publicJwk, ...extra }]]);
    const token = signJwt(rsa, claims());
    expect(reasonOf(token, pinned({ alg: 'RS512' }))).toBe('key-mismatch');
    expect(reasonOf(token, pinned({ use: 'enc' }))).toBe('key-mismatch');
    expect(reasonOf(token, pinned({ key_ops: ['encrypt'] }))).toBe('key-mismatch');
    expect(reasonOf(token, pinned({ alg: 'RS256', use: 'sig', key_ops: ['verify'] }))).toBe('ok');
  });

  it('rejects an RSA key shorter than 2048 bits even when the signature verifies', () => {
    const weak: TestKey = makeKey('RS256', 'weak', 1024);
    const weakSet: KeySet = new Map([[weak.kid, weak.publicJwk]]);
    const token = signJwt(weak, claims());
    expect(reasonOf(token, weakSet)).toBe('key-mismatch');
  });

  it('never verifies with private key material a JWKS wrongly publishes', () => {
    const exported = rsa.privateKey.export({ format: 'jwk' });
    const leaked = { ...exported };
    const token = signJwt(rsa, claims());
    expect(reasonOf(token, new Map([[rsa.kid, { ...leaked, kid: rsa.kid }]]))).toBe('ok');
  });

  it('treats an unparseable signature as a failed verification, not an exception', () => {
    const [header, payload] = signJwt(ec, claims()).split('.');
    expect(reasonOf(`${String(header)}.${String(payload)}.${signWith(ec, 'x').slice(0, 10)}`)).toBe(
      'bad-signature',
    );
  });
});

describe('parseJwks', () => {
  it('indexes keys by kid and drops kid-less, malformed and ambiguous entries', () => {
    const parsed = parseJwks({
      keys: [
        rsa.publicJwk,
        { ...ec.publicJwk, kid: undefined },
        'not-a-key',
        { ...ec.publicJwk, kid: 'dup' },
        { ...rsa.publicJwk, kid: 'dup' },
      ],
    });
    expect([...(parsed?.keys() ?? [])]).toStrictEqual([rsa.kid]);
  });

  it('refuses documents that are not a JWKS and caps the number of keys read', () => {
    expect(parseJwks([])).toBeUndefined();
    expect(parseJwks({ keys: 'x' })).toBeUndefined();
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      ...rsa.publicJwk,
      kid: `k${String(index)}`,
    }));
    expect(parseJwks({ keys: many })?.size).toBe(32);
  });
});

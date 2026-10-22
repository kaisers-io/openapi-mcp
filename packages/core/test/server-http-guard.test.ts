import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  evaluateRequest,
  extractBearerToken,
  isValidBearerToken,
} from '../src/index.ts';
import type { RequestGuardOptions } from '../src/index.ts';

// Both TOKEN and OTHER_TOKEN are 43 unpadded Base64URL characters that
// decode to EXACTLY 32 bytes (256 bits) — verified: `Buffer.from('A'.repeat(43),
// 'base64').length === 32`. The token grammar requires an ACTUAL 32-byte
// decode, not just ">=32 characters" (see the isValidBearerToken tests
// below), so every fixture in this file must be a real, decodable token.
const TOKEN = 'A'.repeat(43);
const OTHER_TOKEN = 'B'.repeat(43);

const opts: RequestGuardOptions = {
  allowedOrigins: new Set(['https://allowed.example']),
  allowedHost: '127.0.0.1:3044',
  bearer: { configuredToken: TOKEN },
};

const headers = (over: Partial<{ host: string; origin: string; authorization: string }> = {}) => ({
  host: over.host,
  origin: over.origin,
  authorization: over.authorization,
});

describe('isValidBearerToken', () => {
  it('accepts 43 unpadded Base64URL characters that decode to exactly 32 bytes (256 bits)', () => {
    expect(isValidBearerToken('A'.repeat(43))).toBe(true);
    expect(isValidBearerToken(`${'a1_-'.repeat(10)}aaa`)).toBe(true); // 43 chars, mixed base64url alphabet
  });

  it('accepts a 44-character PADDED standard Base64 token — the literal shape of `openssl rand -base64 32`', () => {
    // A real `openssl rand -base64 32` sample (32 random bytes, standard
    // Base64, one trailing '=' — verified against a live `openssl` run
    // during planning): exactly the shape the README's example command
    // produces, which the OLD ">=32 chars" grammar rejected outright.
    expect(isValidBearerToken('WYict4Op6AfC3OUC1GZwECUpTtD/ax6qk0+Bzly5eUY=')).toBe(true);
  });

  it('rejects a token that is the right LENGTH but does not decode to 32 bytes (256 bits) — 192-bit tokens no longer pass', () => {
    // 32 Base64 characters (the OLD grammar's minimum) decode to only 24
    // bytes (192 bits) — this is exactly the gap the "256-bit" claim
    // elsewhere in the design was contradicting before this fix.
    expect(isValidBearerToken('A'.repeat(32))).toBe(false);
    expect(isValidBearerToken('A'.repeat(42))).toBe(false); // 31 decoded bytes
    expect(isValidBearerToken('A'.repeat(44))).toBe(false); // Unpadded 44 chars decodes to 33 bytes, not 32
  });

  it('rejects a short or non-base64 token', () => {
    expect(isValidBearerToken('short')).toBe(false);
    expect(isValidBearerToken('!'.repeat(43))).toBe(false);
  });

  // The shapes docs/security.md lists as rejected: each one satisfies the old ">=32 Base64
  // characters" prose, so these pin the documented rule to the validator.
  it.each([
    ['hex, the shape of `openssl rand -hex 32` (64 chars, 32 bytes as hex)', 'ab'.repeat(32)],
    ['padded Base64 of 48 bytes, the shape of `openssl rand -base64 48`', 'A'.repeat(64)],
    ['44 chars with double padding', `${'A'.repeat(42)}==`],
    ['44 chars, Base64URL alphabet with padding', `${'A'.repeat(42)}_=`],
    ['43 chars unpadded, standard alphabet (+)', `${'A'.repeat(42)}+`],
    ['43 chars unpadded, standard alphabet (/)', `${'A'.repeat(42)}/`],
    ['43 chars padded to 44 with a trailing newline', `${'A'.repeat(43)}\n`],
    ['valid 44-char token with a trailing newline', `${'A'.repeat(43)}=\n`],
    ['valid 43-char token with surrounding spaces', ` ${'A'.repeat(43)} `],
  ])('rejects %s', (_label, token) => {
    expect(isValidBearerToken(token)).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('is true for equal strings and false for different ones, never throwing on unequal length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'nonempty')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed Bearer header', () => {
    expect(extractBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it('is case-insensitive on the scheme (RFC 7235 §2.1) and tolerates 1*SP before the credential', () => {
    expect(extractBearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractBearerToken(`Bearer  ${TOKEN}`)).toBe(TOKEN); // Two spaces
  });

  it('returns undefined for an absent, malformed, or wrong-scheme header', () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- authorizationHeader is a required (non-optional) parameter; dropping the argument changes call arity and fails to type-check (TS2554)
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken(`Bearer ${TOKEN} extra`)).toBeUndefined();
  });

  it('rejects leading/trailing whitespace and non-SP separators — fail-closed', () => {
    expect(extractBearerToken(` Bearer ${TOKEN}`)).toBeUndefined(); // Leading space
    expect(extractBearerToken(`Bearer ${TOKEN} `)).toBeUndefined(); // Trailing space
    // HTAB separator, built at runtime (never typed literally): `\S+`'s
    // token match would still find `TOKEN`, but the `+` quantifier only
    // matches SP (0x20) characters, not HTAB (0x09) — so this is rejected.
    const htab = String.fromCodePoint(9);
    expect(extractBearerToken(`Bearer${htab}${TOKEN}`)).toBeUndefined();
  });

  it('rejects a trailing line terminator — the `$` anchor requires actual end-of-input, not end-of-line', () => {
    // Built at runtime (never typed/pasted raw): a regex using the `m` flag,
    // or one that otherwise matched before a trailing newline, would extract
    // TOKEN here instead of failing closed.
    const lf = String.fromCodePoint(10);
    const cr = String.fromCodePoint(13);
    const crlf = String.fromCodePoint(13, 10);
    expect(extractBearerToken(`Bearer ${TOKEN}${lf}`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${TOKEN}${cr}`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${TOKEN}${crlf}`)).toBeUndefined();
  });
});

describe('evaluateRequest — the Host/Origin/bearer matrix', () => {
  it('403s a missing or wrong Host BEFORE inspecting the bearer at all', () => {
    const decision = evaluateRequest(opts, headers({ host: 'evil.example:3044' }));
    expect(decision).toEqual({
      outcome: 'deny',
      status: 403,
      reason: 'invalid or missing Host header',
    });
  });

  it('403s a present, non-allowlisted Origin BEFORE the bearer, even with a valid bearer', () => {
    const decision = evaluateRequest(
      opts,
      headers({
        host: opts.allowedHost,
        origin: 'https://evil.example',
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(decision).toEqual({ outcome: 'deny', status: 403, reason: 'Origin not allowlisted' });
  });

  it('403s the literal Origin: null the same as any other non-allowlisted Origin', () => {
    const decision = evaluateRequest(
      opts,
      headers({ host: opts.allowedHost, origin: 'null', authorization: `Bearer ${TOKEN}` }),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.outcome === 'deny' && decision.status).toBe(403);
  });

  it('401s an absent Origin with a missing bearer', () => {
    const decision = evaluateRequest(opts, headers({ host: opts.allowedHost }));
    expect(decision).toEqual({
      outcome: 'deny',
      status: 401,
      reason: 'missing or invalid bearer token',
    });
  });

  it('401s an absent Origin with a wrong bearer', () => {
    const decision = evaluateRequest(
      opts,
      headers({ host: opts.allowedHost, authorization: `Bearer ${OTHER_TOKEN}` }),
    );
    expect(decision.outcome === 'deny' && decision.status).toBe(401);
  });

  it('allows an absent Origin with a valid bearer', () => {
    expect(
      evaluateRequest(opts, headers({ host: opts.allowedHost, authorization: `Bearer ${TOKEN}` })),
    ).toEqual({
      outcome: 'allow',
    });
  });

  it('allows an allowlisted Origin with a valid bearer', () => {
    const decision = evaluateRequest(
      opts,
      headers({
        host: opts.allowedHost,
        origin: 'https://allowed.example',
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('403s an empty allowlist for ANY present Origin (no browser use configured)', () => {
    const noOriginOpts: RequestGuardOptions = { ...opts, allowedOrigins: new Set() };
    const decision = evaluateRequest(
      noOriginOpts,
      headers({
        host: opts.allowedHost,
        origin: 'https://allowed.example',
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(decision.outcome === 'deny' && decision.status).toBe(403);
  });

  it('treats a duplicated Origin header (array of length !== 1) as present-and-invalid, not silently picked', () => {
    const decision = evaluateRequest(opts, {
      host: opts.allowedHost,
      origin: ['https://allowed.example', 'https://evil.example'],
      authorization: `Bearer ${TOKEN}`,
    });
    expect(decision.outcome === 'deny' && decision.status).toBe(403);
  });

  it('treats a duplicated Host header the same way — 403, never picking one', () => {
    const decision = evaluateRequest(opts, {
      host: [opts.allowedHost, opts.allowedHost],
      origin: undefined,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(decision.outcome === 'deny' && decision.status).toBe(403);
  });

  it('403s a duplicated Host header with NO authorization at all — the Host check fires regardless of the absent bearer', () => {
    const decision = evaluateRequest(opts, {
      host: [opts.allowedHost, opts.allowedHost],
      origin: undefined,
      authorization: undefined,
    });
    expect(decision).toEqual({
      outcome: 'deny',
      status: 403,
      reason: 'invalid or missing Host header',
    });
  });

  it('403s a duplicated Origin header with a valid Host and NO authorization at all — the Origin check fires before the absent-bearer 401', () => {
    const decision = evaluateRequest(opts, {
      host: opts.allowedHost,
      origin: ['https://allowed.example', 'https://evil.example'],
      authorization: undefined,
    });
    expect(decision).toEqual({ outcome: 'deny', status: 403, reason: 'Origin not allowlisted' });
  });

  it('treats a single-element array Host/Origin header the same as the equivalent plain string', () => {
    const decision = evaluateRequest(opts, {
      host: [opts.allowedHost],
      origin: ['https://allowed.example'],
      authorization: `Bearer ${TOKEN}`,
    });
    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('DIRECT ordering proof: a bad Origin PLUS a missing bearer still 403s (not 401) — if the bearer were checked first, a missing bearer alone would yield 401', () => {
    const decision = evaluateRequest(
      opts,
      headers({ host: opts.allowedHost, origin: 'https://evil.example' }),
    );
    expect(decision).toEqual({ outcome: 'deny', status: 403, reason: 'Origin not allowlisted' });
  });

  it('DIRECT ordering proof: an ALLOWLISTED Origin with a bad bearer 401s (not 403) — the Origin check passing lets the bearer check run and produce its OWN status', () => {
    const decision = evaluateRequest(
      opts,
      headers({
        host: opts.allowedHost,
        origin: 'https://allowed.example',
        authorization: 'Bearer wrong-token-wrong-token-wrong-token',
      }),
    );
    expect(decision).toEqual({
      outcome: 'deny',
      status: 401,
      reason: 'missing or invalid bearer token',
    });
  });
});

describe('evaluateRequest — Host aliases', () => {
  const local: RequestGuardOptions = {
    ...opts,
    allowedHostAliases: new Set(['localhost:3044']),
  };
  const auth = `Bearer ${TOKEN}`;

  it.each(['127.0.0.1:3044', 'localhost:3044', 'LOCALHOST:3044'])('accepts Host %s', (host) => {
    expect(evaluateRequest(local, headers({ host, authorization: auth }))).toEqual({
      outcome: 'allow',
    });
  });

  it.each([
    'evil.example.com:3044',
    'localhost:3045',
    'localhost',
    '127.0.0.1',
    '[::1]:3044',
    'localhost.evil.example:3044',
    'evil.localhost:3044',
  ])('still rejects Host %s with 403', (host) => {
    expect(evaluateRequest(local, headers({ host, authorization: auth }))).toEqual({
      outcome: 'deny',
      status: 403,
      reason: 'invalid or missing Host header',
    });
  });

  it('accepts no alias unless one is configured', () => {
    expect(
      evaluateRequest(opts, headers({ host: 'localhost:3044', authorization: auth })),
    ).toMatchObject({ outcome: 'deny', status: 403 });
  });
});

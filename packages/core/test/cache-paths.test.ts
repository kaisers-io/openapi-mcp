import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CACHE_KEY_MAX_LENGTH,
  CACHE_META_MAX_BYTES,
  OpenapiMcpError,
  type SpecSource,
  cacheLayout,
  cacheNamespace,
  canonicalSourceOf,
  defaultCacheRoot,
  objectPath,
  parseCacheId,
  parseCacheKey,
  parseContentHash,
  resolveCachePolicy,
} from '../src/index.ts';

const URL_SOURCE: SpecSource = {
  kind: 'url',
  url: new URL('https://api.example.com/openapi.json'),
};

describe('defaultCacheRoot', () => {
  it('places the cache under the documented app directory', () => {
    expect(defaultCacheRoot('/home/u')).toBe('/home/u/.kaisers-io/openapi-mcp/cache');
  });
});

describe('parseCacheKey', () => {
  it('accepts the full documented charset', () => {
    expect(parseCacheKey('a.B_9-x')).toBe('a.B_9-x');
  });

  it.each(['', 'a/b', 'a b', 'a\\b', 'x\u0000y', 'tab\there', 'sl/ash'])(
    'rejects the unusable key %j',
    (raw) => {
      expect(() => parseCacheKey(raw)).toThrowError(OpenapiMcpError);
    },
  );

  it('accepts ".." because the key is hashed, never used as a path segment', () => {
    // The charset admits dots on purpose: parseCacheKey guards a label, and
    // cacheNamespace below proves the label only ever reaches a sha256 digest
    expect(parseCacheKey('..')).toBe('..');
    expect(cacheNamespace('https://a.example/s.json', '..')).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('rejects a key longer than the cap', () => {
    expect(() => parseCacheKey('x'.repeat(CACHE_KEY_MAX_LENGTH + 1))).toThrowError(
      /at most 64 characters/u,
    );
  });

  it('accepts a key exactly at the cap', () => {
    const key = 'x'.repeat(CACHE_KEY_MAX_LENGTH);
    expect(parseCacheKey(key)).toBe(key);
  });

  it('never echoes the rejected value', () => {
    try {
      parseCacheKey('../../etc/passwd');
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).message).not.toContain('passwd');
    }
  });
});

describe('parseCacheId', () => {
  it('accepts a 16-character lowercase hex id', () => {
    expect(parseCacheId('abcdef0123456789')).toBe('abcdef0123456789');
  });

  it.each([
    ['empty', ''],
    ['a traversal', '../../etc'],
    ['an absolute path', '/etc/passwd'],
    ['uppercase hex', 'ABCDEF0123456789'],
    ['too short', 'abcdef012345678'],
    ['too long', 'abcdef01234567890'],
    ['a non-hex character', 'abcdef012345678g'],
    ['a trailing newline', 'abcdef0123456789\n'],
  ])('rejects %s so --id can never reach a path join', (_label, raw) => {
    expect(() => parseCacheId(raw)).toThrowError(OpenapiMcpError);
    expect(() => parseCacheId(raw)).toThrowError(/16-character lowercase hexadecimal/u);
  });

  it('reports a usage error, not a validation error', () => {
    try {
      parseCacheId('nope');
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('usage');
      expect((error as OpenapiMcpError).exitCode).toBe(2);
    }
  });
});

describe('parseContentHash', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(parseContentHash('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it.each([
    ['uppercase', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
    ['non-hex', `${'a'.repeat(63)}z`],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseContentHash(raw)).toThrowError(/64-character lowercase hexadecimal/u);
  });
});

describe('canonicalSourceOf', () => {
  it('uses the full href for url sources', () => {
    const url = new URL('https://api.example.com/openapi.json?version=2');
    expect(canonicalSourceOf({ kind: 'url', url })).toBe(
      'https://api.example.com/openapi.json?version=2',
    );
  });

  it('uses the absolute path for file sources', () => {
    expect(canonicalSourceOf({ kind: 'file', path: '/abs/spec.yaml' })).toBe('/abs/spec.yaml');
  });

  it('never yields the NUL that separates source from key', () => {
    // Verified by execution: URL.href percent-encodes NUL, and a POSIX path
    // cannot contain one — so the separator below is unambiguous in practice
    const url = new URL('https://a.example/s\u0000x.json');
    expect(canonicalSourceOf({ kind: 'url', url })).toBe('https://a.example/s%00x.json');
  });
});

describe('cacheNamespace', () => {
  it('is a 16-character hex digest', () => {
    expect(cacheNamespace('https://a.example/s.json')).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('is stable for the same source', () => {
    expect(cacheNamespace('https://a.example/s.json')).toBe(
      cacheNamespace('https://a.example/s.json'),
    );
  });

  it('separates dev, stage, and prod automatically', () => {
    expect(cacheNamespace('https://dev.example/s.json')).not.toBe(
      cacheNamespace('https://prod.example/s.json'),
    );
  });

  it('binds the namespace to both source and key', () => {
    // Reusing --cache-key prod across two different APIs must never collide
    expect(cacheNamespace('https://a.example/s.json', 'prod')).not.toBe(
      cacheNamespace('https://b.example/s.json', 'prod'),
    );
  });

  it('distinguishes different keys for the same source', () => {
    expect(cacheNamespace('https://a.example/s.json', 'tenant-a')).not.toBe(
      cacheNamespace('https://a.example/s.json', 'tenant-b'),
    );
  });

  it('never equals the unkeyed namespace for the same source', () => {
    expect(cacheNamespace('https://a.example/s.json')).not.toBe(
      cacheNamespace('https://a.example/s.json', 'prod'),
    );
  });

  it('is not confused by a source containing the literal separator text', () => {
    expect(cacheNamespace('source:https://a.example/s.json' + 'key:prod')).not.toBe(
      cacheNamespace('https://a.example/s.json', 'prod'),
    );
  });

  it('separates source from key with a real NUL, not the six characters "\\u0000"', () => {
    // Writing "\\u0000" in the template literal is a backslash plus "u0000" —
    // six printable characters — which would silently void the separator
    // argument, because nothing stops a canonical source from containing
    // them. This asserts the byte without spelling it: the file must never
    // carry a raw control character.
    const NUL = String.fromCodePoint(0);
    const digest = createHash('sha256')
      .update(`source:https://a.example/s.json${NUL}key:prod`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(cacheNamespace('https://a.example/s.json', 'prod')).toBe(digest);
    // And the defective spelling must NOT reproduce it
    const defective = createHash('sha256')
      .update('source:https://a.example/s.json\\u0000key:prod', 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(cacheNamespace('https://a.example/s.json', 'prod')).not.toBe(defective);
  });

  it('cannot be collided by a source spelling the defective separator', () => {
    // The concrete attack the six-character separator would have permitted
    expect(cacheNamespace('https://a.example/s.json\\u0000key:prod')).not.toBe(
      cacheNamespace('https://a.example/s.json', 'prod'),
    );
  });
});

describe('cacheLayout', () => {
  it('derives every path from root and namespace', () => {
    expect(cacheLayout('/c', 'abcdef0123456789')).toEqual({
      root: '/c',
      namespace: 'abcdef0123456789',
      dir: '/c/abcdef0123456789',
      metaPath: '/c/abcdef0123456789/meta.json',
      lockPath: '/c/abcdef0123456789/.lock',
      objectsDir: '/c/abcdef0123456789/objects',
    });
  });

  it('exposes no fixed accepted or candidate path', () => {
    // A fixed path has to be REPLACED to store a new generation, and that
    // replacement is what destroyed the bytes the live meta.json pointed at
    const layout = cacheLayout('/c', 'abcdef0123456789');
    expect('acceptedPath' in layout).toBe(false);
    expect('candidatePath' in layout).toBe(false);
  });
});

describe('objectPath', () => {
  const layout = cacheLayout('/c', 'abcdef0123456789');

  it('names the object after the hash of its own contents', () => {
    expect(objectPath(layout, 'a'.repeat(64))).toBe(
      `/c/abcdef0123456789/objects/${'a'.repeat(64)}.json`,
    );
  });

  it('gives two generations two distinct files, so neither can overwrite the other', () => {
    expect(objectPath(layout, 'a'.repeat(64))).not.toBe(objectPath(layout, 'b'.repeat(64)));
  });

  it('stays inside the namespace for every hash parseContentHash admits', () => {
    for (const hash of ['0'.repeat(64), 'f'.repeat(64), `${'0'.repeat(63)}a`]) {
      expect(objectPath(layout, parseContentHash(hash)).startsWith(`${layout.objectsDir}/`)).toBe(
        true,
      );
    }
  });
});

describe('resolveCachePolicy', () => {
  const base = {
    source: URL_SOURCE,
    authenticated: false,
    cacheKey: undefined,
    trustSpecUpdates: false,
    cacheRoot: '/c' as string | undefined,
  };

  it('resolves an unauthenticated source to a persistent, source-only namespace', () => {
    const policy = resolveCachePolicy(base);
    expect(policy.kind).toBe('persistent');
    if (policy.kind !== 'persistent') {
      expect.unreachable('expected a persistent policy');
    }
    expect(policy.layout.namespace).toBe(cacheNamespace('https://api.example.com/openapi.json'));
    // ExactOptionalPropertyTypes: an absent key is an absent property, not undefined
    expect('cacheKey' in policy).toBe(false);
  });

  it('resolves an authenticated source with --cache-key to a key-bound namespace', () => {
    const policy = resolveCachePolicy({ ...base, authenticated: true, cacheKey: 'prod' });
    expect(policy).toMatchObject({ kind: 'persistent', cacheKey: 'prod' });
    if (policy.kind !== 'persistent') {
      expect.unreachable('expected a persistent policy');
    }
    expect(policy.layout.namespace).toBe(
      cacheNamespace('https://api.example.com/openapi.json', 'prod'),
    );
  });

  it('resolves authenticated + --trust-spec-updates + no key to a NON-PERSISTENT bypass', () => {
    // This combination is "non-persistent": a source-only
    // namespace would be shared by two hosts using different credentials
    const policy = resolveCachePolicy({
      ...base,
      authenticated: true,
      trustSpecUpdates: true,
    });
    expect(policy.kind).toBe('bypass');
    if (policy.kind !== 'bypass') {
      expect.unreachable('expected a bypass policy');
    }
    expect(policy.reason).toContain('--trust-spec-updates');
    expect(policy.reason).toContain('credentials');
  });

  it('keeps a persistent policy when --trust-spec-updates is combined with a key', () => {
    expect(
      resolveCachePolicy({
        ...base,
        authenticated: true,
        cacheKey: 'prod',
        trustSpecUpdates: true,
      }).kind,
    ).toBe('persistent');
  });

  it('rejects an authenticated source with neither option, naming both', () => {
    try {
      resolveCachePolicy({ ...base, authenticated: true });
      expect.unreachable('expected a usage error');
    } catch (error) {
      const typed = error as OpenapiMcpError;
      expect(typed.code).toBe('usage');
      expect(typed.message).toContain('--cache-key');
      expect(typed.message).toContain('--trust-spec-updates');
    }
  });

  it('bypasses when there is no cache root at all', () => {
    const policy = resolveCachePolicy({ ...base, cacheRoot: undefined });
    expect(policy).toMatchObject({ kind: 'bypass' });
  });

  it('applies the authenticated decision BEFORE the no-root bypass', () => {
    // Checking cacheRoot before the authenticated decision would return a
    // generic bypass instead of the required usage error here, since this
    // context has no cache root at all (e.g. an undefined homeDir()) and must
    // still produce a usage error with exit code 2.
    try {
      resolveCachePolicy({ ...base, authenticated: true, cacheRoot: undefined });
      expect.unreachable('expected a usage error, not a bypass');
    } catch (error) {
      const typed = error as OpenapiMcpError;
      expect(typed.code).toBe('usage');
      expect(typed.exitCode).toBe(2);
      expect(typed.message).toContain('--cache-key');
    }
  });

  it('keeps the deliberate non-persistent bypass ahead of the no-root bypass', () => {
    // Same ordering, opposite outcome: the operator DID decide, so this is the
    // credential-separation bypass and its reason must say so rather than
    // blaming a missing home directory
    const policy = resolveCachePolicy({
      ...base,
      authenticated: true,
      trustSpecUpdates: true,
      cacheRoot: undefined,
    });
    expect(policy.kind).toBe('bypass');
    if (policy.kind !== 'bypass') {
      expect.unreachable('expected a bypass policy');
    }
    expect(policy.reason).toContain('credentials');
    expect(policy.reason).not.toContain('home directory');
  });

  it('lets authenticated + key fall through to the no-root bypass', () => {
    // The separation decision was made, so an absent home directory is an
    // ordinary environmental limitation rather than a rule being skipped
    const policy = resolveCachePolicy({
      ...base,
      authenticated: true,
      cacheKey: 'prod',
      cacheRoot: undefined,
    });
    expect(policy.kind).toBe('bypass');
  });

  it('exposes the metadata read budget the store enforces', () => {
    expect(CACHE_META_MAX_BYTES).toBe(65_536);
  });
});

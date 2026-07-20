import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { usageError } from '../errors.ts';
import type { SpecSource } from '../spec/load.ts';

export const CACHE_KEY_MAX_LENGTH = 64;

// Meta.json is small by construction; a larger file is a corrupt entry, not a
// slow one, and the cap is enforced before any parsing happens (D12)
export const CACHE_META_MAX_BYTES = 65_536;

// D14: the budget for the DEREFERENCED representation the cache persists,
// deliberately distinct from SPEC_BUDGETS.maxSpecBytes, which bounds the SOURCE
// download. Dereferencing expands a document, so a spec can pass every §4.1
// budget and still serialize past the source cap — the round-1 draft then
// persisted it and classified its own entry corrupt on the next read, because
// the read path capped at the source budget. Write and read use this constant.
export const CACHE_MAX_PERSISTED_BYTES = 67_108_864;

// Display-safe by construction (D9): the key appears in cache list output and
// in meta.json, so it never needs sanitizing. It is hashed into the namespace
// and never used as a path segment, which is why "." and ".." are harmless.
const CACHE_KEY_RE = /^[A-Za-z0-9._-]+$/u;

// The exact namespace grammar. Validating --id against it closes the only
// argv path that could otherwise reach a path join (D12).
const CACHE_ID_RE = /^[0-9a-f]{16}$/u;

// Sha256 hex digests as produced by hashContent and by the store
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/u;

// 64 bits of digest is ample for a per-user cache directory name
const NAMESPACE_LENGTH = 16;

export const defaultCacheRoot = (homeDir: string): string =>
  join(homeDir, '.kaisers-io', 'openapi-mcp', 'cache');

export const parseCacheKey = (raw: string): string => {
  if (raw === '') {
    throw usageError('--cache-key must not be empty');
  }
  if (raw.length > CACHE_KEY_MAX_LENGTH) {
    throw usageError(`--cache-key must be at most ${CACHE_KEY_MAX_LENGTH} characters`);
  }
  if (!CACHE_KEY_RE.test(raw)) {
    // Never echo the raw value: it is operator input of unknown shape
    throw usageError('--cache-key may only contain letters, digits, ".", "_", and "-"');
  }
  return raw;
};

export const parseCacheId = (raw: string): string => {
  if (!CACHE_ID_RE.test(raw)) {
    // Never echo the raw value: it is exactly the traversal attempt we refuse
    throw usageError(
      '--id must be a 16-character lowercase hexadecimal cache id (see "openapi-mcp cache list")',
    );
  }
  return raw;
};

export const parseContentHash = (raw: string): string => {
  if (!CONTENT_HASH_RE.test(raw)) {
    throw usageError('--hash must be a 64-character lowercase hexadecimal sha256 digest');
  }
  return raw;
};

export const canonicalSourceOf = (source: SpecSource): string =>
  source.kind === 'url' ? source.url.href : source.path;

// D9: ONE TypeScript escape, so this is a single NUL code unit. The round-1
// draft wrote "\\u0000" here, which is a backslash followed by "u0000" — six
// printable characters — and that silently voided the whole separator argument
// below, because nothing prevents a canonical source from containing those six
// characters. Never paste a raw control byte here; the escape is the correct form.
const NAMESPACE_SEPARATOR = '\u0000';

export const cacheNamespace = (canonicalSource: string, cacheKey?: string): string => {
  // Spec §5.3: with a key the namespace is bound to BOTH source and label, so
  // reusing "--cache-key prod" across two APIs cannot collide. The NUL
  // separator cannot occur in a canonical source — URL.href percent-encodes it
  // and a POSIX path cannot contain it — so the two encodings are unambiguous.
  // No secret ever contributes to this material.
  const material =
    cacheKey === undefined
      ? canonicalSource
      : `source:${canonicalSource}${NAMESPACE_SEPARATOR}key:${cacheKey}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, NAMESPACE_LENGTH);
};

export interface CacheLayout {
  root: string;
  dir: string;
  metaPath: string;
  lockPath: string;
  // D12.1: one directory of immutable, content-addressed spec objects. There are
  // no fixed accepted/candidate paths, because a fixed path has to be REPLACED
  // to store a new generation, and that replacement is what destroyed the bytes
  // the current meta.json still pointed at.
  objectsDir: string;
  namespace: string;
}

export const cacheLayout = (root: string, namespace: string): CacheLayout => {
  const dir = join(root, namespace);
  return {
    root,
    namespace,
    dir,
    metaPath: join(dir, 'meta.json'),
    lockPath: join(dir, '.lock'),
    objectsDir: join(dir, 'objects'),
  };
};

// The filename IS the hash, so an object is self-verifying: a reader that finds
// objects/<h>.json hashing to something other than <h> knows it is damaged
// without consulting metadata. contentHash is always a value this process
// produced or one parseContentHash already validated, never raw operator input.
export const objectPath = (layout: CacheLayout, contentHash: string): string =>
  join(layout.objectsDir, `${contentHash}.json`);

export type CachePolicy =
  | { kind: 'bypass'; reason: string }
  | { kind: 'persistent'; layout: CacheLayout; cacheKey?: string | undefined };

// D13: the authenticated-source rule is resolved to a value, not asserted.
// Design §12 calls --trust-spec-updates the "non-persistent" option, and the
// reason is structural: without a key the namespace would be source-only, so
// two hosts pointing at one URL with different credentials or tenants would
// share a single entry. Bypass means the cache is never touched at all.
export const resolveCachePolicy = (opts: {
  source: SpecSource;
  authenticated: boolean;
  cacheKey: string | undefined;
  trustSpecUpdates: boolean;
  cacheRoot: string | undefined;
}): CachePolicy => {
  // D13 ordering (corrected in review round 2): the authenticated decision is a
  // security decision about credential separation and is evaluated FIRST,
  // unconditionally. Checking cacheRoot first turned "authenticated, no key, no
  // trust" into a generic bypass instead of the required usage error — and
  // Task 10's own regression builds a context with no home directory and
  // asserts exit 2, so the suite contradicted the implementation.
  if (opts.authenticated && opts.cacheKey === undefined) {
    if (!opts.trustSpecUpdates) {
      // Spec §5.3: without a durable baseline every restart would silently
      // re-accept a changed spec, so the operator must choose explicitly
      throw usageError(
        'an authenticated spec source (--spec-header-env) requires an explicit cache decision:' +
          ' pass --cache-key <name> for a durable, credential-scoped baseline,' +
          ' or --trust-spec-updates to accept refreshed specs automatically without persisting a baseline',
      );
    }
    return {
      kind: 'bypass',
      reason:
        '--trust-spec-updates on an authenticated source without --cache-key: the cache is' +
        ' non-persistent for this run, because a source-only namespace would be shared by' +
        ' hosts using different credentials',
    };
  }
  // Only now may the environmental limitation apply. Authenticated + key reaches
  // here legitimately: the operator made the separation decision, and the
  // absence of a home directory is then an ordinary limitation, not a bypass of
  // the rule.
  if (opts.cacheRoot === undefined) {
    return {
      kind: 'bypass',
      reason:
        'no cache root is available (no home directory) — the spec is fetched fresh and nothing is written to disk',
    };
  }
  const namespace = cacheNamespace(canonicalSourceOf(opts.source), opts.cacheKey);
  return {
    kind: 'persistent',
    layout: cacheLayout(opts.cacheRoot, namespace),
    ...(opts.cacheKey === undefined ? {} : { cacheKey: opts.cacheKey }),
  };
};

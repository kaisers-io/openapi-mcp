import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_PERSISTED_BYTES,
  CACHE_META_MAX_BYTES,
  CACHE_META_SCHEMA_VERSION,
  LEGACY_CACHE_META_SCHEMA_VERSION,
  FETCHED_AT_MAX,
  cacheLayout,
  clearNamespace,
  hashContent,
  listCacheEntries,
  listNamespaceIds,
  objectPath,
  promoteCandidate,
  readCacheEntry,
  serializedSizeWithin,
  serializeWithinBudget,
  touchRevalidated,
  validationError,
  withNamespaceLock,
  writeAccepted,
  writeCandidate,
  zCacheMeta,
} from '../src/index.ts';
import type { CacheMeta } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

export const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');

export const DOC: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {},
};
export const DOC_V2: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'Petstore v2', version: '2.0.0' },
  paths: { '/pets': {} },
};
// A genuinely 3.0 document: the discriminator is derived from the document,
// so a test that wants a 3.0 entry must supply 3.0 BYTES — passing a 3.0
// label beside a 3.1 document now (correctly) reads as corrupt.
export const DOC_30: Record<string, unknown> = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {},
};
export const DOC_TEXT = JSON.stringify(DOC);
export const DOC_V2_TEXT = JSON.stringify(DOC_V2);
export const SOURCE_HASH = hashContent('source-text-v1');
export const SOURCE_HASH_V2 = hashContent('source-text-v2');

export const acceptedInput = (
  over: Record<string, unknown> = {},
): Parameters<typeof writeAccepted>[2] => ({
  document: DOC,
  sourceContentHash: SOURCE_HASH,
  displaySource: 'https://api.example.com/openapi.json',
  title: 'Petstore',
  specVersion: '1.0.0',
  fetchedAt: 1_700_000_000_000,
  expected: 'unchecked',
  ...over,
});

export const candidateInput = (): Parameters<typeof writeCandidate>[2] => ({
  document: DOC_V2,
  sourceContentHash: SOURCE_HASH_V2,
  title: 'Petstore v2',
  specVersion: '2.0.0',
  fetchedAt: 1_700_000_500_000,
  expected: 'unchecked',
});

export const CANDIDATE_HASH = hashContent(DOC_V2_TEXT);

export const seeded = async (): Promise<MemoryCacheFs> => {
  const fs = memoryCacheFs();
  await writeAccepted(LAYOUT, fs, acceptedInput());
  return fs;
};

export const metaOf = (fs: MemoryCacheFs): CacheMeta =>
  zCacheMeta.parse(JSON.parse(fs.files.get(LAYOUT.metaPath) ?? ''));

// There is no fixed accepted/candidate path any more — an object is found
// through the hash meta.json records, which is also its filename. These
// helpers read the entry the way the STORE does, so a test cannot
// accidentally assert against bytes no metadata references.
export const acceptedTextOf = (fs: MemoryCacheFs): string | undefined =>
  fs.files.get(objectPath(LAYOUT, metaOf(fs).acceptedContentHash));

export const candidateTextOf = (fs: MemoryCacheFs): string | undefined => {
  const { candidate } = metaOf(fs);
  return candidate === undefined
    ? undefined
    : fs.files.get(objectPath(LAYOUT, candidate.contentHash));
};

// Every object file present, referenced or not — used to prove GC reclaims
// superseded generations and that a commit never overwrote a live one
export const objectNamesOf = (fs: MemoryCacheFs, layout = LAYOUT): readonly string[] =>
  [...fs.files.keys()]
    .filter((key) => key.startsWith(`${layout.objectsDir}${sep}`))
    .map((key) => key.slice(layout.objectsDir.length + 1))
    .toSorted();

// A hand-rolled mock must be faithful to Node the same way memoryCacheFs's own
// absenceError is: the store now branches on `err.code` (isCacheAbsence) to
// tell a lost race apart from a genuine I/O failure, so a mock simulating
// "the object is transiently missing" has to carry the same `.code` a real
// ENOENT would, or it is indistinguishable from EACCES/EIO.
export const enoentError = (message: string): Error =>
  Object.assign(new Error(message), { code: 'ENOENT' });

const validMeta = (): CacheMeta => ({
  schemaVersion: CACHE_META_SCHEMA_VERSION,
  displaySource: 'https://api.example.com/openapi.json',
  cacheKey: 'prod',
  etag: '"v1"',
  lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
  fetchedAt: 1_700_000_000_000,
  acceptedContentHash: hashContent(DOC_TEXT),
  sourceContentHash: SOURCE_HASH,
  title: 'Petstore',
  specVersion: '1.0.0',
  openapiVersion: '3.1',
});

describe('zCacheMeta', () => {
  it('pins the schema version at 2, with 1 still readable as the legacy format', () => {
    // Version 2 (issue kaisers-io/openapi-mcp-archive#89) persists the
    // validated source document instead of its dereferenced form; version 1
    // entries are migrated by the pipeline
    expect(CACHE_META_SCHEMA_VERSION).toBe(2);
    expect(LEGACY_CACHE_META_SCHEMA_VERSION).toBe(1);
    expect(zCacheMeta.safeParse({ ...validMeta(), schemaVersion: 1 }).success).toBe(true);
  });

  it('accepts a fully populated entry', () => {
    expect(zCacheMeta.safeParse(validMeta()).success).toBe(true);
  });

  it('accepts an entry with no key, no validators, and no candidate', () => {
    const meta = validMeta();
    expect(
      zCacheMeta.safeParse({
        schemaVersion: meta.schemaVersion,
        displaySource: meta.displaySource,
        fetchedAt: meta.fetchedAt,
        acceptedContentHash: meta.acceptedContentHash,
        sourceContentHash: meta.sourceContentHash,
        title: meta.title,
        specVersion: meta.specVersion,
        openapiVersion: meta.openapiVersion,
      }).success,
    ).toBe(true);
  });

  it('accepts either OpenAPI version discriminator', () => {
    expect(zCacheMeta.safeParse({ ...validMeta(), openapiVersion: '3.0' }).success).toBe(true);
    expect(zCacheMeta.safeParse({ ...validMeta(), openapiVersion: '3.1' }).success).toBe(true);
  });

  it.each(['3.0.3', '3.1.0', '3.2', '3', '', 1, undefined])(
    'rejects the unusable openapiVersion %j',
    (openapiVersion) => {
      // A cache hit skips revalidation, so this field is the only source of
      // the discriminator normalizeSpec needs: a loose value would silently
      // normalize a 3.1 document under 3.0 rules
      const meta: Record<string, unknown> = { ...validMeta(), openapiVersion };
      if (openapiVersion === undefined) {
        delete meta['openapiVersion'];
      }
      expect(zCacheMeta.safeParse(meta).success).toBe(false);
    },
  );

  it('rejects any unknown key', () => {
    // A strict object is what makes an entry written by a future version
    // detectable rather than silently half-understood
    expect(zCacheMeta.safeParse({ ...validMeta(), extra: 1 }).success).toBe(false);
  });

  it.each([0, 3, 1.5, '1', '2'])('rejects the unknown schema version %j', (schemaVersion) => {
    expect(zCacheMeta.safeParse({ ...validMeta(), schemaVersion }).success).toBe(false);
  });

  it.each([
    ['a missing required field', { title: undefined }],
    ['an absent sourceContentHash', { sourceContentHash: undefined }],
  ])('rejects %s', (_label, patch) => {
    const meta: Record<string, unknown> = { ...validMeta(), ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete meta[key];
      }
    }
    expect(zCacheMeta.safeParse(meta).success).toBe(false);
  });

  it.each([
    ['not-a-hash', 'not-a-hash'],
    ['uppercase hex', 'A'.repeat(64)],
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
  ])('rejects the accepted content hash %s', (_label, acceptedContentHash) => {
    expect(zCacheMeta.safeParse({ ...validMeta(), acceptedContentHash }).success).toBe(false);
  });

  it('rejects a validator carrying a header-injection sequence', () => {
    // Validators are replayed as If-None-Match / If-Modified-Since request
    // headers on the next revalidation: only printable ASCII is stored
    expect(zCacheMeta.safeParse({ ...validMeta(), etag: 'v1\r\nX-Evil: 1' }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), etag: 'v1\u001B]0;PWNED' }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), etag: 'x'.repeat(257) }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), etag: '' }).success).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])(
    'rejects the unusable fetchedAt %j',
    (fetchedAt) => {
      expect(zCacheMeta.safeParse({ ...validMeta(), fetchedAt }).success).toBe(false);
    },
  );

  it('bounds fetchedAt by the Date limit, not MAX_SAFE_INTEGER', () => {
    // Probed: new Date(Number.MAX_SAFE_INTEGER).toISOString() throws
    // RangeError, so an earlier bound admitted metadata that crashed
    // "cache list" while rendering it. Every schema-valid value must render.
    expect(FETCHED_AT_MAX).toBe(8_640_000_000_000_000);
    expect(zCacheMeta.safeParse({ ...validMeta(), fetchedAt: FETCHED_AT_MAX }).success).toBe(true);
    expect(zCacheMeta.safeParse({ ...validMeta(), fetchedAt: FETCHED_AT_MAX + 1 }).success).toBe(
      false,
    );
    expect(() => new Date(FETCHED_AT_MAX).toISOString()).not.toThrow();
    expect(() => new Date(Number.MAX_SAFE_INTEGER).toISOString()).toThrow(RangeError);
  });

  it('renders every schema-valid fetchedAt without throwing', () => {
    for (const fetchedAt of [0, 1_700_000_000_000, FETCHED_AT_MAX]) {
      const parsed = zCacheMeta.parse({ ...validMeta(), fetchedAt });
      expect(() => new Date(parsed.fetchedAt).toISOString()).not.toThrow();
    }
  });

  it('accepts a fully populated candidate', () => {
    expect(
      zCacheMeta.safeParse({
        ...validMeta(),
        candidate: {
          contentHash: 'c'.repeat(64),
          sourceContentHash: 'd'.repeat(64),
          title: 'Petstore v2',
          specVersion: '2.0.0',
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no contentHash', { sourceContentHash: 'd'.repeat(64), title: 'x', specVersion: '2' }],
    ['no sourceContentHash', { contentHash: 'c'.repeat(64), title: 'x', specVersion: '2' }],
    [
      'no title',
      { contentHash: 'c'.repeat(64), sourceContentHash: 'd'.repeat(64), specVersion: '2' },
    ],
    [
      'an unknown key',
      {
        contentHash: 'c'.repeat(64),
        sourceContentHash: 'd'.repeat(64),
        title: 'x',
        specVersion: '2',
        injected: true,
      },
    ],
  ])('rejects a candidate with %s — the member is all-or-none', (_label, candidate) => {
    // The old flat shape had two independently optional hashes, so a file
    // could carry exactly one and promotion silently fell back to the
    // ACCEPTED entry's source hash — recording the replaced document's
    // provenance against the promoted bytes. Nesting makes that unrepresentable.
    expect(zCacheMeta.safeParse({ ...validMeta(), candidate }).success).toBe(false);
  });

  it('rejects legacy flat candidate fields outright', () => {
    // A file written by the pre-correction shape is unreadable rather than
    // half-understood, which is exactly what the strict object is for
    expect(
      zCacheMeta.safeParse({
        ...validMeta(),
        candidateContentHash: 'c'.repeat(64),
        candidateSourceContentHash: 'd'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects a cacheKey outside the documented charset', () => {
    expect(zCacheMeta.safeParse({ ...validMeta(), cacheKey: 'a/b' }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), cacheKey: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects an over-long display source, title, or version', () => {
    expect(zCacheMeta.safeParse({ ...validMeta(), displaySource: '' }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), title: 'x'.repeat(257) }).success).toBe(false);
    expect(zCacheMeta.safeParse({ ...validMeta(), specVersion: 'x'.repeat(257) }).success).toBe(
      false,
    );
  });
});

describe('writeAccepted', () => {
  it('creates the namespace and the objects directory before writing', async () => {
    const fs = await seeded();
    expect(fs.dirs.has(LAYOUT.dir)).toBe(true);
    expect(fs.dirs.has(LAYOUT.objectsDir)).toBe(true);
  });

  it('persists JSON.stringify(document) and hashes exactly those bytes', async () => {
    const fs = memoryCacheFs();
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, acceptedInput());
    const persisted = acceptedTextOf(fs);
    expect(persisted).toBe(DOC_TEXT);
    expect(persisted).not.toContain('\n');
    expect(acceptedContentHash).toBe(hashContent(DOC_TEXT));
    expect(metaOf(fs).acceptedContentHash).toBe(acceptedContentHash);
  });

  it('names the object after its own hash, so the filename is self-verifying', async () => {
    const fs = memoryCacheFs();
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, acceptedInput());
    expect(objectNamesOf(fs)).toEqual([`${acceptedContentHash}.json`]);
    const persistedPath = objectPath(LAYOUT, acceptedContentHash);
    expect(hashContent(fs.files.get(persistedPath) ?? '')).toBe(acceptedContentHash);
  });

  it('refuses a document over the persisted-document budget, before taking the lock', async () => {
    // Checking only the candidate, and only against the SOURCE budget, would
    // let an accepted document that dereferences past the persisted-document
    // budget get persisted anyway, then read back as corrupt — bricking an
    // entry that had validated
    const fs = memoryCacheFs();
    const huge = {
      openapi: '3.1.0',
      info: { title: 'Big', version: '1' },
      blob: 'x'.repeat(CACHE_MAX_PERSISTED_BYTES),
    };
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: huge })),
    ).rejects.toMatchObject({ code: 'validation' });
    // Nothing written and, critically, no namespace left locked
    expect([...fs.files.keys()]).toEqual([]);
  });

  it('reads back everything it accepts at the budget boundary', async () => {
    // The invariant the shared constant buys: anything this build persisted,
    // this build can read back
    const fs = memoryCacheFs();
    const padding = 'x'.repeat(1024);
    const doc = { openapi: '3.1.0', info: { title: 'Padded', version: '1' }, paths: {}, padding };
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: doc }));
    const readResult = await readCacheEntry(LAYOUT, fs);
    expect(readResult.kind).toBe('hit');
  });

  it('keeps the source hash distinct from the persisted-bytes hash', async () => {
    const fs = await seeded();
    const meta = metaOf(fs);
    expect(meta.sourceContentHash).toBe(SOURCE_HASH);
    expect(meta.acceptedContentHash).not.toBe(meta.sourceContentHash);
  });

  it('takes no hash from the caller — the input has no hash field to pass', async () => {
    const fs = memoryCacheFs();
    // A caller cannot desynchronise meta from the file: the only hash input is
    // sourceContentHash, which describes the upstream text, not the bytes here
    await writeAccepted(LAYOUT, fs, acceptedInput());
    expect(hashContent(acceptedTextOf(fs) ?? '')).toBe(metaOf(fs).acceptedContentHash);
  });

  it('persists the OpenAPI version discriminator a cache hit cannot recover', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_30 }));
    // Derived from the bytes, never supplied by the caller
    expect(metaOf(fs).openapiVersion).toBe('3.0');
  });

  it('records the operator cache-key label', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ cacheKey: 'prod' }));
    expect(metaOf(fs).cacheKey).toBe('prod');
  });

  it('omits an absent cache key rather than storing undefined', async () => {
    const fs = await seeded();
    expect('cacheKey' in metaOf(fs)).toBe(false);
  });

  it('records validators when the fetch returned them', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(
      LAYOUT,
      fs,
      acceptedInput({ etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    );
    expect(metaOf(fs)).toMatchObject({
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
  });

  it('writes the object before meta.json, so meta is the commit point', async () => {
    const order: string[] = [];
    const fs = memoryCacheFs();
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      order.push(path);
      return inner(path, data);
    };
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, acceptedInput());
    expect(order).toEqual([objectPath(LAYOUT, acceptedContentHash), LAYOUT.metaPath]);
  });

  it('never rewrites an existing object — a commit only ever creates', async () => {
    // This is the property the old fixed-path layout lacked, and the reason
    // its crash-safety argument failed: writing a generation MUTATED the bytes
    // the live meta.json still pointed at
    const fs = await seeded();
    const acceptedHash = metaOf(fs).acceptedContentHash;
    const written: string[] = [];
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      written.push(path);
      return inner(path, data);
    };
    await writeAccepted(
      LAYOUT,
      fs,
      acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 }),
    );
    // The previous generation's object was never a write target
    expect(written).not.toContain(objectPath(LAYOUT, acceptedHash));
  });

  it('writeAccepted refuses while another process holds the namespace lock', async () => {
    const fs = await seeded();
    // A live lock from another process blocks the write outright
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'other', acquiredAt: 1_700_000_000_000 }),
    );
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: 1_700_000_000_000 })),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('releases the lock after a successful write', async () => {
    const fs = await seeded();
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });

  it('supersedes a waiting candidate, leaving no orphan hash in meta', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
    await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: 1_700_000_900_000 }));
    expect(metaOf(fs).candidate).toBeUndefined();
    // And the superseded candidate's bytes are collected, not merely unreferenced
    expect(objectNamesOf(fs)).toEqual([`${metaOf(fs).acceptedContentHash}.json`]);
  });

  it('replaces the accepted generation and garbage-collects the previous object', async () => {
    const fs = await seeded();
    const firstHash = metaOf(fs).acceptedContentHash;
    await writeAccepted(
      LAYOUT,
      fs,
      acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 }),
    );
    expect(acceptedTextOf(fs)).toBe(DOC_V2_TEXT);
    expect(metaOf(fs).acceptedContentHash).toBe(hashContent(DOC_V2_TEXT));
    // GC runs strictly after the commit, so the old generation is gone only once
    // the new one is durable
    expect(objectNamesOf(fs)).toEqual([`${hashContent(DOC_V2_TEXT)}.json`]);
    expect(objectNamesOf(fs)).not.toContain(`${firstHash}.json`);
  });
});

describe('a crash during the FIRST-EVER commit', () => {
  it('leaves a miss that self-heals, not a permanently wedged namespace', async () => {
    // Classifying an object file with no metadata as corrupt (instead of as a
    // miss) would brick the namespace forever once a first commit dies right
    // after the object write — fail-closed corruption handling forbids
    // healing a corrupt entry automatically, and a first-ever commit has no
    // baseline to fall back to.
    const fs = memoryCacheFs();
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) =>
      path === LAYOUT.metaPath
        ? Promise.reject(new Error('crash during the first commit'))
        : inner(path, data);
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).rejects.toThrow();
    // An orphan object with no metadata claiming it is not a baseline
    expect(objectNamesOf(fs)).toEqual([`${hashContent(DOC_TEXT)}.json`]);
    expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });

    // And the next run really can proceed — trust-on-first-use is available
    // again, which is the whole point
    const clean = memoryCacheFs();
    clean.files = fs.files;
    clean.dirs = fs.dirs;
    await expect(writeAccepted(LAYOUT, clean, acceptedInput())).resolves.toBeDefined();
    const readResult = await readCacheEntry(LAYOUT, clean);
    expect(readResult.kind).toBe('hit');
    // The orphan was reclaimed by that commit's GC
    expect(objectNamesOf(clean)).toEqual([`${hashContent(DOC_TEXT)}.json`]);
  });

  it('does not weaken fail-closed corruption handling: deleting metadata beside a baseline is no better than deleting the directory', async () => {
    // The justification for calling orphan-only a miss. An attacker who can
    // remove meta.json can equally remove the whole namespace directory, which
    // has always been a miss — so this grants no new capability.
    const withEntry = await seeded();
    await withEntry.removeFile(LAYOUT.metaPath);
    const viaMetaDeletion = await readCacheEntry(LAYOUT, withEntry);

    const withoutDir = await seeded();
    await withoutDir.removeDir(LAYOUT.dir);
    const viaDirDeletion = await readCacheEntry(LAYOUT, withoutDir);

    expect(viaMetaDeletion).toEqual({ kind: 'miss' });
    expect(viaDirDeletion).toEqual({ kind: 'miss' });
  });
});

describe('the persisted-size preflight is exact', () => {
  // An earlier version reasoned this through instead of proving it and chose
  // the wrong unit — UTF-16 code units where the reader caps UTF-8 bytes — so a
  // multibyte document passed the writer and was corrupt on its first read. The
  // property is now asserted against the exact quantity that lands on disk,
  // over a corpus that actually contains the cases that broke it.
  const mulberry32 = (seed: number): (() => number) => {
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- '>>> 0' provides the unsigned 32-bit wraparound the PRNG needs; Math.trunc keeps sign and does not wrap, which would silently change the generated sequence
    let a = seed >>> 0;
    return () => {
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- '>>> 0' provides the unsigned 32-bit wraparound the PRNG needs; Math.trunc keeps sign and does not wrap, which would silently change the generated sequence
      a = (a + 0x6d_2b_79_f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- '>>> 0' provides the unsigned 32-bit wraparound the PRNG needs; Math.trunc keeps sign and does not wrap, which would silently change the generated sequence
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  it('agrees with Buffer.byteLength(JSON.stringify(value)) across a generated corpus', () => {
    const rng = mulberry32(20_260_720);
    const rand = (n: number): number => Math.floor(rng() * n);
    // Deliberately includes: astral, BMP non-ASCII, and every character
    // JSON.stringify escapes — the three classes that broke an earlier version
    const CHARS = ['a', 'ä', 'é', '\u{1F600}', '"', '\\', '\n', '\t', '\u0000', '中', ' '];
    const makeString = (): string => {
      let s = '';
      for (let i = 0, len = rand(6); i < len; i += 1) {
        s += CHARS[rand(CHARS.length)] as string;
      }
      return s;
    };
    const makeValue = (depth: number): unknown => {
      const kind = rand(depth <= 0 ? 4 : 6);
      if (kind === 0) {
        return null;
      }
      if (kind === 1) {
        return rand(2) === 0;
      }
      if (kind === 2) {
        return rand(1000) - 500;
      }
      if (kind === 3) {
        return makeString();
      }
      if (kind === 4) {
        return Array.from({ length: rand(4) }, () => makeValue(depth - 1));
      }
      const obj: Record<string, unknown> = {};
      for (let i = 0, len = rand(4); i < len; i += 1) {
        obj[`${makeString()}${String(i)}`] = makeValue(depth - 1);
      }
      return obj;
    };

    let checkedAstral = 0;
    let checkedEscapes = 0;
    for (let trial = 0; trial < 5000; trial += 1) {
      const value = makeValue(3);
      const encoded = JSON.stringify(value);
      const truth = Buffer.byteLength(encoded, 'utf8');
      if (encoded.includes('\u{1F600}')) {
        checkedAstral += 1;
      }
      if (encoded.includes('\\')) {
        checkedEscapes += 1;
      }
      // Given a budget it fits in, the preflight must report the EXACT byte count
      expect(serializedSizeWithin(value, truth)).toBe(truth);
      // And one byte short of it, it must refuse
      expect(serializedSizeWithin(value, truth - 1)).toBeUndefined();
    }
    // The corpus must contain what it claims to test
    expect(checkedAstral).toBeGreaterThan(100);
    expect(checkedEscapes).toBeGreaterThan(100);
  });

  it.each([
    ['an undefined array member', { x: [undefined] }],
    // oxlint-disable-next-line no-sparse-arrays -- the array hole is the case under test: serializedSizeWithin must refuse it, not the already-covered undefined-member case above
    ['a sparse array hole', { x: [1, , 3] }],
    ['an object with a toJSON hook', { x: new Date(0) }],
    ['a bigint', { x: 1n }],
    [
      'a cycle',
      (() => {
        const node: Record<string, unknown> = {};
        node['self'] = node;
        return node;
      })(),
    ],
  ])('refuses %s rather than mis-sizing it', (_label, value) => {
    // The exported writers take Record<string, unknown>, which admits more than
    // the sizer is exact for. An earlier version assumed the narrower domain in
    // a comment; it is now ENFORCED, because an inexact size breaks the
    // write-then-read invariant for any caller of the exported store.
    // Concretely: JSON.stringify({x:[undefined]}) is 12 bytes and an earlier
    // walker counted 8.
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrow(/round-trip exactly/u);
  });

  it.each([
    // oxlint-disable-next-line unicorn/new-for-builtins, no-new-wrappers -- boxed primitives are the value under test: serializedSizeWithin must refuse them, and the unboxed-literal rewrite these rules suggest is a plain primitive, which defeats the test
    ['a boxed number', { x: new Number(5) }],
    // oxlint-disable-next-line unicorn/new-for-builtins, no-new-wrappers -- boxed primitives are the value under test: serializedSizeWithin must refuse them, and the unboxed-literal rewrite these rules suggest is a plain primitive, which defeats the test
    ['a boxed string', { x: new String('a') }],
    // oxlint-disable-next-line unicorn/new-for-builtins, no-new-wrappers -- boxed primitives are the value under test: serializedSizeWithin must refuse them, and the unboxed-literal rewrite these rules suggest is a plain primitive, which defeats the test
    ['a boxed boolean', { x: new Boolean(true) }],
  ])('refuses %s, which stringifies as a primitive', (_label, value) => {
    // JSON.stringify(new Number(5)) is '5'; a walker using Object.entries sees
    // no entries and counts '{}' — a boxed primitive would look like an empty
    // plain-object tree and be accepted, when it must be refused.
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrow(/round-trip exactly/u);
  });

  it('refuses an enumerable getter, which could answer twice', () => {
    // Worse than inexact: invoking the getter separately for measuring and
    // for serializing would let it answer small for the preflight and
    // over-budget for the stringify that followed — defeating the check
    // itself. The walk reads each property's descriptor instead of invoking
    // it, so an accessor property is refused outright, without the getter
    // ever running.
    let calls = 0;
    const value = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        calls += 1;
        return calls === 1 ? 'a' : 'z'.repeat(100_000_000);
      },
    });
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrow(/round-trip exactly/u);
  });

  it('refuses a top-level undefined, which stringifies to no string at all', () => {
    expect(() => serializedSizeWithin(undefined, 1_000_000)).toThrow(/not a JSON object/u);
  });

  it('still accepts a null-prototype object, which stringifies normally', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(serializedSizeWithin(value, 1_000_000)).toBe(
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    );
  });

  it('refuses the same values at the writer, before anything is persisted', async () => {
    const fs = memoryCacheFs();
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: { ...DOC, bad: [undefined] } })),
    ).rejects.toMatchObject({ code: 'validation' });
    expect([...fs.files.keys()]).toEqual([]);
  });

  it('measures bytes, not UTF-16 units, on the minimal counter-example', () => {
    const value = { x: `é${'\u{1F600}'}` };
    const encoded = JSON.stringify(value);
    expect(encoded).toHaveLength(11);
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(14);
    // An earlier version answered 11 here and let the document through
    expect(serializedSizeWithin(value, 14)).toBe(14);
    expect(serializedSizeWithin(value, 13)).toBeUndefined();
  });

  it('keeps the writer and reader caps in agreement (the write-then-read invariant)', async () => {
    // The end-to-end property: anything the writer accepts, the reader reads
    // back. A document of multibyte text sized just under the cap must survive
    // the round trip rather than being rejected as corrupt on first read.
    const fs = memoryCacheFs();
    const padding = 'é'.repeat(1024);
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: { ...DOC, padding } }));
    const readResult = await readCacheEntry(LAYOUT, fs);
    expect(readResult.kind).toBe('hit');
  });
});

describe('serializeWithinBudget: the single pass the sizer and the writer now share', () => {
  it('serializeWithinBudget is byte-identical to JSON.stringify for a JSON-safe tree', () => {
    const doc = { a: 1, b: ['x', { c: true, d: null }], 'k"q': 'v\nw', e: [] };
    expect(serializeWithinBudget(doc, 10_000)).toBe(JSON.stringify(doc));
  });

  it('returns undefined (not a size) when serialization would exceed the budget', () => {
    expect(serializeWithinBudget({ a: 'x'.repeat(100) }, 10)).toBeUndefined();
  });

  it('refuses an accessor member via its descriptor, never invoking the getter', () => {
    // The single pass rejects an accessor from getOwnPropertyDescriptor WITHOUT
    // reading it, so there is no second, separate serialization that could read
    // a different value — the divergence the two-traversal design allowed is
    // structurally gone. (The getter must not run at all.)
    let getterRan = false;
    const doc = {
      get a() {
        getterRan = true;
        return 'x';
      },
    };
    expect(() => serializeWithinBudget(doc, 10_000)).toThrow(/round-trip exactly/u);
    expect(getterRan).toBe(false);
  });

  it('still refuses undefined, toJSON hooks, and cycles', () => {
    expect(() => serializeWithinBudget(undefined, 10)).toThrow(/not a JSON object/u);
    expect(() => serializeWithinBudget({ toJSON: () => 1 }, 10)).toThrow(/round-trip exactly/u);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => serializeWithinBudget(cyclic, 10_000)).toThrow(/round-trip exactly/u);
  });

  it('rejects a toJSON accessor via its descriptor without invoking the getter', () => {
    let getterRan = false;
    const doc: Record<string, unknown> = { a: 1 };
    Object.defineProperty(doc, 'toJSON', {
      enumerable: false,
      configurable: true,
      get() {
        getterRan = true;
        (doc as { a: number }).a = 999;
      },
    });
    expect(() => serializeWithinBudget(doc, 10_000)).toThrow(/round-trip exactly/u);
    expect(getterRan).toBe(false);
  });

  it('serializes a non-function toJSON data property byte-identically to JSON.stringify', () => {
    const doc = { toJSON: 'literal', b: 2 };
    expect(serializeWithinBudget(doc, 10_000)).toBe(JSON.stringify(doc));
  });
});

describe('crash between the object write and the metadata commit', () => {
  // The old crash-safety argument didn't hold: with a fixed accepted/spec.json
  // the new bytes REPLACED the old ones before meta.json was rewritten, so in
  // that window — and permanently after a crash in it — the live metadata
  // described bytes that were already gone. These cases drive that exact
  // window deterministically. Ten probabilistic subprocess runs cannot target
  // it at all.

  const failAfterObjectWrite = (fs: MemoryCacheFs): void => {
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      if (path === LAYOUT.metaPath) {
        // The process dies here: the object is durable, the commit is not
        return Promise.reject(new Error('crash before the metadata commit'));
      }
      return inner(path, data);
    };
  };

  it('leaves the previous accepted generation fully readable', async () => {
    const fs = await seeded();
    const before = metaOf(fs);
    failAfterObjectWrite(fs);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 })),
    ).rejects.toThrow('crash before the metadata commit');

    // The critical assertion: a reader still gets the PREVIOUS generation,
    // hash-verified. Under the old fixed-path layout this read corrupt, because the
    // old bytes had been overwritten by the new ones.
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') {
      expect.unreachable('expected the previous generation to survive');
    }
    expect(result.entry.acceptedDocument).toEqual(DOC);
    expect(result.entry.meta.acceptedContentHash).toBe(before.acceptedContentHash);
  });

  it('leaves the new object orphaned rather than authoritative', async () => {
    const fs = await seeded();
    failAfterObjectWrite(fs);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 })),
    ).rejects.toThrow();
    // Both objects exist; meta.json decides which one counts, and it still
    // names the old one
    expect(objectNamesOf(fs)).toContain(`${hashContent(DOC_V2_TEXT)}.json`);
    expect(metaOf(fs).acceptedContentHash).toBe(hashContent(DOC_TEXT));
  });

  it('reclaims the orphan on the next successful commit', async () => {
    const fs = await seeded();
    failAfterObjectWrite(fs);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 })),
    ).rejects.toThrow();
    expect(objectNamesOf(fs)).toHaveLength(2);

    // A later successful write collects whatever the crashed attempt left
    const clean = memoryCacheFs();
    clean.files = fs.files;
    clean.dirs = fs.dirs;
    await writeAccepted(LAYOUT, clean, acceptedInput({ fetchedAt: 1_700_000_200_000 }));
    expect(objectNamesOf(clean)).toEqual([`${hashContent(DOC_TEXT)}.json`]);
  });

  it('releases the lock so the namespace is not wedged by the crash', async () => {
    const fs = await seeded();
    failAfterObjectWrite(fs);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: 1_700_000_100_000 })),
    ).rejects.toThrow();
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });
});

describe('the discriminator is derived, not supplied', () => {
  it('refuses a document that declares no usable OpenAPI version', async () => {
    // A caller can no longer label an entry: only the bytes decide, so an
    // unusable declaration has to fail at the writer rather than produce an
    // entry the next read rejects
    const fs = memoryCacheFs();
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: { openapi: '2.0', paths: {} } })),
    ).rejects.toMatchObject({ code: 'validation' });
    expect([...fs.files.keys()]).toEqual([]);
  });

  it('round-trips whatever the document declares', async () => {
    const a = memoryCacheFs();
    await writeAccepted(LAYOUT, a, acceptedInput());
    expect(metaOf(a).openapiVersion).toBe('3.1');
    const b = memoryCacheFs();
    await writeAccepted(LAYOUT, b, acceptedInput({ document: DOC_30 }));
    expect(metaOf(b).openapiVersion).toBe('3.0');
  });

  it('cannot persist an entry its own next read would reject', async () => {
    // The key property: writer and reader now agree by
    // construction, because one function decides the discriminator for both
    for (const document of [DOC, DOC_30, DOC_V2]) {
      const fs = memoryCacheFs();
      await writeAccepted(LAYOUT, fs, acceptedInput({ document }));
      const readResult = await readCacheEntry(LAYOUT, fs);
      expect(readResult.kind).toBe('hit');
    }
  });
});

describe('cache writes and secret hygiene', () => {
  it.each([
    ['a query string', 'https://api.example.com/openapi.json?token=super-secret'],
    ['a bare query marker', 'https://api.example.com/openapi.json?'],
    ['a fragment', 'https://api.example.com/openapi.json#frag'],
    ['userinfo credentials', 'https://user:super-secret@api.example.com/openapi.json'],
  ])('refuses to persist a display source carrying %s', async (_label, displaySource) => {
    const fs = memoryCacheFs();
    await expect(writeAccepted(LAYOUT, fs, acceptedInput({ displaySource }))).rejects.toMatchObject(
      { code: 'validation' },
    );
    expect(fs.files.has(LAYOUT.metaPath)).toBe(false);
    // The serializeMeta check runs before any object is written, so the
    // refusal leaves the object store empty rather than orphaning bytes
    expect(objectNamesOf(fs)).toEqual([]);
  });

  it('never echoes the refused display source', async () => {
    const fs = memoryCacheFs();
    try {
      await writeAccepted(
        LAYOUT,
        fs,
        acceptedInput({ displaySource: 'https://api.example.com/o.json?token=super-secret' }),
      );
      expect.unreachable('expected a validation error');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  it('never lets a secret or a query string reach any written file', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    const onDisk = [...fs.files.values()].join('\n');
    expect(onDisk).not.toContain('super-secret');
    expect(onDisk).not.toContain('?');
    expect(onDisk).toContain('https://api.example.com/openapi.json');
  });

  it('keeps an absolute file path as its own display source', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ displaySource: '/abs/specs/petstore.yaml' }));
    expect(metaOf(fs).displaySource).toBe('/abs/specs/petstore.yaml');
  });
});

describe('writeCandidate', () => {
  it('stores the candidate without touching the accepted baseline', async () => {
    const fs = await seeded();
    const acceptedBefore = metaOf(fs).acceptedContentHash;
    const { candidateContentHash } = await writeCandidate(LAYOUT, fs, candidateInput());
    expect(candidateContentHash).toBe(hashContent(DOC_V2_TEXT));
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
    const meta = metaOf(fs);
    expect(meta.acceptedContentHash).toBe(acceptedBefore);
    // One nested member, so the two hashes cannot drift apart
    expect(meta.candidate).toEqual({
      contentHash: candidateContentHash,
      sourceContentHash: SOURCE_HASH_V2,
      title: 'Petstore v2',
      specVersion: '2.0.0',
    });
    // Both generations are on disk at once, each under its own name
    expect(objectNamesOf(fs)).toEqual(
      [`${acceptedBefore}.json`, `${candidateContentHash}.json`].toSorted(),
    );
  });

  it('records the validators returned WITH the candidate', async () => {
    // Copying the accepted entry's stale validators forward instead of the
    // candidate's own would make the next conditional request ask the server
    // about a representation the cache no longer held
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, {
      ...candidateInput(),
      etag: '"v2"',
      lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
    });
    expect(metaOf(fs)).toMatchObject({
      etag: '"v2"',
      lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
    });
  });

  it('persists the candidate own title and version, so promotion need not re-derive them', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    const meta = metaOf(fs);
    // What is SERVED is still the accepted entry, so the top-level fields keep
    // describing it — the candidate's own labels live inside meta.candidate
    expect(meta).toMatchObject({ title: 'Petstore', specVersion: '1.0.0' });
    expect(meta.candidate).toMatchObject({ title: 'Petstore v2', specVersion: '2.0.0' });
  });

  it('bumps fetchedAt so the TTL restarts from the successful check', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    expect(metaOf(fs).fetchedAt).toBe(1_700_000_500_000);
  });

  it('preserves the accepted title and version, which are what cache list shows', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    expect(metaOf(fs)).toMatchObject({ title: 'Petstore', specVersion: '1.0.0' });
  });

  it('writes the candidate object before meta.json', async () => {
    const fs = await seeded();
    const order: string[] = [];
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      order.push(path);
      return inner(path, data);
    };
    await writeCandidate(LAYOUT, fs, candidateInput());
    expect(order).toEqual([objectPath(LAYOUT, hashContent(DOC_V2_TEXT)), LAYOUT.metaPath]);
  });

  it('never touches the accepted object while storing a candidate', async () => {
    const fs = await seeded();
    const acceptedHash = metaOf(fs).acceptedContentHash;
    const written: string[] = [];
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      written.push(path);
      return inner(path, data);
    };
    await writeCandidate(LAYOUT, fs, candidateInput());
    expect(written).not.toContain(objectPath(LAYOUT, acceptedHash));
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it('refuses a candidate over the persisted-document budget before the lock', async () => {
    const fs = await seeded();
    const huge = {
      openapi: '3.1.0',
      info: { title: 'Big', version: '2' },
      blob: 'x'.repeat(CACHE_MAX_PERSISTED_BYTES),
    };
    await expect(
      writeCandidate(LAYOUT, fs, { ...candidateInput(), document: huge }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(metaOf(fs).candidate).toBeUndefined();
  });

  it('refuses when there is no accepted baseline to attach to', async () => {
    await expect(writeCandidate(LAYOUT, memoryCacheFs(), candidateInput())).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('refuses on a corrupt entry rather than replacing the baseline', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'not json');
    await expect(writeCandidate(LAYOUT, fs, candidateInput())).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cache clear') as string,
    });
    // Reading via metaOf would throw here — the entry is deliberately
    // unparsable — so this asserts against the object store directly: no
    // candidate bytes were laid down beside the broken baseline
    const candidatePath = objectPath(LAYOUT, hashContent(DOC_V2_TEXT));
    expect(fs.files.has(candidatePath)).toBe(false);
    expect(fs.files.get(LAYOUT.metaPath)).toBe('not json');
  });

  it('refuses a candidate title beyond the metadata bounds before writing anything', async () => {
    const fs = await seeded();
    await expect(
      writeCandidate(LAYOUT, fs, { ...candidateInput(), title: 'x'.repeat(257) }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(metaOf(fs).candidate).toBeUndefined();
  });

  it('writeCandidate refuses while another process holds the namespace lock', async () => {
    const fs = await seeded();
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'other', acquiredAt: 1_700_000_500_000 }),
    );
    await expect(writeCandidate(LAYOUT, fs, candidateInput())).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

// ---------------------------------------------------------------------------
// Supplementary coverage. The suite above proves the write-side transactional
// invariants but never exercises touchRevalidated directly and never asserts
// a `corrupt` outcome from readCacheEntry, so several store.ts branches -
// most of them the corrupt-detection paths this module relies on - were
// unreached. These tests close that gap so the module's own coverage gate
// can be met honestly rather than by lowering the threshold.
// ---------------------------------------------------------------------------

describe('touchRevalidated', () => {
  it('updates fetchedAt and validators without touching either object', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    const before = metaOf(fs);
    await touchRevalidated(
      LAYOUT,
      fs,
      1_700_001_000_000,
      {
        etag: '"v3"',
        lastModified: 'Fri, 23 Oct 2026 07:28:00 GMT',
      },
      { expected: 'unchecked' },
    );
    const after = metaOf(fs);
    expect(after.fetchedAt).toBe(1_700_001_000_000);
    expect(after.etag).toBe('"v3"');
    expect(after.lastModified).toBe('Fri, 23 Oct 2026 07:28:00 GMT');
    // Neither slot's content moved
    expect(after.acceptedContentHash).toBe(before.acceptedContentHash);
    expect(after.candidate).toEqual(before.candidate);
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
  });

  it('preserves existing validators when the revalidation returns none', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ etag: '"v1"' }));
    await touchRevalidated(LAYOUT, fs, 1_700_001_000_000, {}, { expected: 'unchecked' });
    expect(metaOf(fs).etag).toBe('"v1"');
    expect(metaOf(fs).fetchedAt).toBe(1_700_001_000_000);
  });

  it('refuses to revalidate a namespace with no accepted baseline at all', async () => {
    await expect(
      touchRevalidated(LAYOUT, memoryCacheFs(), 1_700_000_000_000, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('refuses on a corrupt entry rather than healing it', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'not json');
    await expect(
      touchRevalidated(LAYOUT, fs, 1_700_000_000_000, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cache clear') as string,
    });
  });

  it('touchRevalidated refuses while another process holds the namespace lock', async () => {
    const fs = await seeded();
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'other', acquiredAt: 1_700_000_000_000 }),
    );
    await expect(
      touchRevalidated(LAYOUT, fs, 1_700_000_000_000, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('readCacheEntry corrupt states', () => {
  it('reports corrupt when meta.json exceeds its read budget', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, `x${'y'.repeat(CACHE_META_MAX_BYTES)}`);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
  });

  it('reports meta over-budget distinctly from a read failure', async () => {
    const fs = await seeded(); // A fake whose metaPath exists
    fs.readFileTextCapped = () =>
      Promise.reject(
        validationError('cache file "x" is 99999 bytes — exceeds the 65536-byte budget'),
      );
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read).toMatchObject({
      kind: 'corrupt',
      reason: expect.stringMatching(/exceeds its .*budget/u) as string,
    });
  });

  it('reports a meta read failure as unreadable, not over-budget', async () => {
    const fs = await seeded();
    fs.readFileTextCapped = () =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read).toMatchObject({
      kind: 'corrupt',
      reason: expect.stringMatching(/could not be read/u) as string,
    });
    expect((read as { reason: string }).reason).not.toMatch(/budget/u);
  });

  it('reports a miss, not corrupt, when meta.json is concurrently unlinked between the existence probe and the read (TOCTOU)', async () => {
    // Meta reading does pathExists(metaPath) THEN readFileTextCapped(metaPath):
    // a concurrent clear can unlink the file in between. That is a legitimate
    // miss (the one outcome that may re-enter trust-on-first-use), not
    // damage — the entry was not corrupt, it was raced away underneath us.
    const fs = await seeded();
    fs.readFileTextCapped = (path) =>
      path === LAYOUT.metaPath
        ? Promise.reject(enoentError('unlinked between probe and read'))
        : Promise.reject(new Error('unexpected read'));
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read).toEqual({ kind: 'miss' });
  });

  it('reports corrupt when meta.json is not valid JSON', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'not json');
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('is not valid JSON') as string,
    });
  });

  it('reports corrupt when meta.json does not match the schema', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, JSON.stringify({ ...metaOf(fs), extra: 1 }));
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('does not match the expected schema') as string,
    });
  });

  it('reports corrupt when the accepted object bytes do not match the recorded hash', async () => {
    const fs = await seeded();
    fs.files.set(objectPath(LAYOUT, metaOf(fs).acceptedContentHash), DOC_V2_TEXT);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('does not match its recorded content hash') as string,
    });
  });

  it('reports corrupt when the accepted bytes are not valid JSON at all', async () => {
    const fs = await seeded();
    const junkText = 'not json at all';
    const junkHash = hashContent(junkText);
    fs.files.set(objectPath(LAYOUT, junkHash), junkText);
    fs.files.set(LAYOUT.metaPath, JSON.stringify({ ...metaOf(fs), acceptedContentHash: junkHash }));
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('is not a JSON object') as string,
    });
  });

  it('reports corrupt when the accepted object is valid JSON but not an object (an array)', async () => {
    const fs = await seeded();
    const arrayText = JSON.stringify([1, 2, 3]);
    const arrayHash = hashContent(arrayText);
    fs.files.set(objectPath(LAYOUT, arrayHash), arrayText);
    fs.files.set(
      LAYOUT.metaPath,
      JSON.stringify({ ...metaOf(fs), acceptedContentHash: arrayHash }),
    );
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('is not a JSON object') as string,
    });
  });

  it('reports corrupt when the document declares an OpenAPI version that does not match its metadata', async () => {
    const fs = await seeded();
    const mismatched = { openapi: '3.0.3', info: { title: 'X', version: '1' }, paths: {} };
    const mismatchedText = JSON.stringify(mismatched);
    const mismatchedHash = hashContent(mismatchedText);
    fs.files.set(objectPath(LAYOUT, mismatchedHash), mismatchedText);
    fs.files.set(
      LAYOUT.metaPath,
      JSON.stringify({ ...metaOf(fs), acceptedContentHash: mismatchedHash, openapiVersion: '3.1' }),
    );
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining(
        'declares an OpenAPI version that does not match its metadata',
      ) as string,
    });
  });
});

describe('readCacheEntry retry loop', () => {
  it('retries once and succeeds when a transient object read recovers', async () => {
    const fs = await seeded();
    const objPath = objectPath(LAYOUT, metaOf(fs).acceptedContentHash);
    const inner = fs.readFileTextCapped;
    let calls = 0;
    fs.readFileTextCapped = (path, maxBytes) => {
      if (path === objPath) {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(enoentError('transient read failure'));
        }
      }
      return inner(path, maxBytes);
    };
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('hit');
    expect(calls).toBeGreaterThan(1);
  });

  it('reports corrupt once the retry budget is exhausted and the object never recovers', async () => {
    const fs = await seeded();
    const objPath = objectPath(LAYOUT, metaOf(fs).acceptedContentHash);
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = (path, maxBytes) =>
      path === objPath ? Promise.reject(enoentError('always fails')) : inner(path, maxBytes);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('could not be read') as string,
    });
  });

  it('reports miss when a concurrent clear removes the entry mid-read', async () => {
    const fs = await seeded();
    const objPath = objectPath(LAYOUT, metaOf(fs).acceptedContentHash);
    const inner = fs.readFileTextCapped;
    let failedOnce = false;
    fs.readFileTextCapped = (path, maxBytes) => {
      if (path === objPath && !failedOnce) {
        failedOnce = true;
        fs.files.delete(LAYOUT.metaPath);
        return Promise.reject(enoentError('object vanished mid-read'));
      }
      return inner(path, maxBytes);
    };
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({ kind: 'miss' });
  });

  it('propagates a non-absence I/O error on the object read instead of treating it as a lost race', async () => {
    // EACCES/EIO under a STABLE meta is not a concurrent commit or a deletion
    // — it is a genuine I/O failure and must propagate (like the module's
    // other isCacheAbsence sites), not get counted toward the static-confirm
    // budget and eventually reported as a merely-corrupt entry.
    const fs = await seeded();
    const objPath = objectPath(LAYOUT, metaOf(fs).acceptedContentHash);
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = (path, maxBytes) =>
      path === objPath
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : inner(path, maxBytes);
    await expect(readCacheEntry(LAYOUT, fs)).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('serializedSizeWithin: array-specific enforcement', () => {
  it('refuses an array cycle', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => serializedSizeWithin({ x: arr }, 1_000_000)).toThrow(/round-trip exactly/u);
  });

  it('refuses an array subclass, which is outside the domain', () => {
    class MyArray extends Array {}
    const subclassed = new MyArray();
    subclassed.push(1, 2, 3);
    const value = { x: subclassed as unknown };
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrow(/round-trip exactly/u);
  });

  it('refuses an array carrying a toJSON hook', () => {
    const arr = Object.assign([1, 2, 3], { toJSON: () => 'not an array' });
    expect(() => serializedSizeWithin({ x: arr }, 1_000_000)).toThrow(/round-trip exactly/u);
  });
});

describe('serializedSizeWithin: object member omission matches JSON.stringify', () => {
  it('skips undefined, function, and symbol members exactly as JSON.stringify does', () => {
    const value = { x: { a: undefined, b: (): void => {}, c: Symbol('s'), d: 1 } };
    const encoded = JSON.stringify(value);
    const truth = Buffer.byteLength(encoded, 'utf8');
    expect(serializedSizeWithin(value, truth)).toBe(truth);
  });
});

describe('commitEntry: an existing object under the target hash is verified, not trusted', () => {
  it('refuses to persist over a tampered object sharing the new hash', async () => {
    const fs = memoryCacheFs();
    const targetHash = hashContent(DOC_TEXT);
    // A file already sits at the exact path the write is about to use, but its
    // bytes do not hash to that name — evidence of tampering or damage
    await fs.mkdirSecure(LAYOUT.objectsDir);
    await fs.writeFileAtomic(objectPath(LAYOUT, targetHash), 'not the real bytes');
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cache clear') as string,
    });
  });
});

describe('assertRedactedDisplaySource: a malformed http(s) URL', () => {
  it('refuses a display source that matches the scheme prefix but fails URL parsing', async () => {
    const fs = memoryCacheFs();
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ displaySource: 'https://' })),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('serializeMeta: the schema is the final safety net', () => {
  it('refuses an accepted title beyond the metadata bounds via the schema check', async () => {
    const fs = memoryCacheFs();
    const overlongTitle = 'x'.repeat(257);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ title: overlongTitle })),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

const NOW = 1_700_001_000_000;

const withCandidate = async (): Promise<MemoryCacheFs> => {
  const fs = await seeded();
  await writeCandidate(LAYOUT, fs, candidateInput());
  return fs;
};

// These concurrency cases live here, next to promotion and clearing, because
// they are about what a lock-free reader observes while another operation
// mutates the namespace.

describe('object lifetime vs lock-free readers', () => {
  it('retries against the new generation when GC collected the one it was reading', async () => {
    // Immutable objects do NOT by themselves make immediate reclamation safe.
    // A reader loads generation A, a writer commits B and collects A's object,
    // and the reader — still holding A's hash — finds nothing. An earlier
    // version reported that healthy cache as corrupt.
    const fs = await seeded();
    const oldHash = metaOf(fs).acceptedContentHash;
    let swapped = false;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      // The instant the reader reaches for generation A's object, let a
      // concurrent commit land and reclaim it
      if (!swapped && path === objectPath(LAYOUT, oldHash)) {
        swapped = true;
        await writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: NOW }));
      }
      return inner(path, maxBytes);
    };
    const result = await readCacheEntry(LAYOUT, fs);
    // Not corrupt: the entry is perfectly healthy, it just moved
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') {
      expect.unreachable('expected the retry to observe the new generation');
    }
    expect(result.entry.acceptedDocument).toEqual(DOC_V2);
  });

  it('still reports corrupt when the object is gone and the generation did NOT move', async () => {
    // The complement: without a concurrent commit, a missing object is real
    // damage and must stay fail-closed
    const fs = await seeded();
    fs.files.delete(objectPath(LAYOUT, metaOf(fs).acceptedContentHash));
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
  });

  it('reports a miss, not corrupt, when a concurrent clear removed the entry', async () => {
    // An earlier retry only recognised a CHANGED hash, so a clear landing
    // mid-read left the reader reporting corrupt on an entry the operator had
    // simply asked to delete — which would have failed the clear-vs-read
    // expectation that the reader stays exit 0.
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    let cleared = false;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (!cleared && path === objectPath(LAYOUT, hash)) {
        cleared = true;
        await clearNamespace(LAYOUT, fs, NOW);
      }
      return inner(path, maxBytes);
    };
    expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });
  });

  it('survives a clear followed by re-seeding the SAME content', async () => {
    // A hash-change check cannot detect this: the new generation has the same
    // content hash as the one that was collected, so "did the hash change" is
    // false even though the object really was recreated underneath the reader.
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    let reseeded = false;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (!reseeded && path === objectPath(LAYOUT, hash)) {
        reseeded = true;
        await clearNamespace(LAYOUT, fs, NOW);
        // Identical document, therefore identical hash
        await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: NOW + 1 }));
      }
      return inner(path, maxBytes);
    };
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') {
      expect.unreachable('expected the retry to observe the re-seeded generation');
    }
    expect(result.entry.acceptedDocument).toEqual(DOC);
  });

  it('gives up after the bounded number of attempts rather than spinning', async () => {
    // The retry must terminate even against an adversarial filesystem that
    // keeps the object missing while metadata stays readable.
    //
    // This asserts against a locally named constant rather than
    // `READ_RETRY_LIMIT + 1`, because that constant is PRIVATE to store.ts —
    // never exported, never imported here, so the identifier would be unbound
    // and the file could not typecheck. The bound is named locally instead of
    // exported, because the behaviour under test is that the loop terminates
    // within its documented bound, not that an implementation constant is part
    // of the public API. Exporting it to make the test compile would widen the
    // contract to satisfy a test.
    //
    // Bounded by the static-confirm path: the initial object read plus up to
    // READ_STATIC_CONFIRM_LIMIT (2) re-confirmations on an unchanging generation
    // before it reports corrupt; 4 is a safe ceiling (the old READ_RETRY_LIMIT
    // this once named was removed with the generation-gated retry).
    const EXPECTED_MAX_READ_ATTEMPTS = 4;
    const fs = await seeded();
    let reads = 0;
    const metaText = fs.files.get(LAYOUT.metaPath) ?? '';
    fs.readFileTextCapped = (path) =>
      path === LAYOUT.metaPath
        ? Promise.resolve(metaText)
        : ((reads += 1), Promise.reject(enoentError('ENOENT')));
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
    expect(reads).toBeLessThanOrEqual(EXPECTED_MAX_READ_ATTEMPTS);
  });

  it('does not report corrupt when four concurrent commits keep replacing the object', async () => {
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    let failures = 0;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (path === objectPath(LAYOUT, hash) && failures < 4) {
        failures += 1;
        // A concurrent commit: identical content (same hash) but a NEW
        // generation (advanced fetchedAt), and the object momentarily missing.
        await clearNamespace(LAYOUT, fs, NOW);
        await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: NOW + failures }));
        throw enoentError('ENOENT');
      }
      return inner(path, maxBytes);
    };
    const read = await readCacheEntry(LAYOUT, fs);
    // A lost race across four commits is not corruption — the fifth read hits.
    expect(read.kind).toBe('hit');
  });

  it('hits when the object is restored under the SAME generation (same content, same timestamp)', async () => {
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    // Base on the SEEDED fetchedAt, not NOW — the seed's timestamp differs from
    // NOW, so re-seeding at NOW would ADVANCE the generation. Use the seeded
    // value so the generation key is genuinely unchanged.
    const initial = metaOf(fs).fetchedAt;
    let raced = false;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (!raced && path === objectPath(LAYOUT, hash)) {
        raced = true;
        // Clear then re-seed IDENTICAL content at the SAME fetchedAt: the
        // generation key does not change, but the object reappears. The initial
        // read already lost the race (throws), the static-confirm re-loop finds it.
        await clearNamespace(LAYOUT, fs, NOW);
        await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: initial }));
        throw enoentError('ENOENT');
      }
      return inner(path, maxBytes);
    };
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read.kind).toBe('hit');
  });

  it('resets the static-confirm budget after a generation advance', async () => {
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    // Base on the SEEDED fetchedAt so the FIRST failing read is a true STATIC
    // (same generation), not an advance — NOW differs from the seed.
    // Failing-read generations: static A(initial), advance to B, two statics under B.
    const initial = metaOf(fs).fetchedAt;
    const timeline = [initial, initial + 1, initial + 1, initial + 1];
    let call = 0;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (path === objectPath(LAYOUT, hash) && call < timeline.length) {
        const fetchedAt = timeline[call]!;
        call += 1;
        await clearNamespace(LAYOUT, fs, NOW);
        await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt }));
        throw enoentError('ENOENT');
      }
      return inner(path, maxBytes); // Fifth read: the object is present
    };
    // Only reachable if the advance RESET the static budget so generation B gets
    // its own two confirmations; without the reset this corrupts on the 4th read.
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read.kind).toBe('hit');
  });

  it('gives generation B its own static-confirm budget when the advance is observed at the TOP of the loop, not inside the advance branch', async () => {
    // The advance branch's own staticConfirms reset only fires when THIS
    // iteration's failed-read recheck sees a different generation. It does
    // NOT cover the case where a commit lands between one iteration's static
    // confirm and the NEXT iteration's own top-of-loop readMetaFile call — the
    // loop silently starts reading generation B while staticConfirms still
    // carries A's leaked count.
    const fs = await seeded();
    const hash = metaOf(fs).acceptedContentHash;
    const initial = metaOf(fs).fetchedAt;
    let metaCalls = 0;
    let objectCalls = 0;
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = async (path, maxBytes) => {
      if (path === LAYOUT.metaPath) {
        metaCalls += 1;
        if (metaCalls === 3) {
          // The THIRD meta read is the top-of-loop call for iteration 2 — land
          // the concurrent commit to generation B right before it resolves, so
          // this read (not the advance branch's own recheck) is what first
          // observes B.
          await clearNamespace(LAYOUT, fs, NOW);
          await writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: initial + 1 }));
        }
        return inner(path, maxBytes);
      }
      if (path === objectPath(LAYOUT, hash) && objectCalls < 3) {
        objectCalls += 1;
        // Iteration 1: A fails once, its recheck still sees A (one static
        // confirm spent). Iteration 2: B fails once, its recheck sees B
        // (should be a FRESH static budget). Iteration 3: B fails a second
        // time — only reachable if generation B's budget was not leaked from
        // A's already-spent confirmation.
        throw enoentError('ENOENT');
      }
      return inner(path, maxBytes);
    };
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read.kind).toBe('hit');
  });

  it('terminates a sustained top-of-loop advance storm at the generation-retry cap instead of spinning', async () => {
    // A generation advance detected at the TOP of the loop resets
    // staticConfirms (Fix 1) but must ALSO consume the generation-retry
    // budget the advance branch already does, or a sustained storm that
    // advances every top-of-loop meta read (while each failed-read recheck
    // sees only a STATIC generation, never triggering the advance branch
    // itself) would reset staticConfirms forever and never terminate.
    //
    // The fake advances a fabricated meta's fetchedAt on every ODD
    // readFileTextCapped(metaPath) call (a top-of-loop read) and holds it
    // steady on every EVEN call (the failed-read recheck), so every
    // iteration looks like "the generation just advanced, and its own
    // recheck confirms it, static" — exactly the storm shape. The object
    // read always ENOENTs. Capped at STORM_CEILING advances so the test
    // cannot hang even if the fix under test is absent — after the ceiling
    // the fake freezes on the last generation, which then eventually
    // exhausts the (small) static-confirm budget and returns corrupt on its
    // own, bounding even the pre-fix run.
    const STORM_CEILING = 300;
    const fs = await seeded();
    const baseMeta = metaOf(fs);
    const initial = baseMeta.fetchedAt;
    let metaCalls = 0;
    let generation = 0;
    let objectReads = 0;
    fs.readFileTextCapped = (path) => {
      if (path === LAYOUT.metaPath) {
        metaCalls += 1;
        if (metaCalls % 2 === 1 && generation < STORM_CEILING) {
          generation += 1;
        }
        return Promise.resolve(JSON.stringify({ ...baseMeta, fetchedAt: initial + generation }));
      }
      if (path === objectPath(LAYOUT, baseMeta.acceptedContentHash)) {
        objectReads += 1;
        return Promise.reject(enoentError('ENOENT'));
      }
      return Promise.reject(new Error(`unexpected read: ${path}`));
    };
    const read = await readCacheEntry(LAYOUT, fs);
    expect(read.kind).toBe('corrupt');
    // Bounded near READ_GENERATION_RETRY_CAP (64, private to store.ts — named
    // locally for the same reason as the existing "gives up" test), not
    // anywhere near the fake's 300-advance storm ceiling.
    const READ_GENERATION_RETRY_CAP_LOCAL = 64;
    expect(objectReads).toBeLessThanOrEqual(READ_GENERATION_RETRY_CAP_LOCAL + 5);
    expect(objectReads).toBeGreaterThan(READ_GENERATION_RETRY_CAP_LOCAL / 2);
  });
});

describe('readCacheEntry', () => {
  it('returns a hit with the parsed accepted document', async () => {
    const fs = await seeded();
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') {
      expect.unreachable('expected a hit');
    }
    expect(result.entry.acceptedDocument).toEqual(DOC);
    expect(result.entry.meta.acceptedContentHash).toBe(hashContent(DOC_TEXT));
  });

  it('round-trips the OpenAPI version discriminator', async () => {
    // The hit path feeds this straight to normalizeSpec without revalidating,
    // so it has to survive the write/read round trip exactly
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_30 }));
    const result = await readCacheEntry(LAYOUT, fs);
    if (result.kind !== 'hit') {
      expect.unreachable('expected a hit');
    }
    expect(result.entry.meta.openapiVersion).toBe('3.0');
  });

  it('takes no lock, so a live writer lock does not block a read', async () => {
    const fs = await seeded();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'other', acquiredAt: NOW }));
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('hit');
  });

  it('reports a miss when the namespace directory does not exist', async () => {
    expect(await readCacheEntry(LAYOUT, memoryCacheFs())).toEqual({ kind: 'miss' });
  });

  it('reports a miss for an abandoned scaffold that never held a baseline', async () => {
    // The lock creates the directory before the first commit; a crash there
    // must not brick a first-ever fetch, and the directory is evidentially
    // identical to one that was never created
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'x', acquiredAt: 0 }));
    expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });
  });

  it.each<[string, (fs: MemoryCacheFs) => void, string]>([
    // NOTE: "meta.json deleted, objects surviving" is deliberately NOT in this
    // list any more. It is a miss, covered by its own describe block above,
    // because an orphan object is not a baseline and the alternative wedged a
    // crashed first commit forever.
    [
      'meta.json is truncated mid-object',
      (fs) => {
        fs.files.set(LAYOUT.metaPath, '{"schemaVersion":1,');
      },
      'not valid JSON',
    ],
    [
      'meta.json fails zCacheMeta',
      (fs) => {
        fs.files.set(LAYOUT.metaPath, JSON.stringify({ schemaVersion: 1 }));
      },
      'expected schema',
    ],
    [
      'meta.json carries an unknown key',
      (fs) => {
        const meta = JSON.parse(fs.files.get(LAYOUT.metaPath) ?? '') as Record<string, unknown>;
        fs.files.set(LAYOUT.metaPath, JSON.stringify({ ...meta, injected: true }));
      },
      'expected schema',
    ],
    [
      'meta.json was written by a future schema version',
      (fs) => {
        const meta = JSON.parse(fs.files.get(LAYOUT.metaPath) ?? '') as Record<string, unknown>;
        fs.files.set(
          LAYOUT.metaPath,
          JSON.stringify({ ...meta, schemaVersion: CACHE_META_SCHEMA_VERSION + 1 }),
        );
      },
      'expected schema',
    ],
    [
      'meta.json exceeds its 64 KB budget',
      (fs) => {
        fs.files.set(LAYOUT.metaPath, 'x'.repeat(65_537));
      },
      'budget',
    ],
    [
      'the object meta.json names is missing',
      (fs) => {
        fs.files.delete(objectPath(LAYOUT, hashContent(DOC_TEXT)));
      },
      'could not be read',
    ],
    [
      'the accepted object does not match the hash it is filed under',
      (fs) => {
        // Content addressing makes this self-contradictory by construction: the
        // filename asserts one hash and the bytes produce another
        fs.files.set(
          objectPath(LAYOUT, hashContent(DOC_TEXT)),
          JSON.stringify({ openapi: '3.1.0', paths: {} }),
        );
      },
      'does not match',
    ],
    [
      'the accepted object is truncated and unparsable',
      (fs) => {
        fs.files.set(
          objectPath(LAYOUT, hashContent(DOC_TEXT)),
          '{"openapi":"3.1.0","info":{"title":"Tamp',
        );
      },
      'does not match',
    ],
    [
      'the accepted object is a JSON array rather than an object',
      (fs) => {
        // Filed under its own hash and named by meta, so it survives the hash
        // check and has to be rejected on shape instead
        const text = JSON.stringify([1, 2, 3]);
        const meta = JSON.parse(fs.files.get(LAYOUT.metaPath) ?? '') as Record<string, unknown>;
        fs.files.set(objectPath(LAYOUT, hashContent(text)), text);
        fs.files.set(
          LAYOUT.metaPath,
          JSON.stringify({ ...meta, acceptedContentHash: hashContent(text) }),
        );
      },
      'not a JSON object',
    ],
    [
      'meta.json names an object that was never written',
      (fs) => {
        // A dangling pointer must fail closed, not fall back to any other
        // object that happens to be lying around
        const meta = JSON.parse(fs.files.get(LAYOUT.metaPath) ?? '') as Record<string, unknown>;
        fs.files.set(
          LAYOUT.metaPath,
          JSON.stringify({ ...meta, acceptedContentHash: 'e'.repeat(64) }),
        );
      },
      'could not be read',
    ],
    [
      'meta.json carries a candidate missing one of its two hashes',
      (fs) => {
        const meta = JSON.parse(fs.files.get(LAYOUT.metaPath) ?? '') as Record<string, unknown>;
        fs.files.set(
          LAYOUT.metaPath,
          JSON.stringify({ ...meta, candidate: { contentHash: 'c'.repeat(64) } }),
        );
      },
      'expected schema',
    ],
  ])('reports corrupt when %s', async (_label, damage, needle) => {
    const fs = await seeded();
    damage(fs);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') {
      expect.unreachable('expected a corrupt result');
    }
    expect(result.reason).toContain(LAYOUT.namespace);
    expect(result.reason).toContain(needle);
  });

  it('never echoes content from the corrupt file', async () => {
    const fs = await seeded();
    fs.files.set(
      LAYOUT.metaPath,
      JSON.stringify({
        schemaVersion: 1,
        displaySource: 'https://evil.example/\u001B]0;PWNED',
        rogue: 'x'.repeat(50),
      }),
    );
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('PWNED');
    expect(serialized).not.toContain('rogue');
  });

  it('never returns a document read out of a corrupt entry', async () => {
    const fs = await seeded();
    fs.files.set(
      objectPath(LAYOUT, hashContent(DOC_TEXT)),
      JSON.stringify({ openapi: '3.1.0', paths: { '/admin': {} } }),
    );
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
    expect('entry' in result).toBe(false);
  });
});

describe('a corrupt baseline cannot be laundered by restarting', () => {
  it('refuses the entry instead of letting a changed remote become accepted', async () => {
    // Process A accepted v1 and it is the durable record of what the operator
    // approved. An attacker (or a bad disk) damages the accepted object while
    // the remote now serves v2. Restarting must NOT make v2 accepted.
    const fs = await seeded();
    expect(metaOf(fs).acceptedContentHash).toBe(hashContent(DOC_TEXT));
    fs.files.set(
      objectPath(LAYOUT, hashContent(DOC_TEXT)),
      '{"openapi":"3.1.0","info":{"title":"Tamp',
    );

    const result = await readCacheEntry(LAYOUT, fs);
    // The critical assertion: corrupt, NOT miss. Only a miss may become TOFU.
    expect(result.kind).toBe('corrupt');
    expect(result.kind).not.toBe('miss');

    // Every write path refuses too, so nothing about v2 reaches the entry
    await expect(writeCandidate(LAYOUT, fs, candidateInput())).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
    // No v2 bytes exist anywhere in the store, under any name
    expect([...fs.files.values()].join('\n')).not.toContain('Petstore v2');
    expect(metaOf(fs).candidate).toBeUndefined();
    expect(metaOf(fs).acceptedContentHash).toBe(hashContent(DOC_TEXT));
  });

  it('names cache clear as the deliberate reset path, and clearing works', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'wrecked');
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toThrow(/openapi-mcp cache clear/u);
    expect(await clearNamespace(LAYOUT, fs, NOW)).toBe(true);
    // Only after the explicit reset is the source a miss again, i.e. TOFU-able
    expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });
  });
});

// A fix for a defect the corrupt-baseline regression test above exposed.
// readMetaFile alone (meta.json's shape and schema) is not enough to decide
// whether an entry is corrupt — a damaged ACCEPTED OBJECT slipped through
// every write path that checked only readMetaFile, and the next writeAccepted
// then installed the changed remote document as the new accepted baseline:
// the entry read back as a healthy hit, which is exactly the laundering
// fail-closed corruption handling exists to forbid. Every write path
// now verifies the accepted object it is building on top of (or leaving
// untouched) before proceeding, sharing the exact hash/shape/version checks
// readCacheEntry itself uses.
describe('every write path verifies the accepted OBJECT, not just meta.json', () => {
  const damageAcceptedObject = (fs: MemoryCacheFs): void => {
    fs.files.set(
      objectPath(LAYOUT, hashContent(DOC_TEXT)),
      '{"openapi":"3.1.0","info":{"title":"Tamp',
    );
  };

  it('writeAccepted refuses to install a new baseline over a damaged one', async () => {
    const fs = await seeded();
    damageAcceptedObject(fs);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_V2, fetchedAt: NOW })),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
    // The critical property the probe found missing: no v2 bytes anywhere,
    // and the entry is still corrupt rather than a healthy hit on v2
    expect([...fs.files.values()].join('\n')).not.toContain('Petstore v2');
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
  });

  it('writeAccepted proceeds normally on a first-ever write (miss, nothing to verify)', async () => {
    // The complement: TOFU must not be blocked by a check that only applies
    // once a baseline already exists
    const fs = memoryCacheFs();
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).resolves.toBeDefined();
  });

  it('writeCandidate refuses to record a candidate beside a damaged baseline', async () => {
    const fs = await seeded();
    damageAcceptedObject(fs);
    await expect(writeCandidate(LAYOUT, fs, candidateInput())).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('promoteCandidate refuses to promote over a damaged baseline', async () => {
    const fs = await withCandidate();
    damageAcceptedObject(fs);
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('touchRevalidated refuses to record a 304 against a damaged baseline', async () => {
    const fs = await seeded();
    damageAcceptedObject(fs);
    await expect(
      touchRevalidated(LAYOUT, fs, NOW, { etag: '"v2"' }, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('reports the accepted object as unreadable, not a hash mismatch, when it is entirely gone', async () => {
    // The complement to damageAcceptedObject above: a genuinely ABSENT object
    // is a distinct branch inside assertAcceptedObjectIntact from a present
    // but tampered one, and it is the one branch none of this describe
    // block's other cases reach. It must stay distinguishable from the
    // EACCES-rethrow branch right next to it in the implementation — both
    // surface as the same exit 3, so only the message can tell them apart,
    // and it has to keep naming "cache clear" as the deliberate reset path.
    const fs = await seeded();
    fs.files.delete(objectPath(LAYOUT, hashContent(DOC_TEXT)));
    await expect(writeCandidate(LAYOUT, fs, candidateInput())).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
      message: expect.stringMatching(/cannot be read/u) as string,
    });
  });
});

describe('promoteCandidate', () => {
  it('moves the candidate to accepted and clears the candidate state', async () => {
    const fs = await withCandidate();
    const { promotedHash } = await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(promotedHash).toBe(hashContent(DOC_V2_TEXT));
    expect(acceptedTextOf(fs)).toBe(DOC_V2_TEXT);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toMatchObject({
      kind: 'hit',
      entry: { acceptedDocument: DOC_V2, meta: { acceptedContentHash: promotedHash } },
    });
    expect(metaOf(fs).candidate).toBeUndefined();
    // The superseded accepted object is collected; the promoted one stays
    expect(objectNamesOf(fs)).toEqual([`${promotedHash}.json`]);
  });

  it('promotes the exact candidate bytes, so the pinned hash stays valid', async () => {
    // Content addressing makes this structural rather than a convention: the
    // promoted object is ALREADY the candidate object. Nothing is copied, so
    // there is no re-serialization that could reorder keys and move the hash.
    const fs = await withCandidate();
    const before = candidateTextOf(fs);
    const { promotedHash } = await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(acceptedTextOf(fs)).toBe(before);
    expect(hashContent(acceptedTextOf(fs) ?? '')).toBe(promotedHash);
    expect(metaOf(fs).acceptedContentHash).toBe(CANDIDATE_HASH);
  });

  it('carries the candidate source hash into the accepted source hash', async () => {
    const fs = await withCandidate();
    await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(metaOf(fs).sourceContentHash).toBe(SOURCE_HASH_V2);
  });

  it('adopts the promoted document title and version', async () => {
    const fs = await withCandidate();
    await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(metaOf(fs)).toMatchObject({ title: 'Petstore v2', specVersion: '2.0.0' });
  });

  it('derives the OpenAPI version from the promoted document, not the accepted entry', async () => {
    // DOC_V2 declares 3.1.0 over a 3.0 baseline: inheriting the accepted value
    // would normalize the promoted document under the wrong rules
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_30 }));
    await writeCandidate(LAYOUT, fs, candidateInput());
    await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(metaOf(fs).openapiVersion).toBe('3.1');
  });

  it('rejects a candidate document whose openapi field is unusable', async () => {
    // Validated before it was persisted, so this state means the persisted
    // bytes are inconsistent — a conflict, never a silent promotion
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, {
      ...candidateInput(),
      document: { openapi: '2.0', info: { title: 'Petstore v2', version: '2.0.0' }, paths: {} },
    });
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('no usable OpenAPI version') as string,
    });
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it("promotes with the candidate's own recorded title even when its document has none (no fallback)", async () => {
    // The meta.candidate member records the candidate's own title and version at write
    // time, and promotion reads only that, with no fallback to the promoted
    // DOCUMENT's title or to the entry being replaced. candidateInput() fixes
    // title 'Petstore v2'/specVersion '2.0.0' regardless of `document`, so a
    // document with no info.title still promotes with those values, not the
    // previous accepted entry's 'Petstore'/'1.0.0'.
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, {
      ...candidateInput(),
      document: { openapi: '3.1.0', paths: {} },
    });
    await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(metaOf(fs)).toMatchObject({ title: 'Petstore v2', specVersion: '2.0.0' });
  });

  it('accepts a matching expectedHash', async () => {
    const fs = await withCandidate();
    await expect(
      promoteCandidate(LAYOUT, fs, NOW, { expectedHash: hashContent(DOC_V2_TEXT) }),
    ).resolves.toEqual({ promotedHash: hashContent(DOC_V2_TEXT) });
  });

  it('rejects a mismatched expectedHash and leaves the baseline untouched', async () => {
    const fs = await withCandidate();
    await expect(
      promoteCandidate(LAYOUT, fs, NOW, { expectedHash: hashContent(DOC_TEXT) }),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
  });

  it('evaluates expectedHash under the lock, making it a compare-and-swap', async () => {
    const fs = await withCandidate();
    // A concurrent refresh holding the lock cannot interleave with the check
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'refresh', acquiredAt: NOW }),
    );
    await expect(
      promoteCandidate(LAYOUT, fs, NOW, { expectedHash: hashContent(DOC_V2_TEXT) }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it('releases the lock after a successful promotion', async () => {
    const fs = await withCandidate();
    await promoteCandidate(LAYOUT, fs, NOW, {});
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });

  it('rejects when no candidate is recorded', async () => {
    await expect(promoteCandidate(LAYOUT, await seeded(), NOW, {})).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('no candidate') as string,
    });
  });

  it('reports not-found for a namespace that does not exist', async () => {
    await expect(promoteCandidate(LAYOUT, memoryCacheFs(), NOW, {})).rejects.toMatchObject({
      code: 'not_found',
      exitCode: 4,
    });
  });

  it('rejects when the recorded candidate object is missing', async () => {
    const fs = await withCandidate();
    fs.files.delete(objectPath(LAYOUT, CANDIDATE_HASH));
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('takes the candidate provenance from meta, with no fallback', async () => {
    // Falling back to the ACCEPTED entry's source hash when the candidate's
    // own is absent would record the replaced document's provenance against
    // the promoted bytes — but sourceContentHash is a required field on the
    // nested candidate member, so it is always present and that fallback can
    // never be reached: the promoted source hash is always the candidate's
    // own.
    const fs = await withCandidate();
    await promoteCandidate(LAYOUT, fs, NOW, {});
    const meta = metaOf(fs);
    expect(meta.sourceContentHash).toBe(SOURCE_HASH_V2);
    expect(meta.sourceContentHash).not.toBe(SOURCE_HASH);
    // And the display fields come from meta.candidate rather than being
    // re-derived from the persisted bytes
    expect(meta).toMatchObject({ title: 'Petstore v2', specVersion: '2.0.0' });
  });

  it('rejects when the candidate object does not match its recorded hash', async () => {
    const fs = await withCandidate();
    fs.files.set(objectPath(LAYOUT, CANDIDATE_HASH), '{"openapi":"3.1.0","info":{"title":"Swapp');
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('does not match') as string,
    });
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it('fails closed with a validation error on a corrupt entry, not a conflict', async () => {
    const fs = await withCandidate();
    fs.files.set(LAYOUT.metaPath, 'not json');
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });
});

describe('clearNamespace (under the lock)', () => {
  it('removes the metadata and every object, leaving a clean miss', async () => {
    const fs = await withCandidate();
    expect(await clearNamespace(LAYOUT, fs, NOW)).toBe(true);
    expect(fs.files.has(LAYOUT.metaPath)).toBe(false);
    expect(objectNamesOf(fs)).toEqual([]);
    // The end state is an empty namespace directory, which reads as a miss —
    // exactly the clean absence clear is supposed to produce
    expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });
  });

  it('reports false when there was nothing to remove', async () => {
    expect(await clearNamespace(LAYOUT, memoryCacheFs(), NOW)).toBe(false);
  });

  it('acquires the namespace lock and refuses while a writer holds it', async () => {
    // An earlier version was lock-free here and cleared straight through a
    // live writer
    const fs = await withCandidate();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'writer', acquiredAt: NOW }));
    await expect(clearNamespace(LAYOUT, fs, NOW)).rejects.toMatchObject({
      code: 'conflict',
      exitCode: 5,
    });
    // Nothing was removed: the entry is intact for the writer that owns it
    expect(fs.files.has(LAYOUT.metaPath)).toBe(true);
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it('never deletes the lock it does not own', async () => {
    const fs = await seeded();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'writer', acquiredAt: NOW }));
    await expect(clearNamespace(LAYOUT, fs, NOW)).rejects.toMatchObject({ code: 'conflict' });
    // An earlier version unlinked .lock unconditionally, which re-admitted a
    // second writer to a namespace already being torn down
    expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({ owner: 'writer' });
  });

  it('releases its own lock afterwards so the namespace is reusable', async () => {
    const fs = await withCandidate();
    await clearNamespace(LAYOUT, fs, NOW);
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
    // A first-ever write can immediately recreate the namespace
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).resolves.toBeDefined();
  });

  it('cannot leave a durable metadata-without-spec entry against a concurrent writer', async () => {
    // The interleaving an earlier lock-free clear permitted: clear removes the
    // metadata, a writer commits new metadata naming its new object, clear
    // then removes that object — and the durable end state is metadata
    // pointing at bytes that no longer exist, i.e. a permanently corrupt entry
    // produced by the operation meant to leave a clean absence. Driven
    // deterministically by attempting the write from inside clear's own
    // removal sequence.
    const fs = await withCandidate();
    let writeAttempt: Promise<unknown> | undefined;
    const innerRemoveFile = fs.removeFile;
    fs.removeFile = (path) => {
      if (path === LAYOUT.metaPath && writeAttempt === undefined) {
        // The exact instant the original code was vulnerable. Deliberately NOT
        // awaited here: this fires the write and captures its eventual
        // outcome (value or error) without blocking removeFile's synchronous
        // return, which is what lets it interleave with clear's own removal
        // sequence.
        // eslint-disable promise/prefer-await-to-callbacks -- fire-and-forget capture, not a callback-style API; block form because oxfmt wraps the statement across lines
        writeAttempt = writeAccepted(LAYOUT, fs, acceptedInput({ fetchedAt: NOW + 1 })).catch(
          (error: unknown) => error,
        );
        // eslint-enable promise/prefer-await-to-callbacks
      }
      return innerRemoveFile(path);
    };
    await clearNamespace(LAYOUT, fs, NOW);
    // The writer was serialised behind the lock, so it either never ran or ran
    // afterwards — never interleaved
    const outcome = await writeAttempt;
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ code: 'conflict' });
      expect(await readCacheEntry(LAYOUT, fs)).toEqual({ kind: 'miss' });
    } else {
      // If it committed after the clear, it committed COMPLETELY
      const result = await readCacheEntry(LAYOUT, fs);
      expect(result.kind).toBe('hit');
    }
    // What must never happen, under either branch: metadata naming an object
    // that is not there
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).not.toBe('corrupt');
  });

  it('keeps unlinking meta.json first as defence in depth for lock-free readers', async () => {
    // No longer load-bearing — the lock is — but a reader in flight still
    // benefits from the commit point disappearing first
    const fs = await withCandidate();
    const calls: string[] = [];
    const innerRemoveFile = fs.removeFile;
    fs.removeFile = (path) => {
      calls.push(path);
      return innerRemoveFile(path);
    };
    expect(await clearNamespace(LAYOUT, fs, NOW)).toBe(true);
    expect(calls[0]).toBe(LAYOUT.metaPath);
    const acceptedObjectPath = objectPath(LAYOUT, hashContent(DOC_TEXT));
    expect(calls.indexOf(acceptedObjectPath)).toBeGreaterThan(0);
  });
});

describe('touchRevalidated (the 304 transition)', () => {
  it('preserves a waiting candidate across a 304 revalidation', async () => {
    // Running writeAccepted on a 304 would rewrite the accepted entry and
    // clear the candidate — so revalidating would silently discard a
    // candidate awaiting promotion without ever approving it.
    const fs = await withCandidate();
    const before = metaOf(fs);
    await touchRevalidated(LAYOUT, fs, NOW, { etag: '"v2"' }, { expected: 'unchecked' });
    const after = metaOf(fs);
    expect(after.candidate).toEqual(before.candidate);
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
  });

  it('preserves the accepted baseline byte for byte', async () => {
    const fs = await withCandidate();
    const before = metaOf(fs);
    await touchRevalidated(LAYOUT, fs, NOW, { etag: '"v2"' }, { expected: 'unchecked' });
    const after = metaOf(fs);
    expect(after.acceptedContentHash).toBe(before.acceptedContentHash);
    expect(after.sourceContentHash).toBe(before.sourceContentHash);
    expect(after.title).toBe(before.title);
    expect(after.openapiVersion).toBe(before.openapiVersion);
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
  });

  it('writes no object at all — only the metadata changes', async () => {
    const fs = await withCandidate();
    const namesBefore = objectNamesOf(fs);
    const written: string[] = [];
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) => {
      written.push(path);
      return inner(path, data);
    };
    await touchRevalidated(LAYOUT, fs, NOW, {}, { expected: 'unchecked' });
    expect(written).toEqual([LAYOUT.metaPath]);
    expect(objectNamesOf(fs)).toEqual(namesBefore);
  });

  it('advances fetchedAt so the TTL restarts from the successful check', async () => {
    const fs = await withCandidate();
    await touchRevalidated(LAYOUT, fs, NOW, {}, { expected: 'unchecked' });
    expect(metaOf(fs).fetchedAt).toBe(NOW);
  });

  it('records the validators the 304 returned', async () => {
    const fs = await seeded();
    await touchRevalidated(
      LAYOUT,
      fs,
      NOW,
      {
        etag: '"fresh"',
        lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
      },
      { expected: 'unchecked' },
    );
    expect(metaOf(fs)).toMatchObject({
      etag: '"fresh"',
      lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT',
    });
  });

  it('keeps the recorded validators when the 304 returned none', async () => {
    // A 304 answered to a validator-free request carries none either: erasing
    // what we have would force an unconditional refetch next time
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ etag: '"keep"' }));
    await touchRevalidated(LAYOUT, fs, NOW, {}, { expected: 'unchecked' });
    expect(metaOf(fs).etag).toBe('"keep"');
  });

  it('runs under the namespace writer lock', async () => {
    const fs = await seeded();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'other', acquiredAt: NOW }));
    await expect(
      touchRevalidated(LAYOUT, fs, NOW, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('fails closed on a corrupt entry', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'not json');
    await expect(
      touchRevalidated(LAYOUT, fs, NOW, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('refuses a 304 revalidation when there is no baseline to revalidate', async () => {
    await expect(
      touchRevalidated(LAYOUT, memoryCacheFs(), NOW, {}, { expected: 'unchecked' }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('listCacheEntries', () => {
  it('returns an empty list when the root does not exist', async () => {
    expect(await listCacheEntries('/missing', memoryCacheFs())).toEqual([]);
  });

  it('summarizes every readable entry, newest first', async () => {
    const fs = memoryCacheFs();
    const older = cacheLayout('/cache', '1111111111111111');
    const newer = cacheLayout('/cache', '2222222222222222');
    await writeAccepted(older, fs, acceptedInput());
    await writeAccepted(
      newer,
      fs,
      acceptedInput({ fetchedAt: 1_700_000_500_000, title: 'Newer', cacheKey: 'prod' }),
    );
    const entries = await listCacheEntries('/cache', fs);
    expect(entries.map((entry) => entry.id)).toEqual([newer.namespace, older.namespace]);
    expect(entries[0]).toEqual({
      id: newer.namespace,
      displaySource: 'https://api.example.com/openapi.json',
      cacheKey: 'prod',
      title: 'Newer',
      specVersion: '1.0.0',
      fetchedAt: 1_700_000_500_000,
      acceptedContentHash: hashContent(DOC_TEXT),
    });
  });

  it('surfaces the cache-key label so two namespaces of one URL are distinguishable', async () => {
    const fs = memoryCacheFs();
    const a = cacheLayout('/cache', '1111111111111111');
    const b = cacheLayout('/cache', '2222222222222222');
    await writeAccepted(a, fs, acceptedInput({ cacheKey: 'tenant-a' }));
    await writeAccepted(
      b,
      fs,
      acceptedInput({ cacheKey: 'tenant-b', fetchedAt: 1_700_000_400_000 }),
    );
    const entries = await listCacheEntries('/cache', fs);
    expect(entries.map((entry) => entry.cacheKey)).toEqual(['tenant-b', 'tenant-a']);
  });

  it('omits the cache key rather than reporting undefined for an unkeyed entry', async () => {
    const entries = await listCacheEntries('/cache', await seeded());
    expect('cacheKey' in (entries[0] ?? {})).toBe(false);
  });

  it('reports a waiting candidate hash', async () => {
    const entries = await listCacheEntries('/cache', await withCandidate());
    expect(entries[0]?.candidateContentHash).toBe(hashContent(DOC_V2_TEXT));
  });

  it('skips entries it cannot read instead of failing the whole listing', async () => {
    const fs = memoryCacheFs();
    const good = cacheLayout('/cache', '1111111111111111');
    const broken = cacheLayout('/cache', '2222222222222222');
    const future = cacheLayout('/cache', '3333333333333333');
    await writeAccepted(good, fs, acceptedInput());
    await writeAccepted(broken, fs, acceptedInput());
    await writeAccepted(future, fs, acceptedInput());
    fs.files.set(broken.metaPath, '{oops');
    fs.files.set(future.metaPath, JSON.stringify({ schemaVersion: CACHE_META_SCHEMA_VERSION + 1 }));
    const entries = await listCacheEntries('/cache', fs);
    expect(entries.map((entry) => entry.id)).toEqual([good.namespace]);
  });

  it('ignores directory names that are not namespaces', async () => {
    const fs = await seeded();
    await fs.mkdirSecure('/cache/not-a-namespace');
    await fs.writeFileAtomic('/cache/stray.txt', 'x');
    const entries = await listCacheEntries('/cache', fs);
    expect(entries.map((entry) => entry.id)).toEqual([LAYOUT.namespace]);
  });

  it('breaks fetchedAt ties deterministically by id', async () => {
    const fs = memoryCacheFs();
    for (const namespace of ['3333333333333333', '1111111111111111', '2222222222222222']) {
      await writeAccepted(cacheLayout('/cache', namespace), fs, acceptedInput());
    }
    const entries = await listCacheEntries('/cache', fs);
    expect(entries.map((entry) => entry.id)).toEqual([
      '1111111111111111',
      '2222222222222222',
      '3333333333333333',
    ]);
  });
});

describe('every exported cache operation types its raw I/O', () => {
  const eaccesError = (): Error => Object.assign(new Error('EACCES'), { code: 'EACCES' });

  const breaking = async (method: keyof MemoryCacheFs, seed = true): Promise<MemoryCacheFs> => {
    const fs = seed ? await seeded() : memoryCacheFs();
    // TypeScript cannot verify that a single zero-arg function is assignable
    // to every one of MemoryCacheFs's differently-shaped methods (and its
    // `files`/`dirs` properties aren't functions at all) when `method` is a
    // generic key rather than a literal — this is the same limitation `any`
    // would paper over, but `Record<keyof MemoryCacheFs, unknown>` widens
    // only the VALUE type, so the key itself stays constrained to
    // `keyof MemoryCacheFs` and a typo in `method` is still caught.
    (fs as Record<keyof MemoryCacheFs, unknown>)[method] = () => Promise.reject(eaccesError());
    return fs;
  };

  it.each([
    [
      'writeAccepted',
      'writeFileAtomic',
      (fs: MemoryCacheFs) => writeAccepted(LAYOUT, fs, acceptedInput()),
    ],
    [
      'writeCandidate',
      'writeFileAtomic',
      (fs: MemoryCacheFs) => writeCandidate(LAYOUT, fs, candidateInput()),
    ],
    // NOT readFileTextCapped. readMetaFile catches that and resolves
    // kind:'corrupt', exactly as the frozen signature promises, so the row
    // would never reject. pathExists is the raw path that does reach the
    // definition adapter.
    ['readCacheEntry', 'pathExists', (fs: MemoryCacheFs) => readCacheEntry(LAYOUT, fs)],
    ['clearNamespace', 'removeFile', (fs: MemoryCacheFs) => clearNamespace(LAYOUT, fs, NOW)],
    ['listCacheEntries', 'readDirNames', (fs: MemoryCacheFs) => listCacheEntries('/cache', fs)],
    ['listNamespaceIds', 'readDirNames', (fs: MemoryCacheFs) => listNamespaceIds('/cache', fs)],
    [
      'withNamespaceLock',
      'createExclusive',
      (fs: MemoryCacheFs) => withNamespaceLock(LAYOUT, fs, NOW, () => Promise.resolve(0)),
    ],
  ] as const)('%s reports validation exit 3 when %s fails raw', async (_name, method, call) => {
    const fs = await breaking(method);
    await expect(call(fs)).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
  });

  it('does NOT flatten a lock conflict into a validation error', async () => {
    // The pass-through half of the rule: a typed OpenapiMcpError keeps its own
    // exit code, so contention stays distinguishable from an I/O failure
    const fs = await seeded();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'other', acquiredAt: NOW }));
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).rejects.toMatchObject({
      code: 'conflict',
      exitCode: 5,
    });
  });

  it('surfaces EACCES on the lock holder read during CONTENTION', async () => {
    // Swallowing this into "unreadable holder" and reporting a conflict would
    // make the I/O failure permanently invisible — the outer wrapper
    // deliberately preserves the typed EACCES error instead
    const fs = await seeded();
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'other', acquiredAt: NOW }));
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = (path, maxBytes) =>
      path === LAYOUT.lockPath ? Promise.reject(eaccesError()) : inner(path, maxBytes);
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('surfaces EACCES on the lock holder read during RELEASE', async () => {
    const fs = memoryCacheFs();
    const inner = fs.readFileTextCapped;
    let inRun = false;
    fs.readFileTextCapped = (path, maxBytes) =>
      inRun && path === LAYOUT.lockPath ? Promise.reject(eaccesError()) : inner(path, maxBytes);
    await expect(
      withNamespaceLock(LAYOUT, fs, NOW, () => {
        inRun = true;
        return Promise.resolve('done');
      }),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
  });

  it('surfaces EACCES on the candidate read during PROMOTION', async () => {
    // Turning this into conflict exit 5 would contradict the frozen
    // validation exit 3 for persistent-cache I/O
    const fs = await withCandidate();
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = (path, maxBytes) =>
      path === objectPath(LAYOUT, CANDIDATE_HASH)
        ? Promise.reject(eaccesError())
        : inner(path, maxBytes);
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'validation',
      exitCode: 3,
    });
  });

  it('still reports conflict when the candidate object is genuinely ABSENT', async () => {
    // The complement, so narrowing the catch did not simply invert it
    const fs = await withCandidate();
    fs.files.delete(objectPath(LAYOUT, CANDIDATE_HASH));
    await expect(promoteCandidate(LAYOUT, fs, NOW, {})).rejects.toMatchObject({
      code: 'conflict',
      exitCode: 5,
    });
  });
});

// CacheEntrySummary is display-only (rendered elsewhere in the `cache list`
// table), and the meta schema bounds displaySource/title/specVersion by
// LENGTH but not by character set. Those three are derived from spec
// documents this project treats as untrusted, so a hand-planted or damaged
// meta.json — schema-valid, but hostile — must not be able to put an ANSI
// escape sequence or a bidi override onto the operator's terminal by way of
// `cache list`. Built with String.fromCodePoint rather than a \u escape
// literal, so the hostile bytes exist only at test runtime and never sit in
// the source file as a raw control character.
describe('listCacheEntries: sanitizes hostile metadata before display', () => {
  it('strips control and bidi characters from displaySource, title, and specVersion', async () => {
    const ESC = String.fromCodePoint(0x1b);
    const BEL = String.fromCodePoint(0x07);
    const BIDI_OVERRIDE = String.fromCodePoint(0x20_2e);
    const fs = await seeded();
    const hostileMeta = {
      ...metaOf(fs),
      displaySource: `https://api.example.com/${ESC}[31mRED${ESC}[0m`,
      title: `Evil${BIDI_OVERRIDE}title`,
      specVersion: `1.0${BEL}bell`,
    };
    fs.files.set(LAYOUT.metaPath, JSON.stringify(hostileMeta));

    const entries = await listCacheEntries('/cache', fs);
    const [summary] = entries;
    expect(summary).toBeDefined();
    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain(ESC);
    expect(rendered).not.toContain(BIDI_OVERRIDE);
    expect(rendered).not.toContain(BEL);
    expect(summary?.displaySource).toBe('https://api.example.com/[31mRED[0m');
    expect(summary?.title).toBe('Eviltitle');
    expect(summary?.specVersion).toBe('1.0bell');
  });

  it('does not sanitize the meta object readCacheEntry returns, only the summary', async () => {
    // Hashes, validators, and timestamps are used for logic (hash comparison,
    // conditional GET); rewriting them would break readCacheEntry's contract.
    // Sanitizing is a summarize()-only concern.
    const ESC = String.fromCodePoint(0x1b);
    const fs = await seeded();
    const hostileMeta = { ...metaOf(fs), title: `Evil${ESC}title` };
    fs.files.set(LAYOUT.metaPath, JSON.stringify(hostileMeta));

    const result = await readCacheEntry(LAYOUT, fs);
    if (result.kind !== 'hit') {
      expect.unreachable('expected a hit');
    }
    expect(result.entry.meta.title).toBe(`Evil${ESC}title`);
  });
});

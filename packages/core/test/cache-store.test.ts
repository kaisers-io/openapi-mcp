import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_PERSISTED_BYTES,
  CACHE_META_MAX_BYTES,
  CACHE_META_SCHEMA_VERSION,
  FETCHED_AT_MAX,
  type CacheMeta,
  cacheLayout,
  hashContent,
  objectPath,
  readCacheEntry,
  serializedSizeWithin,
  touchRevalidated,
  writeAccepted,
  writeCandidate,
  zCacheMeta,
} from '../src/index.ts';
import { type MemoryCacheFs, memoryCacheFs } from './helpers/cache-fs.ts';

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
// A genuinely 3.0 document. Round-4 correction: the discriminator is derived
// from the document, so a test that wants a 3.0 entry must supply 3.0 BYTES —
// passing a 3.0 label beside a 3.1 document now (correctly) reads as corrupt.
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
  ...over,
});

export const candidateInput = (): Parameters<typeof writeCandidate>[2] => ({
  document: DOC_V2,
  sourceContentHash: SOURCE_HASH_V2,
  title: 'Petstore v2',
  specVersion: '2.0.0',
  fetchedAt: 1_700_000_500_000,
});

export const CANDIDATE_HASH = hashContent(DOC_V2_TEXT);

export const seeded = async (): Promise<MemoryCacheFs> => {
  const fs = memoryCacheFs();
  await writeAccepted(LAYOUT, fs, acceptedInput());
  return fs;
};

export const metaOf = (fs: MemoryCacheFs): CacheMeta =>
  zCacheMeta.parse(JSON.parse(fs.files.get(LAYOUT.metaPath) ?? ''));

// D12.1: there is no fixed accepted/candidate path any more — an object is
// found through the hash meta.json records, which is also its filename. These
// helpers read the entry the way the STORE does, so a test cannot accidentally
// assert against bytes no metadata references.
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
    .filter((key) => key.startsWith(`${layout.objectsDir}/`))
    .map((key) => key.slice(layout.objectsDir.length + 1))
    .sort();

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
  it('pins the schema version at 1', () => {
    expect(CACHE_META_SCHEMA_VERSION).toBe(1);
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

  it('accepts either OpenAPI version discriminator (D16b)', () => {
    expect(zCacheMeta.safeParse({ ...validMeta(), openapiVersion: '3.0' }).success).toBe(true);
    expect(zCacheMeta.safeParse({ ...validMeta(), openapiVersion: '3.1' }).success).toBe(true);
  });

  it.each(['3.0.3', '3.1.0', '3.2', '3', '', 1, undefined])(
    'rejects the unusable openapiVersion %j',
    (openapiVersion) => {
      // A cache hit skips revalidation (D16b), so this field is the only source
      // of the discriminator normalizeSpec needs: a loose value would silently
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

  it.each([0, 2, 1.5, '1'])('rejects the non-literal schema version %j', (schemaVersion) => {
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
    // headers on the next revalidation (Task 5): only printable ASCII is stored
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

  it('bounds fetchedAt by the Date limit, not MAX_SAFE_INTEGER (D18)', () => {
    // Probed: new Date(Number.MAX_SAFE_INTEGER).toISOString() throws
    // RangeError, so the round-1 bound admitted metadata that crashed
    // "cache list" while rendering it. Every schema-valid value must render.
    expect(FETCHED_AT_MAX).toBe(8_640_000_000_000_000);
    expect(zCacheMeta.safeParse({ ...validMeta(), fetchedAt: FETCHED_AT_MAX }).success).toBe(true);
    expect(zCacheMeta.safeParse({ ...validMeta(), fetchedAt: FETCHED_AT_MAX + 1 }).success).toBe(
      false,
    );
    expect(() => new Date(FETCHED_AT_MAX).toISOString()).not.toThrow();
    expect(() => new Date(Number.MAX_SAFE_INTEGER).toISOString()).toThrow(RangeError);
  });

  it('renders every schema-valid fetchedAt without throwing (D18)', () => {
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
  ])('rejects a candidate with %s — the member is all-or-none (D18)', (_label, candidate) => {
    // The round-1 shape had two independently optional hashes, so a file could
    // carry exactly one and promotion silently fell back to the ACCEPTED
    // entry's source hash — recording the replaced document's provenance
    // against the promoted bytes. Nesting makes that unrepresentable.
    expect(zCacheMeta.safeParse({ ...validMeta(), candidate }).success).toBe(false);
  });

  it('rejects the round-1 flat candidate fields outright', () => {
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

  it('persists JSON.stringify(document) and hashes exactly those bytes (D14)', async () => {
    const fs = memoryCacheFs();
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, acceptedInput());
    const persisted = acceptedTextOf(fs);
    expect(persisted).toBe(DOC_TEXT);
    expect(persisted).not.toContain('\n');
    expect(acceptedContentHash).toBe(hashContent(DOC_TEXT));
    expect(metaOf(fs).acceptedContentHash).toBe(acceptedContentHash);
  });

  it('names the object after its own hash, so the filename is self-verifying (D12.1)', async () => {
    const fs = memoryCacheFs();
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, acceptedInput());
    expect(objectNamesOf(fs)).toEqual([`${acceptedContentHash}.json`]);
    const persistedPath = objectPath(LAYOUT, acceptedContentHash);
    expect(hashContent(fs.files.get(persistedPath) ?? '')).toBe(acceptedContentHash);
  });

  it('refuses a document over the persisted-document budget, before taking the lock (D14)', async () => {
    // The round-1 draft checked only the candidate, and against the SOURCE
    // budget — so an accepted document that dereferenced past it was persisted
    // and then read back as corrupt, bricking an entry that had validated
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

  it('reads back everything it accepts at the budget boundary (D14)', async () => {
    // The invariant the shared constant buys: anything this build persisted,
    // this build can read back
    const fs = memoryCacheFs();
    const padding = 'x'.repeat(1024);
    const doc = { openapi: '3.1.0', info: { title: 'Padded', version: '1' }, paths: {}, padding };
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: doc }));
    const readResult = await readCacheEntry(LAYOUT, fs);
    expect(readResult.kind).toBe('hit');
  });

  it('keeps the source hash distinct from the persisted-bytes hash (D14)', async () => {
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

  it('persists the OpenAPI version discriminator a cache hit cannot recover (D16b)', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, acceptedInput({ document: DOC_30 }));
    // Derived from the bytes, never supplied by the caller
    expect(metaOf(fs).openapiVersion).toBe('3.0');
  });

  it('records the operator cache-key label (D9)', async () => {
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

  it('writes the object before meta.json, so meta is the commit point (D12.2)', async () => {
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

  it('never rewrites an existing object — a commit only ever creates (D12.1)', async () => {
    // This is the property the round-1 fixed-path layout lacked, and the reason
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

  it('runs under the namespace writer lock (D12)', async () => {
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

describe('a crash during the FIRST-EVER commit (round-3 finding 2)', () => {
  it('leaves a miss that self-heals, not a permanently wedged namespace', async () => {
    // The round-3 draft classified objects-without-metadata as corrupt, so a
    // first commit that died after the object write bricked the namespace
    // forever — D5 forbids healing a corrupt entry automatically, and there had
    // never been a baseline to fall back to.
    const fs = memoryCacheFs();
    const inner = fs.writeFileAtomic;
    fs.writeFileAtomic = (path, data) =>
      path === LAYOUT.metaPath
        ? Promise.reject(new Error('crash during the first commit'))
        : inner(path, data);
    await expect(writeAccepted(LAYOUT, fs, acceptedInput())).rejects.toThrowError();
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

  it('does not weaken D5: deleting metadata beside a baseline is no better than deleting the directory', async () => {
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

describe('the persisted-size preflight is exact (round-4 finding 1)', () => {
  // Round 3 reasoned this through instead of proving it and chose the wrong
  // unit — UTF-16 code units where the reader caps UTF-8 bytes — so a multibyte
  // document passed the writer and was corrupt on its first read. The property
  // is now asserted against the exact quantity that lands on disk, over a
  // corpus that actually contains the cases that broke it.
  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  it('agrees with Buffer.byteLength(JSON.stringify(value)) across a generated corpus', () => {
    const rng = mulberry32(20_260_720);
    const rand = (n: number): number => Math.floor(rng() * n);
    // Deliberately includes: astral, BMP non-ASCII, and every character
    // JSON.stringify escapes — the three classes that broke the round-4 version
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
    for (let trial = 0; trial < 5_000; trial += 1) {
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
    // The corpus must contain what it claims to test (the round-3 fuzz lesson)
    expect(checkedAstral).toBeGreaterThan(100);
    expect(checkedEscapes).toBeGreaterThan(100);
  });

  it.each([
    ['an undefined array member', { x: [undefined] }],
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
  ])('refuses %s rather than mis-sizing it (round-5 finding 3)', (_label, value) => {
    // The exported writers take Record<string, unknown>, which admits more than
    // the sizer is exact for. Round 5 assumed the narrower domain in a comment;
    // it is now ENFORCED, because an inexact size breaks the D14 write-then-read
    // invariant for any caller of the exported store. Concretely:
    // JSON.stringify({x:[undefined]}) is 12 bytes and the round-5 walker
    // counted 8.
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrowError(/round-trip exactly/u);
  });

  it.each([
    ['a boxed number', { x: new Number(5) }],
    ['a boxed string', { x: new String('a') }],
    ['a boxed boolean', { x: new Boolean(true) }],
  ])('refuses %s, which stringifies as a primitive (round-6 finding 1)', (_label, value) => {
    // JSON.stringify(new Number(5)) is '5'; a walker using Object.entries sees
    // no entries and counts '{}'. The round-6 draft claimed a plain-object tree
    // and then accepted any object at all.
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrowError(/round-trip exactly/u);
  });

  it('refuses an enumerable getter, which could answer twice (round-6 finding 1)', () => {
    // Worse than inexact: sizing and persistedSpecText read the property
    // separately, so a getter can answer small for the preflight and
    // over-budget for the stringify that follows — defeating the check itself.
    let calls = 0;
    const value = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        calls += 1;
        return calls === 1 ? 'a' : 'z'.repeat(100_000_000);
      },
    });
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrowError(/round-trip exactly/u);
  });

  it('refuses a top-level undefined, which stringifies to no string at all', () => {
    expect(() => serializedSizeWithin(undefined, 1_000_000)).toThrowError(/not a JSON object/u);
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
    // The round-4 version answered 11 here and let the document through
    expect(serializedSizeWithin(value, 14)).toBe(14);
    expect(serializedSizeWithin(value, 13)).toBeUndefined();
  });

  it('keeps the writer and reader caps in agreement (the D14 invariant)', async () => {
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

describe('crash between the object write and the metadata commit (D12.2)', () => {
  // Round 2 rejected the round-1 crash-safety argument, and rightly: with a
  // fixed accepted/spec.json the new bytes REPLACED the old ones before
  // meta.json was rewritten, so in that window — and permanently after a crash
  // in it — the live metadata described bytes that were already gone. These
  // cases drive that exact window deterministically. Ten probabilistic
  // subprocess runs cannot target it at all.

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
    ).rejects.toThrowError('crash before the metadata commit');

    // The critical assertion: a reader still gets the PREVIOUS generation,
    // hash-verified. Under the round-1 layout this read corrupt, because the
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
    ).rejects.toThrowError();
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
    ).rejects.toThrowError();
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
    ).rejects.toThrowError();
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });
});

describe('the discriminator is derived, not supplied (round-4 finding)', () => {
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
    // The property asked for: writer and reader now agree by
    // construction, because one function decides the discriminator for both
    for (const document of [DOC, DOC_30, DOC_V2]) {
      const fs = memoryCacheFs();
      await writeAccepted(LAYOUT, fs, acceptedInput({ document }));
      const readResult = await readCacheEntry(LAYOUT, fs);
      expect(readResult.kind).toBe('hit');
    }
  });
});

describe('cache writes and secret hygiene (spec §5.3)', () => {
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
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret');
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
  it('stores the candidate without touching the accepted baseline (§6.3)', async () => {
    const fs = await seeded();
    const acceptedBefore = metaOf(fs).acceptedContentHash;
    const { candidateContentHash } = await writeCandidate(LAYOUT, fs, candidateInput());
    expect(candidateContentHash).toBe(hashContent(DOC_V2_TEXT));
    expect(acceptedTextOf(fs)).toBe(DOC_TEXT);
    expect(candidateTextOf(fs)).toBe(DOC_V2_TEXT);
    const meta = metaOf(fs);
    expect(meta.acceptedContentHash).toBe(acceptedBefore);
    // D18: one nested member, so the two hashes cannot drift apart
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

  it('records the validators returned WITH the candidate (D16a2)', async () => {
    // The round-1 draft copied the accepted entry's stale validators forward, so
    // the next conditional request asked the server about a representation the
    // cache no longer held
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

  it('writes the candidate object before meta.json (D12.2)', async () => {
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

  it('never touches the accepted object while storing a candidate (§6.3)', async () => {
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

  it('refuses a candidate over the persisted-document budget before the lock (D14)', async () => {
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

  it('refuses on a corrupt entry rather than replacing the baseline (D5)', async () => {
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

  it('runs under the namespace writer lock (D12)', async () => {
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
// Supplementary coverage. Everything above this line is the brief's Step 1
// suite, used verbatim. The brief's suite proves the write-side transactional
// invariants but never exercises touchRevalidated directly and never asserts
// a `corrupt` outcome from readCacheEntry, so several store.ts branches -
// most of them the D5 corrupt-detection paths this task exists to build -
// were unreached. These tests close that gap so the module's own coverage
// gate can be met honestly rather than by lowering the threshold.
// ---------------------------------------------------------------------------

describe('touchRevalidated', () => {
  it('updates fetchedAt and validators without touching either object', async () => {
    const fs = await seeded();
    await writeCandidate(LAYOUT, fs, candidateInput());
    const before = metaOf(fs);
    await touchRevalidated(LAYOUT, fs, 1_700_001_000_000, {
      etag: '"v3"',
      lastModified: 'Fri, 23 Oct 2026 07:28:00 GMT',
    });
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
    await touchRevalidated(LAYOUT, fs, 1_700_001_000_000, {});
    expect(metaOf(fs).etag).toBe('"v1"');
    expect(metaOf(fs).fetchedAt).toBe(1_700_001_000_000);
  });

  it('refuses when there is no baseline to revalidate', async () => {
    await expect(
      touchRevalidated(LAYOUT, memoryCacheFs(), 1_700_000_000_000, {}),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('refuses on a corrupt entry rather than healing it (D5)', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, 'not json');
    await expect(touchRevalidated(LAYOUT, fs, 1_700_000_000_000, {})).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cache clear') as string,
    });
  });

  it('runs under the namespace writer lock (D12)', async () => {
    const fs = await seeded();
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'other', acquiredAt: 1_700_000_000_000 }),
    );
    await expect(touchRevalidated(LAYOUT, fs, 1_700_000_000_000, {})).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('readCacheEntry corrupt states (D5)', () => {
  it('reports corrupt when meta.json exceeds its read budget', async () => {
    const fs = await seeded();
    fs.files.set(LAYOUT.metaPath, `x${'y'.repeat(CACHE_META_MAX_BYTES)}`);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result.kind).toBe('corrupt');
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

describe('readCacheEntry retry loop (round-3/4 findings)', () => {
  it('retries once and succeeds when a transient object read recovers', async () => {
    const fs = await seeded();
    const objPath = objectPath(LAYOUT, metaOf(fs).acceptedContentHash);
    const inner = fs.readFileTextCapped;
    let calls = 0;
    fs.readFileTextCapped = (path, maxBytes) => {
      if (path === objPath) {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('transient read failure'));
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
      path === objPath ? Promise.reject(new Error('always fails')) : inner(path, maxBytes);
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({
      kind: 'corrupt',
      reason: expect.stringContaining('cannot be read within its') as string,
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
        return Promise.reject(new Error('object vanished mid-read'));
      }
      return inner(path, maxBytes);
    };
    const result = await readCacheEntry(LAYOUT, fs);
    expect(result).toEqual({ kind: 'miss' });
  });
});

describe('serializedSizeWithin: array-specific enforcement (round-7 finding 2)', () => {
  it('refuses an array cycle', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => serializedSizeWithin({ x: arr }, 1_000_000)).toThrowError(/round-trip exactly/u);
  });

  it('refuses an array subclass, which is outside the domain', () => {
    class MyArray extends Array {}
    const subclassed = new MyArray();
    subclassed.push(1, 2, 3);
    const value = { x: subclassed as unknown };
    expect(() => serializedSizeWithin(value, 1_000_000)).toThrowError(/round-trip exactly/u);
  });

  it('refuses an array carrying a toJSON hook', () => {
    const arr = Object.assign([1, 2, 3], { toJSON: () => 'not an array' });
    expect(() => serializedSizeWithin({ x: arr }, 1_000_000)).toThrowError(/round-trip exactly/u);
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

describe('commitEntry: an existing object under the target hash is verified, not trusted (round-3 finding 5)', () => {
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

describe('serializeMeta: the schema is the final safety net (D5)', () => {
  it('refuses an accepted title beyond the metadata bounds via the schema check', async () => {
    const fs = memoryCacheFs();
    const overlongTitle = 'x'.repeat(257);
    await expect(
      writeAccepted(LAYOUT, fs, acceptedInput({ title: overlongTitle })),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

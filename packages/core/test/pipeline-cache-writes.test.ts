import { dirname, join, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HTTP_METHODS, parseFilterPattern, runSpecPipeline } from '../src/index.ts';
import type { CacheFs, CacheMeta, SpecPipelineDeps } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// Issue kaisers-io/openapi-mcp-archive#75: a run whose source is byte-identical
// to the accepted one must not rewrite the cache. These tests watch the CacheFs
// calls a run makes.
type SpecFetcher = SpecPipelineDeps['fetcher'];

type Recorded = { fs: MemoryCacheFs; calls: string[] };

// Records "<method> <path>" for every CacheFs call, on top of the faithful
// in-memory fake shared with the store tests
const recordingFs = (): Recorded => {
  const inner = memoryCacheFs();
  const calls: string[] = [];
  const wrapped = { ...inner } as MemoryCacheFs;
  for (const key of Object.keys(inner) as (keyof CacheFs)[]) {
    const original = inner[key] as (...args: unknown[]) => Promise<unknown>;
    (wrapped as Record<string, unknown>)[key] = (...args: unknown[]) => {
      calls.push(`${key} ${String(args[0])}`);
      return original(...args);
    };
  }
  // Keep the fake's state observable through the wrapper
  Object.defineProperty(wrapped, 'files', { get: () => inner.files });
  return { fs: wrapped, calls };
};

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

const allowAll = {
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`route:${method.toUpperCase()} /**`)),
};

const opts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: fixturesDir,
  allowPrivateNetwork: false,
  deny: [],
  ttlMs: 3_600_000,
  trustSpecUpdates: false,
  cacheRoot: '/cache',
  nowMs: 1000,
  ...allowAll,
};

const deps = (cacheFs: CacheFs, fetcher?: SpecFetcher): SpecPipelineDeps => ({
  readFileText: (path: string) => readFile(path, 'utf8'),
  fileSizeBytes: async (path: string) => {
    const stats = await stat(path);
    return stats.size;
  },
  fetcher: fetcher ?? (() => Promise.reject(new Error('no network in this test'))),
  lookup: () => Promise.resolve(['93.184.216.34']),
  cacheFs,
});

const metaEntry = (fs: MemoryCacheFs): [string, string] => {
  const entry = [...fs.files.entries()].find(([key]) => key.endsWith(`${sep}meta.json`));
  if (entry === undefined) {
    throw new Error('no meta.json written');
  }
  return entry;
};
const metaOf = (fs: MemoryCacheFs): CacheMeta => JSON.parse(metaEntry(fs)[1]) as CacheMeta;

const writes = (calls: readonly string[]): readonly string[] =>
  calls.filter(
    (call) =>
      call.startsWith('writeFileAtomic ') ||
      call.startsWith('createExclusive ') ||
      call.startsWith('removeFile '),
  );

const remoteSpec = (title: string, extraPath?: string): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    paths: {
      '/things': {
        get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
      },
      ...(extraPath === undefined
        ? {}
        : {
            [extraPath]: {
              get: { operationId: 'listExtra', responses: { '200': { description: 'ok' } } },
            },
          }),
    },
  });

// Serves the given bodies in order (the last one repeats), with optional ETags
const sequenceFetcher = (responses: readonly { body: string; etag?: string }[]): SpecFetcher => {
  let index = 0;
  return (() => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Promise.resolve(
      new Response(next.body, {
        headers: next.etag === undefined ? {} : { etag: next.etag },
      }),
    );
  }) as unknown as SpecFetcher;
};

const specUrl = 'https://api.example.com/openapi.json';

describe('unchanged sources do not rewrite the cache (kaisers-io/openapi-mcp-archive#75)', () => {
  it('an unchanged file source performs no cache write and takes no lock', async () => {
    const { fs, calls } = recordingFs();
    const first = await runSpecPipeline('petstore-3.0.json', opts, deps(fs));
    expect(first.cacheStatus).toBe('accepted-first');
    const [metaPath, metaBefore] = metaEntry(fs);
    calls.length = 0;

    const second = await runSpecPipeline(
      'petstore-3.0.json',
      { ...opts, nowMs: 999_999_999 },
      deps(fs),
    );
    expect(second.cacheStatus).toBe('revalidated');
    expect(second.contentHash).toBe(first.contentHash);
    // No temp+rename, no lock record, no unlink: the run only READ the cache
    expect(writes(calls)).toStrictEqual([]);
    expect(fs.files.get(metaPath)).toBe(metaBefore);
  });

  it('an unchanged URL 200 updates only fetchedAt and the validators', async () => {
    const { fs, calls } = recordingFs();
    const body = remoteSpec('Remote');
    const fetcher = sequenceFetcher([
      { body, etag: '"v1"' },
      { body, etag: '"v2"' },
      // A 200 that carries no ETag must not leave the previous one behind
      { body },
    ]);
    await runSpecPipeline(specUrl, opts, deps(fs, fetcher));
    const accepted = metaOf(fs).acceptedContentHash;
    const objectPath = join(dirname(metaEntry(fs)[0]), 'objects', `${accepted}.json`);
    calls.length = 0;

    const later = opts.nowMs + opts.ttlMs + 1;
    const second = await runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher));
    expect(second.cacheStatus).toBe('revalidated');
    const meta = metaOf(fs);
    expect(meta.fetchedAt).toBe(later);
    expect(meta.etag).toBe('"v2"');
    expect(meta.acceptedContentHash).toBe(accepted);
    // Only meta.json is replaced (under the lock); the accepted object is
    // neither rewritten nor read more than once per verification: once by the
    // lock-free reader at the start of the run and once under the lock
    expect(writes(calls).filter((call) => call.startsWith('writeFileAtomic '))).toStrictEqual([
      `writeFileAtomic ${metaEntry(fs)[0]}`,
    ]);
    expect(calls.filter((call) => call === `readFileTextCapped ${objectPath}`)).toHaveLength(2);

    const third = await runSpecPipeline(
      specUrl,
      { ...opts, nowMs: later + opts.ttlMs + 1 },
      deps(fs, fetcher),
    );
    expect(third.cacheStatus).toBe('revalidated');
    expect(metaOf(fs).etag).toBeUndefined();
  });

  it('an unchanged source still clears a pending candidate (source reverted)', async () => {
    const { fs } = recordingFs();
    const fetcher = sequenceFetcher([
      { body: remoteSpec('Remote') },
      { body: remoteSpec('Remote', '/extra') },
      { body: remoteSpec('Remote') },
    ]);
    await runSpecPipeline(specUrl, opts, deps(fs, fetcher));
    const step = opts.ttlMs + 1;
    const candidate = await runSpecPipeline(
      specUrl,
      { ...opts, nowMs: opts.nowMs + step },
      deps(fs, fetcher),
    );
    expect(candidate.cacheStatus).toBe('candidate');
    expect(metaOf(fs).candidate).toBeDefined();

    const reverted = await runSpecPipeline(
      specUrl,
      { ...opts, nowMs: opts.nowMs + 2 * step },
      deps(fs, fetcher),
    );
    expect(reverted.cacheStatus).toBe('revalidated');
    expect(reverted.candidateContentHash).toBeUndefined();
    expect(metaOf(fs).candidate).toBeUndefined();
  });
});

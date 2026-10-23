import { basename, dirname, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HTTP_METHODS,
  buildSnapshot,
  buildTools,
  cacheLayout,
  objectPath,
  parseFilterPattern,
  promoteCandidate,
  runSpecPipeline,
} from '../src/index.ts';
import type { CacheLayout, CacheMeta, SpecPipelineDeps, SpecPipelineResult } from '../src/index.ts';
import { operationKeysOf } from '../src/spec/pending-candidate.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// Issue kaisers-io/openapi-mcp-archive#60: while a changed spec waits as a
// candidate, an operation it no longer has is withheld at once (the fail-safe
// direction); everything else keeps its accepted definition until
// `cache promote`.
type SpecFetcher = SpecPipelineDeps['fetcher'];

const op = (operationId: string, description = 'ok'): Record<string, unknown> => ({
  get: { operationId, description, responses: { '200': { description: 'ok' } } },
});

const specOf = (paths: Record<string, unknown>): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://example.com' }],
    paths,
  });

const BOTH = specOf({ '/a': op('getA'), '/b': op('getB') });
const ONLY_A = specOf({ '/a': op('getA') });
const ONLY_A_CHANGED = specOf({ '/a': op('getA', 'a CHANGED, unapproved description') });

const opts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
  deny: [],
  ttlMs: 1000,
  trustSpecUpdates: false,
  cacheRoot: '/cache',
  nowMs: 10_000,
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`)),
};

// A spec body, 304 (not modified), or 'fail' (the fetch rejects).
const serving = (body: string | 304): SpecFetcher =>
  (() => {
    if (body === 'fail') {
      return Promise.reject(new Error('network down'));
    }
    return Promise.resolve(
      body === 304
        ? new Response(null, { status: 304, headers: { etag: '"x"' } })
        : new Response(body, { headers: { etag: '"x"' } }),
    );
  }) as unknown as SpecFetcher;

const runAt = (fs: MemoryCacheFs, nowMs: number, body: string | 304): Promise<SpecPipelineResult> =>
  runSpecPipeline(
    'https://api.example.com/openapi.json',
    { ...opts, nowMs },
    {
      readFileText: () => Promise.reject(new Error('no files')),
      fileSizeBytes: () => Promise.reject(new Error('no files')),
      fetcher: serving(body),
      lookup: () => Promise.resolve(['93.184.216.34']),
      cacheFs: fs,
    },
  );

const toolNames = (result: SpecPipelineResult): readonly string[] =>
  result.namedOperations.map((named) => named.toolName);

const layoutOf = (fs: MemoryCacheFs): CacheLayout => {
  const metaPath = [...fs.files.keys()].find((key) => key.endsWith(`${sep}meta.json`))!;
  return cacheLayout('/cache', basename(dirname(metaPath)));
};
const metaOf = (fs: MemoryCacheFs): CacheMeta =>
  JSON.parse(fs.files.get(layoutOf(fs).metaPath)!) as CacheMeta;

// Accepted {getA, getB}; then a refresh past the TTL finds getB removed
const withCandidate = async (
  candidate = ONLY_A,
): Promise<{ fs: MemoryCacheFs; result: SpecPipelineResult }> => {
  const fs = memoryCacheFs();
  await runAt(fs, 10_000, BOTH);
  const result = await runAt(fs, 20_000, candidate);
  return { fs, result };
};

describe('operations removed in a pending candidate are withheld (kaisers-io/openapi-mcp-archive#60)', () => {
  it('on the run that records the candidate', async () => {
    const { result } = await withCandidate();
    expect(result.cacheStatus).toBe('candidate');
    expect(toolNames(result)).toStrictEqual(['getA']);
    expect(result.withheldOperations).toStrictEqual([
      { method: 'get', path: '/b', reason: expect.stringContaining('cache promote') as string },
    ]);
    expect(result.warnings.join('\n')).toContain(
      '1 operation(s) removed in the pending candidate spec are withheld until "openapi-mcp cache promote": GET /b (getB)',
    );
  });

  it('on a later start inside the TTL (fresh, candidate still pending)', async () => {
    const { fs } = await withCandidate();
    const restart = await runAt(fs, 20_500, 'fail'); // No network inside the TTL
    expect(restart.cacheStatus).toBe('fresh');
    expect(toolNames(restart)).toStrictEqual(['getA']);
    expect(restart.warnings.join('\n')).toContain('GET /b (getB)');
  });

  it('on a later 304 and on a failed refresh (stale)', async () => {
    const { fs } = await withCandidate();
    const revalidated = await runAt(fs, 40_000, 304);
    expect(revalidated.cacheStatus).toBe('revalidated');
    expect(toolNames(revalidated)).toStrictEqual(['getA']);
    const stale = await runAt(fs, 60_000, 'fail');
    expect(stale.cacheStatus).toBe('stale');
    expect(toolNames(stale)).toStrictEqual(['getA']);
  });

  it('an operation present in both keeps its ACCEPTED definition', async () => {
    const { result } = await withCandidate(ONLY_A_CHANGED);
    const [getA] = result.namedOperations;
    expect(getA?.operation.description).toBe('ok');
  });

  it('after cache promote, the candidate is served as usual', async () => {
    const { fs } = await withCandidate(ONLY_A_CHANGED);
    await promoteCandidate(layoutOf(fs), fs, 30_000, {});
    const promoted = await runAt(fs, 20_500, 'fail');
    expect(promoted.cacheStatus).toBe('fresh');
    expect(toolNames(promoted)).toStrictEqual(['getA']);
    expect(promoted.namedOperations[0]?.operation.description).toBe(
      'a CHANGED, unapproved description',
    );
    expect(promoted.withheldOperations).toStrictEqual([]);
  });

  it('treats a renamed path parameter as the same operation, not a removal', async () => {
    const byParam = (name: string): Record<string, unknown> => ({
      get: {
        operationId: 'getPet',
        parameters: [{ name, in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    });
    const fs = memoryCacheFs();
    await runAt(fs, 10_000, specOf({ '/pets/{petId}': byParam('petId'), '/b': op('getB') }));
    const result = await runAt(fs, 20_000, specOf({ '/pets/{id}': byParam('id') }));
    expect(result.cacheStatus).toBe('candidate');
    // Only the genuinely removed /b is withheld; the accepted definition
    // (with its accepted parameter name) keeps serving
    expect(toolNames(result)).toStrictEqual(['getPet']);
    expect(result.namedOperations[0]?.operation.path).toBe('/pets/{petId}');
    expect(result.withheldOperations.map((omitted) => omitted.path)).toStrictEqual(['/b']);
  });

  it('withholds nothing when the candidate only adds or changes operations', async () => {
    const { result } = await withCandidate(
      specOf({ '/a': op('getA', 'changed'), '/b': op('getB'), '/c': op('getC') }),
    );
    expect(result.cacheStatus).toBe('candidate');
    expect(toolNames(result)).toStrictEqual(['getA', 'getB']);
    expect(result.withheldOperations).toStrictEqual([]);
  });

  it('follows a Path Item $ref: operations under a referenced path item are not withheld', async () => {
    // The cache holds the SOURCE document (kaisers-io/openapi-mcp-archive#89),
    // so the candidate's path item is still a `{ $ref }` when its operation
    // keys are read
    const referenced = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      servers: [{ url: 'https://example.com' }],
      paths: {
        '/a': op('getA', 'changed'),
        '/b': { $ref: '#/components/pathItems/B' },
      },
      components: { pathItems: { B: op('getB') } },
    });
    const { fs, result } = await withCandidate(referenced);
    expect(result.cacheStatus).toBe('candidate');
    expect(toolNames(result)).toStrictEqual(['getA', 'getB']);
    expect(result.withheldOperations).toStrictEqual([]);
    // And on a later start, where the keys come from the cached candidate
    const restart = await runAt(fs, 20_500, 'fail');
    expect(restart.cacheStatus).toBe('fresh');
    expect(toolNames(restart)).toStrictEqual(['getA', 'getB']);
  });

  it('reports withheld operations through the meta tool omissions', async () => {
    const { result } = await withCandidate();
    const built = buildTools(result.namedOperations, {
      reservedHeaders: new Set(),
      openapiVersion: result.spec.openapiVersion,
    });
    const snapshot = buildSnapshot(built, result);
    expect(snapshot.meta.toolCount).toBe(1);
    expect(snapshot.meta.omittedReasons).toContainEqual({
      method: 'get',
      path: '/b',
      reason: expect.stringContaining('pending candidate') as string,
    });
  });

  it('fails closed when the candidate object is damaged', async () => {
    const { fs } = await withCandidate();
    const meta = metaOf(fs);
    fs.files.set(objectPath(layoutOf(fs), meta.candidate!.contentHash), '{"tampered":true}');
    await expect(runAt(fs, 20_500, 'fail')).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cache clear') as string,
    });
  });

  it('fails closed when the candidate object is missing but still named', async () => {
    const { fs } = await withCandidate();
    fs.files.delete(objectPath(layoutOf(fs), metaOf(fs).candidate!.contentHash));
    await expect(runAt(fs, 20_500, 'fail')).rejects.toMatchObject({ code: 'validation' });
  });

  it('asks for a rerun when a concurrent commit replaced the candidate mid-read', async () => {
    const { fs } = await withCandidate();
    const layout = layoutOf(fs);
    const candidatePath = objectPath(layout, metaOf(fs).candidate!.contentHash);
    // Simulate a promote landing between the entry read and the candidate
    // read: the object disappears and meta.json stops naming it
    const inner = fs.readFileTextCapped;
    fs.readFileTextCapped = (path, maxBytes) => {
      if (path === candidatePath) {
        const meta = metaOf(fs);
        const { candidate: _dropped, ...rest } = meta;
        fs.files.set(layout.metaPath, JSON.stringify(rest));
        fs.files.delete(candidatePath);
      }
      return inner(path, maxBytes);
    };
    await expect(runAt(fs, 20_500, 'fail')).rejects.toMatchObject({
      code: 'conflict',
      exitCode: 5,
    });
  });
});

describe('operationKeysOf', () => {
  it('reads methods through a Path Item $ref and a chain of them, with normalized templates', () => {
    const keys = operationKeysOf({
      paths: {
        '/inline': op('a'),
        '/ref/{id}': { $ref: '#/components/pathItems/P' },
        '/chain': { $ref: '#/components/pathItems/Alias' },
      },
      components: { pathItems: { P: op('p'), Alias: { $ref: '#/components/pathItems/P' } } },
    });
    expect([...keys].toSorted()).toStrictEqual(['GET /chain', 'GET /inline', 'GET /ref/{}']);
  });

  it('gives a path item whose $ref does not resolve or loops no keys (withheld, fail closed)', () => {
    const keys = operationKeysOf({
      paths: {
        '/dangling': { $ref: '#/components/pathItems/Missing' },
        '/loop': { $ref: '#/components/pathItems/L' },
      },
      components: { pathItems: { L: { $ref: '#/components/pathItems/L' } } },
    });
    expect([...keys]).toStrictEqual([]);
  });
});

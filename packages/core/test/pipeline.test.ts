import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildTools,
  CACHE_META_SCHEMA_VERSION,
  dereference,
  HTTP_METHODS,
  hashContent,
  normalizeSpec,
  parseFilterPattern,
  parseSpecText,
  runSpecPipeline,
  SPEC_BUDGETS,
  SYSTEM_HEADERS,
  validateOpenApiDocument,
} from '../src/index.ts';
import type { CacheFs, CacheMeta, SpecPipelineDeps } from '../src/index.ts';

// SpecPipelineDeps.fetcher is now typed via undici's own fetch (see
// fetch.test.ts's identical note). None of the fakes below touch
// `dispatcher`; the cast bridges the two fetch type declarations, not a
// claim about live pinning.
type SpecFetcher = SpecPipelineDeps['fetcher'];

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

const rejectingCacheFs: CacheFs = {
  mkdirSecure: () => Promise.reject(new Error('no cache filesystem in this test')),
  writeFileAtomic: () => Promise.reject(new Error('no cache filesystem in this test')),
  readFileTextCapped: () => Promise.reject(new Error('no cache filesystem in this test')),
  readDirNames: () => Promise.reject(new Error('no cache filesystem in this test')),
  removeDir: () => Promise.reject(new Error('no cache filesystem in this test')),
  pathExists: () => Promise.reject(new Error('no cache filesystem in this test')),
  createExclusive: () => Promise.reject(new Error('no cache filesystem in this test')),
  removeFile: () => Promise.reject(new Error('no cache filesystem in this test')),
};

const fileDeps = {
  readFileText: (path: string) => readFile(path, 'utf8'),
  fileSizeBytes: async (path: string) => {
    const stats = await stat(path);
    return stats.size;
  },
  fetcher: (() => Promise.reject(new Error('no network in this test'))) as unknown as SpecFetcher,
  lookup: (): Promise<readonly string[]> => Promise.reject(new Error('no dns in this test')),
  // Proves every case below reaches no filesystem: cacheRoot is undefined in baseOpts
  cacheFs: rejectingCacheFs,
};

const baseOpts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
  allow: [],
  deny: [],
  ttlMs: 3_600_000,
  trustSpecUpdates: false,
  cacheRoot: undefined,
  nowMs: 0,
};

// Matches every operation: restores the pre-filter inventory these assertions
// rely on. A bare "**" alone is NOT enough — it compiles to an
// `operationId`-kind pattern, and filter-engine.test.ts's own contract ("never
// matches an operationId pattern against an operation without one") means it
// skips petstore-3.0.json's GET /pets/{petId}, which has neither an
// operationId nor a tag. A methodPath pattern matches on method and path alone,
// independent of operationId or tags, so one per exposable method truly
// restores the full inventory regardless of fixture.
const allowAll = {
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`)),
};

// A URL-sourced spec with `count` trivial operations op0..op<count-1>, one per
// path /r0../r<count-1>
const bigDeps = (count: number, method: 'get' | 'post' = 'get'): typeof fileDeps => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    paths[`/r${index}`] = {
      [method]: { operationId: `op${index}`, responses: { '200': { description: 'ok' } } },
    };
  }
  const text = JSON.stringify({ openapi: '3.1.0', info: { title: 'Big', version: '1' }, paths });
  return {
    ...fileDeps,
    fetcher: (() => Promise.resolve(new Response(text))) as unknown as SpecFetcher,
  };
};

const suffix = (method: string, path: string): string =>
  createHash('sha256').update(`${method} ${path}`).digest('hex').slice(0, 8);

describe('runSpecPipeline — file sources', () => {
  it('runs the 3.0 JSON fixture end-to-end', async () => {
    const result = await runSpecPipeline(fixture('petstore-3.0.json'), baseOpts, fileDeps);
    expect(result.spec.title).toBe('Petstore');
    expect(result.spec.openapiVersion).toBe('3.0');
    expect(result.spec.omitted).toEqual([]);
    // The read-only default drops the POST unless allowed
    expect(result.namedOperations.map((named) => named.toolName)).toEqual([
      'listPets',
      'get_pets_by_petid',
    ]);
    expect(result.cacheStatus).toBe('bypassed');
    const unfiltered = await runSpecPipeline(
      fixture('petstore-3.0.json'),
      { ...baseOpts, ...allowAll },
      fileDeps,
    );
    expect(unfiltered.namedOperations.map((named) => named.toolName)).toEqual([
      'listPets',
      'createPet',
      'get_pets_by_petid',
    ]);
    // The $ref parameter was dereferenced into a concrete parameter object
    const listPets = unfiltered.namedOperations[0]?.operation;
    expect(listPets?.parameters[0]?.['name']).toBe('limit');
    // Path-level parameters were merged into the operation
    const byId = unfiltered.namedOperations[2]?.operation;
    expect(byId?.parameters[0]?.['name']).toBe('petId');
    expect(result.displaySource).toBe(fixture('petstore-3.0.json'));
    const fixtureText = await readFile(fixture('petstore-3.0.json'), 'utf8');
    expect(result.contentHash).toBe(hashContent(fixtureText));
  });

  it('resolves a relative path against opts.cwd', async () => {
    const result = await runSpecPipeline(
      'petstore-3.0.json',
      { ...baseOpts, cwd: fixturesDir },
      fileDeps,
    );
    expect(result.spec.title).toBe('Petstore');
  });

  it('runs the 3.1 YAML fixture with sanitization collisions and omissions', async () => {
    const result = await runSpecPipeline(
      fixture('petstore-3.1.yaml'),
      { ...baseOpts, ...allowAll },
      fileDeps,
    );
    expect(result.spec.openapiVersion).toBe('3.1');
    // Both operationIds sanitize to list_pets and get the stable hash suffix
    expect(result.namedOperations.map((named) => named.toolName)).toEqual([
      `list_pets_${suffix('GET', '/pets')}`,
      `list_pets_${suffix('GET', '/pets/all')}`,
    ]);
    expect(result.spec.omitted).toEqual([
      {
        method: 'TRACE',
        path: '/admin',
        reason: 'TRACE operations are never exposed',
        operationId: 'adminTrace',
      },
      {
        method: 'GET',
        path: '/admin',
        reason: 'per-operation servers overrides are not supported',
        operationId: 'adminGet',
      },
    ]);
    // The YAML alias resolved to a copy of the anchored schema
    const pet = result.namedOperations[0]?.operation.responses['200'];
    expect(JSON.stringify(pet)).toContain('nickname');
  });

  it('rejects spec headers for file sources', async () => {
    await expect(
      runSpecPipeline(
        fixture('petstore-3.0.json'),
        { ...baseOpts, specHeaders: [{ name: 'Authorization', value: 'Bearer x' }] },
        fileDeps,
      ),
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('--spec-header-env') as string,
    });
  });
});

describe('runSpecPipeline — URL sources', () => {
  const urlDeps = (text: string) => ({
    ...fileDeps,
    fetcher: (() => Promise.resolve(new Response(text))) as unknown as SpecFetcher,
  });

  it('fetches and processes a spec from a URL', async () => {
    const text = await readFile(fixture('petstore-3.0.json'), 'utf8');
    const result = await runSpecPipeline(
      'https://api.example.com/openapi.json?version=2',
      { ...baseOpts, ...allowAll },
      urlDeps(text),
    );
    expect(result.spec.title).toBe('Petstore');
    expect(result.namedOperations).toHaveLength(3);
    // Benign query strings are allowed but dropped from the display source
    expect(result.displaySource).toBe('https://api.example.com/openapi.json');
  });

  it('rejects credential-bearing query parameters before any fetch', async () => {
    let fetched = false;
    const deps = {
      ...fileDeps,
      fetcher: (() => {
        fetched = true;
        return Promise.resolve(new Response('{}'));
      }) as unknown as SpecFetcher,
    };
    await expect(
      runSpecPipeline('https://api.example.com/openapi.json?api_key=QUERY-SECRET', baseOpts, deps),
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.not.stringContaining('QUERY-SECRET') as string,
    });
    expect(fetched).toBe(false);
  });

  it('enforces the tool-count budget', async () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 513; index += 1) {
      paths[`/p${index}`] = {
        get: { responses: { '200': { description: 'ok' } } },
      };
    }
    const big = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Big', version: '1' },
      paths,
    });
    await expect(
      runSpecPipeline('https://api.example.com/big.json', baseOpts, urlDeps(big)),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('512') as string,
    });
  });

  it('propagates fetch failures as validation errors', async () => {
    const failing = {
      ...fileDeps,
      fetcher: (() =>
        Promise.resolve(new Response('down', { status: 503 }))) as unknown as SpecFetcher,
    };
    await expect(
      runSpecPipeline('https://api.example.com/spec.json', baseOpts, failing),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

type MemoryCacheFs = CacheFs & {
  files: Map<string, string>;
  calls: string[];
};

const memoryCacheFs = (): MemoryCacheFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/cache']);
  const calls: string[] = [];
  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  return {
    files,
    calls,
    mkdirSecure: (path) => {
      dirs.add(path);
      return record('mkdirSecure', Promise.resolve());
    },
    writeFileAtomic: (path, data) => {
      files.set(path, data);
      return record('writeFileAtomic', Promise.resolve());
    },
    readFileTextCapped: (path, maxBytes) => {
      calls.push('readFileTextCapped');
      const found = files.get(path);
      if (found === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return found.length > maxBytes
        ? Promise.reject(new Error(`cache file exceeds ${String(maxBytes)} bytes`))
        : Promise.resolve(found);
    },
    readDirNames: (path) => {
      calls.push('readDirNames');
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split('/')[0] ?? '');
        }
      }
      return Promise.resolve([...names].filter((name) => name !== ''));
    },
    removeDir: (path) => {
      // No defensive copy needed: deleting the current or an already-visited
      // key mid-iteration is well-defined for Map's keys() iterator
      for (const key of files.keys()) {
        if (key === path || key.startsWith(`${path}/`)) {
          files.delete(key);
        }
      }
      dirs.delete(path);
      return record('removeDir', Promise.resolve());
    },
    pathExists: (path) =>
      record(
        'pathExists',
        Promise.resolve(
          files.has(path) ||
            dirs.has(path) ||
            [...files.keys()].some((key) => key.startsWith(`${path}/`)),
        ),
      ),
    createExclusive: (path, data) => {
      calls.push('createExclusive');
      if (files.has(path)) {
        return Promise.resolve(false);
      }
      files.set(path, data);
      return Promise.resolve(true);
    },
    removeFile: (path) => {
      files.delete(path);
      return record('removeFile', Promise.resolve());
    },
  };
};

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

const metaOf = (cacheFs: MemoryCacheFs): CacheMeta => {
  const entry = [...cacheFs.files.entries()].find(([key]) => key.endsWith('meta.json'));
  return JSON.parse(entry?.[1] ?? '{}') as CacheMeta;
};

const metaPathOf = (cacheFs: MemoryCacheFs): string =>
  [...cacheFs.files.keys()].find((key) => key.endsWith('meta.json'))!;

describe('runSpecPipeline — cache', () => {
  const specUrl = 'https://api.example.com/openapi.json';
  const cachedOpts = { ...baseOpts, cacheRoot: '/cache', ...allowAll };

  const countingFetcher = (
    text: string,
    headers: Record<string, string> = {},
  ): { fetcher: SpecFetcher; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      fetcher: (() => {
        calls += 1;
        return Promise.resolve(new Response(text, { headers }));
      }) as unknown as SpecFetcher,
    };
  };

  it('bypasses the cache when no cache root is available', async () => {
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    const cacheFs = memoryCacheFs();
    const result = await runSpecPipeline(
      specUrl,
      { ...baseOpts, ...allowAll },
      {
        ...fileDeps,
        fetcher,
        cacheFs,
      },
    );
    expect(result.cacheStatus).toBe('bypassed');
    expect(cacheFs.calls).toEqual([]);
    expect(result.warnings.join('\n')).toContain('cache');
  });

  it('warns about an over-budget server URL on the first fetch AND when served from the cache (issue kaisers-io/openapi-mcp-archive#37)', async () => {
    const parsed = JSON.parse(remoteSpec('Big')) as Record<string, unknown>;
    const big = JSON.stringify({
      ...parsed,
      servers: [
        {
          url: `https://a.example/${'{x}'.repeat(2000)}`,
          variables: { x: { default: 'y'.repeat(5000) } },
        },
      ],
    });
    const cacheFs = memoryCacheFs();
    const first = await runSpecPipeline(specUrl, cachedOpts, {
      ...fileDeps,
      fetcher: countingFetcher(big).fetcher,
      cacheFs,
    });
    expect(first.spec.serverUrlRejected).toEqual({ expandedBytes: 10_000_018 });
    expect(first.namedOperations).toHaveLength(1);
    expect(first.warnings.join('\n')).toContain('2048-byte budget for a server URL');
    const fresh = await runSpecPipeline(specUrl, cachedOpts, {
      ...fileDeps,
      fetcher: countingFetcher(big).fetcher,
      cacheFs,
    });
    expect(fresh.cacheStatus).toBe('fresh');
    expect(fresh.warnings.join('\n')).toContain('2048-byte budget for a server URL');
  });

  it('writes the accepted baseline on a first-ever fetch (trust-on-first-use)', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    const result = await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    expect(result.cacheStatus).toBe('accepted-first');
    expect(result.warnings).toEqual([]);
    expect(calls()).toBe(1);
    const meta = metaOf(cacheFs);
    // The source hash and the persisted-bytes hash are distinct values
    expect(meta.sourceContentHash).toBe(hashContent(remoteSpec('Remote')));
    expect(meta.acceptedContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(meta.candidate).toBeUndefined();
    // The redacted display source is what lands on disk
    expect(meta.displaySource).toBe(specUrl);
    expect(meta.title).toBe('Remote');
    // The discriminator is persisted, because a hit will not revalidate
    // to recover it
    expect(meta.openapiVersion).toBe('3.1');
    // The contentHash keeps its established meaning — the source hash of the bytes used
    expect(result.contentHash).toBe(hashContent(remoteSpec('Remote')));
  });

  it('serves a fresh accepted baseline without touching the network', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 60_000 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('fresh');
    expect(calls()).toBe(1);
    expect(second.spec.title).toBe('Remote');
    expect(second.contentHash).toBe(hashContent(remoteSpec('Remote')));
  });

  it('refuses a metadata version that contradicts the accepted bytes', async () => {
    // A hazard worth naming: the content hash protects the OBJECT, not
    // meta.json, so anyone who can edit metadata could force a 3.1 document to
    // be normalized under 3.0 rules without breaking a single hash. The
    // discriminator is verified against the document's own "openapi" field,
    // which is one field read, not a revalidation.
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const metaPath = metaPathOf(cacheFs);
    const stored = JSON.parse(cacheFs.files.get(metaPath) ?? '{}') as CacheMeta;
    // Every hash left intact — only the discriminator is flipped
    cacheFs.files.set(metaPath, JSON.stringify({ ...stored, openapiVersion: '3.0' }));
    await expect(
      runSpecPipeline(specUrl, { ...cachedOpts, nowMs: 60_000 }, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
    // Fail-closed: no refetch, so the tampering cannot launder itself into a
    // fresh trust-on-first-use acceptance either
    expect(calls()).toBe(1);
  });

  it('still serves a hit without revalidating when metadata and bytes agree', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 60_000 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('fresh');
    expect(second.spec.openapiVersion).toBe('3.1');
    // No network, and no Ajv pass — that is the whole point of a cache hit
    expect(calls()).toBe(1);
  });

  it('revalidates past the TTL and bumps fetchedAt on 304', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const seen: (string | null)[] = [];
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      seen.push(new Headers(init?.headers).get('if-none-match'));
      return calls === 1
        ? Promise.resolve(new Response(remoteSpec('Remote'), { headers: { etag: '"v1"' } }))
        : Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v1"' } }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const later = 3_600_001;
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: later },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('revalidated');
    expect(seen[1]).toBe('"v1"');
    expect(metaOf(cacheFs).fetchedAt).toBe(later);
  });

  it('stores a changed spec as a candidate and keeps serving the accepted baseline', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : remoteSpec('Remote', '/extra')),
      );
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    // The changed spec waits as a candidate; the accepted baseline serves
    expect(second.cacheStatus).toBe('candidate');
    expect(second.namedOperations.map((named) => named.toolName)).toEqual(['listThings']);
    expect(second.warnings.join('\n')).toContain('cache promote');
    expect(second.candidateContentHash).toMatch(/^[0-9a-f]{64}$/u);
    const meta = metaOf(cacheFs);
    expect(meta.sourceContentHash).toBe(hashContent(remoteSpec('Remote')));
    expect(meta.candidate?.sourceContentHash).toBe(hashContent(remoteSpec('Remote', '/extra')));
  });

  it('still reports the candidate on a restart INSIDE the TTL', async () => {
    // A naive implementation reports the candidate only on the run that
    // created it: a later start would return `fresh` with no candidate hash
    // and no warning — the candidate would be on disk, gating the update, and
    // invisible.
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : remoteSpec('Remote', '/extra')),
      );
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const created = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(created.cacheStatus).toBe('candidate');

    // A third run one second later is inside the TTL, so it serves the accepted
    // baseline without any network — and must still say a candidate is waiting
    const restart = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_601_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(restart.cacheStatus).toBe('fresh');
    expect(restart.candidateContentHash).toBe(created.candidateContentHash);
    expect(restart.warnings.join('\n')).toContain('cache promote');
    // And it really did serve the accepted baseline, not the candidate
    expect(restart.namedOperations.map((named) => named.toolName)).toEqual(['listThings']);
  });

  it('preserves and reports the candidate across a later 304', async () => {
    // Running writeAccepted on a 304 would rewrite the accepted entry and
    // CLEAR the candidate — silently discarding a candidate awaiting promotion
    // without ever approving it.
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = ((_url: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(remoteSpec('Remote'), { headers: { etag: '"v1"' } }));
      }
      if (calls === 2) {
        return Promise.resolve(
          new Response(remoteSpec('Remote', '/extra'), { headers: { etag: '"v2"' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v2"' } }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const created = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(created.cacheStatus).toBe('candidate');
    const candidateHash = created.candidateContentHash;

    const revalidated = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 7_200_002 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(revalidated.cacheStatus).toBe('revalidated');
    // The candidate survived, is still reported, and still warns
    expect(revalidated.candidateContentHash).toBe(candidateHash);
    expect(revalidated.warnings.join('\n')).toContain('cache promote');
    expect(metaOf(cacheFs).candidate?.contentHash).toBe(candidateHash);
    // The accepted baseline is untouched and still what is served
    expect(revalidated.namedOperations.map((named) => named.toolName)).toEqual(['listThings']);
  });

  it('a 304 keeps the pending candidate even with --trust-spec-updates', async () => {
    // Same shared 304 branch as the sibling above, but with trustSpecUpdates: true —
    // pins that trust does not let a 304 (unchanged content) accept a candidate.
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = ((_url: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(remoteSpec('Remote'), { headers: { etag: '"v1"' } }));
      }
      if (calls === 2) {
        return Promise.resolve(
          new Response(remoteSpec('Remote', '/extra'), { headers: { etag: '"v2"' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v2"' } }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const created = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(created.cacheStatus).toBe('candidate');
    const before = metaOf(cacheFs);

    const revalidated = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 7_200_002, trustSpecUpdates: true },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(revalidated.cacheStatus).toBe('revalidated');
    const after = metaOf(cacheFs);
    expect(after.acceptedContentHash).toBe(before.acceptedContentHash);
    // The SAME pending candidate survived (not merely "a candidate exists"),
    // matching the existing sibling's assertion style (pipeline.test.ts:551).
    expect(after.candidate?.contentHash).toBe(before.candidate?.contentHash);
    expect(after.candidate?.contentHash).toBeDefined();
  });

  it('replays the candidate validators on the next revalidation', async () => {
    // Meta.etag describes the most recently FETCHED representation, which is
    // the candidate once one exists
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const seen: (string | null)[] = [];
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      seen.push(new Headers(init?.headers).get('if-none-match'));
      if (calls === 1) {
        return Promise.resolve(new Response(remoteSpec('Remote'), { headers: { etag: '"v1"' } }));
      }
      if (calls === 2) {
        return Promise.resolve(
          new Response(remoteSpec('Remote', '/extra'), { headers: { etag: '"v2"' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v2"' } }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 7_200_002 },
      { ...fileDeps, fetcher, cacheFs },
    );
    // The third request asked about the CANDIDATE's representation, not the
    // accepted baseline's stale "v1"
    expect(seen[2]).toBe('"v2"');
  });

  it('reports the candidate on a stale result too', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(remoteSpec('Remote')));
      }
      if (calls === 2) {
        return Promise.resolve(new Response(remoteSpec('Remote', '/extra')));
      }
      return Promise.resolve(new Response('down', { status: 503 }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const created = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    const stale = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 7_200_002 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(stale.cacheStatus).toBe('stale');
    expect(stale.candidateContentHash).toBe(created.candidateContentHash);
    expect(stale.warnings.join('\n')).toContain('cache promote');
  });

  it('accepts a changed spec directly under --trust-spec-updates', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : remoteSpec('Remote', '/extra')),
      );
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    // Adding `cacheKey: 'prod'` ONLY on this second call would be a mistake:
    // cacheNamespace binds the namespace to the key whenever one is given,
    // authenticated or not, so that alone would point the second run at an
    // entirely different, still-empty namespace — the read would then miss,
    // and the run would report `accepted-first` again rather than exercising
    // the update path this test is named for. Omitting it here keeps both
    // calls in the same namespace.
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001, trustSpecUpdates: true },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('accepted-update');
    expect(second.namedOperations.map((named) => named.toolName)).toEqual([
      'listThings',
      'listExtra',
    ]);
    expect(metaOf(cacheFs).candidate).toBeUndefined();
  });

  it('serves the last known good baseline with a warning when a refresh fails', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(new Response(remoteSpec('Remote')))
        : Promise.resolve(new Response('down', { status: 503 }));
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('stale');
    expect(second.spec.title).toBe('Remote');
    expect(second.warnings.join('\n')).toContain('last known good');
  });

  it('serves the last known good baseline when the refreshed spec fails validation', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : '{"openapi":"3.1.0"}'),
      );
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(second.cacheStatus).toBe('stale');
    // The invalid refresh reached neither the accepted nor the candidate slot
    expect(metaOf(cacheFs).candidate).toBeUndefined();
  });

  it('propagates the failure when a refresh fails with no accepted baseline', async () => {
    const cacheFs = memoryCacheFs();
    const fetcher = (() =>
      Promise.resolve(new Response('down', { status: 503 }))) as unknown as SpecFetcher;
    await expect(
      runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect([...cacheFs.files.keys()]).toEqual([]);
  });

  it('never writes a spec that fails validation', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher } = countingFetcher('{"openapi":"3.1.0"}');
    await expect(
      runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect([...cacheFs.files.keys()]).toEqual([]);
  });

  it('fails closed on a corrupt accepted baseline instead of refetching', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    cacheFs.files.set(metaPathOf(cacheFs), 'not json at all');
    await expect(
      runSpecPipeline(specUrl, { ...cachedOpts, nowMs: 1000 }, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('openapi-mcp cache clear') as string,
    });
    // No refetch happened: a silent refetch would re-enter trust-on-first-use
    expect(calls()).toBe(1);
  });

  it('refuses to let a changed remote spec become accepted by corrupting the entry', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : remoteSpec('Evil', '/backdoor')),
      );
    }) as unknown as SpecFetcher;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const acceptedBefore = metaOf(cacheFs).acceptedContentHash;
    // An attacker who can write into the cache directory corrupts the anchor
    cacheFs.files.set(metaPathOf(cacheFs), '{"schemaVersion":1}');
    await expect(
      runSpecPipeline(specUrl, { ...cachedOpts, nowMs: 1000 }, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
    // `calls` here is the plain counter this test increments itself, not the
    // `() => number` countingFetcher() returns elsewhere in this file —
    // `calls()` throws TypeError before the assertion is ever checked
    expect(calls).toBe(1);
    // The stored bytes are untouched: recovery is an explicit operator act
    expect(cacheFs.files.get(metaPathOf(cacheFs))).toBe('{"schemaVersion":1}');
    expect(acceptedBefore).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('treats an over-cap meta.json as corrupt rather than a miss', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    cacheFs.files.set(metaPathOf(cacheFs), 'x'.repeat(70_000));
    await expect(
      runSpecPipeline(specUrl, { ...cachedOpts, nowMs: 1000 }, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('fails closed when the namespace cannot be prepared — never a bypass', async () => {
    // Treating this as a degraded mode and serving the remote document
    // anyway would be an authorization reset: with the namespace unreachable,
    // nothing consults the durable accepted baseline, so the run behaves
    // exactly like trust-on-first-use. An attacker who can make one mkdir fail
    // would get exactly the rug pull this fail-closed behavior exists to prevent.
    const failing: CacheFs = {
      ...memoryCacheFs(),
      mkdirSecure: () => Promise.reject(new Error('EACCES: permission denied')),
    };
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await expect(
      runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs: failing }),
    ).rejects.toMatchObject({
      // Assert the DECLARED exit code, not merely "it rejects": a raw fs
      // error passing through unhandled would still reject, but exits 1
      // instead of the declared code, and asserting only rejection would let
      // that pass unnoticed.
      code: 'validation',
      exitCode: 3,
    });
    // The load-bearing assertion: no fetch was issued and no document served
    expect(calls()).toBe(0);
  });

  it('fails closed when the entry cannot be read, rather than treating it as absent', async () => {
    // PathExists must not fold EACCES into "nothing cached here": a miss is the
    // one outcome that may become trust-on-first-use
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const seeded = calls();

    const unreadable: CacheFs = {
      ...cacheFs,
      readFileTextCapped: (path, maxBytes) =>
        path.endsWith('meta.json')
          ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
          : cacheFs.readFileTextCapped(path, maxBytes),
    };
    await expect(
      runSpecPipeline(
        specUrl,
        { ...cachedOpts, nowMs: 1000 },
        { ...fileDeps, fetcher, cacheFs: unreadable },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    // No refetch: an unreadable baseline must not be replaced by whatever the
    // remote says now
    expect(calls()).toBe(seeded);
  });

  it('propagates a non-absence error from pathExists instead of reporting a miss', async () => {
    const cacheFs: CacheFs = {
      ...memoryCacheFs(),
      pathExists: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
    };
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await expect(
      runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
    expect(calls()).toBe(0);
  });

  it('bypasses ONLY through an explicit policy branch', async () => {
    // The complement of the three cases above: the one legitimate bypass still
    // works, and it is a policy decision rather than the fallout of an error
    const cacheFs = memoryCacheFs();
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    const result = await runSpecPipeline(
      specUrl,
      {
        ...cachedOpts,
        specHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
        trustSpecUpdates: true,
      },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(result.cacheStatus).toBe('bypassed');
    expect(cacheFs.calls).toEqual([]);
  });

  it('re-reads a file source on every run and reports fresh when unchanged', async () => {
    const cacheFs = memoryCacheFs();
    const opts = { ...cachedOpts, cwd: fixturesDir };
    const first = await runSpecPipeline('petstore-3.0.json', opts, { ...fileDeps, cacheFs });
    expect(first.cacheStatus).toBe('accepted-first');
    const second = await runSpecPipeline(
      'petstore-3.0.json',
      { ...opts, nowMs: 999_999_999 },
      { ...fileDeps, cacheFs },
    );
    // File specs are re-read and hash-compared on every tick,
    // so the TTL never short-circuits them — an unchanged file still reports fresh
    expect(second.cacheStatus).toBe('revalidated');
  });

  it('bypasses persistence entirely for an authenticated source under --trust-spec-updates', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    const result = await runSpecPipeline(
      specUrl,
      {
        ...cachedOpts,
        specHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
        trustSpecUpdates: true,
      },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(result.cacheStatus).toBe('bypassed');
    // Two different credentials must never share a source-only namespace, so
    // this mode touches the filesystem not at all
    expect(cacheFs.calls).toEqual([]);
    expect([...cacheFs.files.keys()]).toEqual([]);
  });

  it('persists an authenticated source when --cache-key separates it', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    const result = await runSpecPipeline(
      specUrl,
      {
        ...cachedOpts,
        specHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
        cacheKey: 'prod',
      },
      { ...fileDeps, fetcher, cacheFs },
    );
    expect(result.cacheStatus).toBe('accepted-first');
    expect(metaOf(cacheFs).cacheKey).toBe('prod');
    // No secret material derived the namespace or reached the disk
    expect([...cacheFs.files.values()].join('\n')).not.toContain('Bearer x');
  });

  it('rejects an authenticated source with no cache decision', async () => {
    const { fetcher } = countingFetcher(remoteSpec('Remote'));
    const cacheFs = memoryCacheFs();
    await expect(
      runSpecPipeline(
        specUrl,
        { ...cachedOpts, specHeaders: [{ name: 'Authorization', value: 'Bearer x' }] },
        { ...fileDeps, fetcher, cacheFs },
      ),
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('--cache-key') as string,
    });
    expect(cacheFs.calls).toEqual([]);
  });

  it('diagnoses a file source with spec headers before the cache decision', async () => {
    // Both errors mention --spec-header-env: order decides which one the
    // operator actually reads, so pin it
    await expect(
      runSpecPipeline(
        fixture('petstore-3.0.json'),
        {
          ...baseOpts,
          cacheRoot: '/cache',
          specHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
        },
        { ...fileDeps, cacheFs: memoryCacheFs() },
      ),
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('URL spec sources') as string,
    });
  });
});

describe('runSpecPipeline — filters', () => {
  it('applies the read-only default when no allow pattern is given', async () => {
    const result = await runSpecPipeline(fixture('petstore-3.0.json'), baseOpts, fileDeps);
    expect(result.namedOperations.map((named) => named.operation.method)).toEqual(['get', 'get']);
  });

  it('lets deny win over allow', async () => {
    const result = await runSpecPipeline(
      fixture('petstore-3.0.json'),
      { ...baseOpts, allow: [parseFilterPattern('**')], deny: [parseFilterPattern('createPet')] },
      fileDeps,
    );
    expect(result.namedOperations.map((named) => named.toolName)).not.toContain('createPet');
  });

  it('reports dead patterns with their flag and a closest-match suggestion', async () => {
    const result = await runSpecPipeline(
      fixture('petstore-3.0.json'),
      { ...baseOpts, allow: [parseFilterPattern('listPetz')] },
      fileDeps,
    );
    expect(result.namedOperations).toEqual([]);
    expect(result.deadPatterns).toEqual([
      { raw: 'listPetz', flag: 'allow', suggestion: 'listPets' },
    ]);
  });

  it('tags a dead deny pattern with the deny flag', async () => {
    const result = await runSpecPipeline(
      fixture('petstore-3.0.json'),
      { ...baseOpts, deny: [parseFilterPattern('nothingLikeThis')] },
      fileDeps,
    );
    expect(result.deadPatterns[0]?.flag).toBe('deny');
  });

  it('reports no dead patterns when every pattern matches', async () => {
    const result = await runSpecPipeline(
      fixture('petstore-3.0.json'),
      { ...baseOpts, allow: [parseFilterPattern('listPets')] },
      fileDeps,
    );
    expect(result.deadPatterns).toEqual([]);
  });

  it('does not count operations the filters drop against the tool budget', async () => {
    // 513 POSTs the read-only default drops: nothing is exposed, so the
    // exposed-set budget (issue kaisers-io/openapi-mcp-archive#32) has nothing
    // to refuse. The raw cap below still bounds the unfiltered document.
    const result = await runSpecPipeline(
      'https://api.example.com/big.json',
      baseOpts,
      bigDeps(513, 'post'),
    );
    expect(result.namedOperations).toEqual([]);
  });
});

describe('runSpecPipeline — tool budget after filtering (issue kaisers-io/openapi-mcp-archive#32)', () => {
  it('lets a narrow --allow carve one tool out of a spec with more operations than the budget', async () => {
    const result = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...baseOpts, allow: [parseFilterPattern('op1')] },
      bigDeps(600),
    );
    expect(result.namedOperations.map((named) => named.toolName)).toEqual(['op1']);
    expect(result.spec.operations).toHaveLength(600);
  });

  it('enforces the tool budget on the exposed set and names the filters as the remedy', async () => {
    // The read-only default exposes all 600 GETs
    await expect(
      runSpecPipeline('https://api.example.com/big.json', baseOpts, bigDeps(600)),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringMatching(/600 tools .*512-tool budget.*--allow.*--deny/u) as string,
    });
  });

  it('counts only what survives --deny against the tool budget', async () => {
    const result = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...baseOpts, deny: [parseFilterPattern('GET /r1*')] },
      bigDeps(600),
    );
    // 600 minus /r1, /r10-/r19 and /r100-/r199
    expect(result.namedOperations).toHaveLength(489);
  });

  it('still refuses a spec above the raw operation cap, whatever the filters', async () => {
    await expect(
      runSpecPipeline(
        'https://api.example.com/big.json',
        { ...baseOpts, allow: [parseFilterPattern('op1')] },
        bigDeps(SPEC_BUDGETS.maxOperationCount + 1),
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining(
        `${String(SPEC_BUDGETS.maxOperationCount + 1)} operations`,
      ) as string,
    });
  });

  it('refuses a spec above the raw cap before anything is written to the cache', async () => {
    const cacheFs = memoryCacheFs();
    await expect(
      runSpecPipeline(
        'https://api.example.com/big.json',
        { ...baseOpts, cacheRoot: '/cache', allow: [parseFilterPattern('op1')] },
        { ...bigDeps(SPEC_BUDGETS.maxOperationCount + 1), cacheFs },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(cacheFs.files.size).toBe(0);
  });

  it('writes no accepted baseline when the run refuses to serve an over-budget exposed set', async () => {
    const cacheFs = memoryCacheFs();
    await expect(
      runSpecPipeline(
        'https://api.example.com/big.json',
        { ...baseOpts, cacheRoot: '/cache' },
        { ...bigDeps(600), cacheFs },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    expect([...cacheFs.files.keys()].filter((key) => key.endsWith('meta.json'))).toEqual([]);
  });

  it('warns when a recorded candidate would exceed the tool budget under the current filters', async () => {
    const cacheFs = memoryCacheFs();
    const cachedOpts = { ...baseOpts, cacheRoot: '/cache' };
    // Accepted baseline: 10 GETs, well inside the budget
    await runSpecPipeline('https://api.example.com/big.json', cachedOpts, {
      ...bigDeps(10),
      cacheFs,
    });
    // The refreshed spec documents 600 GETs: recorded as a candidate, the
    // baseline keeps serving, and the run says promotion would fail to start
    const refreshed = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...bigDeps(600), cacheFs },
    );
    expect(refreshed.cacheStatus).toBe('candidate');
    expect(refreshed.namedOperations).toHaveLength(10);
    expect(refreshed.warnings.join('\n')).toMatch(
      /candidate spec would expose 600 tools .*512-tool budget.*--allow or --deny/u,
    );
  });

  it('checks a candidate against the budget of the run (discover mode allows more tools)', async () => {
    const cacheFs = memoryCacheFs();
    const cachedOpts = {
      ...baseOpts,
      cacheRoot: '/cache',
      maxToolCount: SPEC_BUDGETS.maxDiscoverToolCount,
    };
    await runSpecPipeline('https://api.example.com/big.json', cachedOpts, {
      ...bigDeps(10),
      cacheFs,
    });
    const refreshed = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...bigDeps(600), cacheFs },
    );
    expect(refreshed.cacheStatus).toBe('candidate');
    expect(refreshed.warnings.join('\n')).not.toContain('tool budget');
  });

  it('does not warn about a candidate that fits the tool budget', async () => {
    const cacheFs = memoryCacheFs();
    const cachedOpts = { ...baseOpts, cacheRoot: '/cache' };
    await runSpecPipeline('https://api.example.com/big.json', cachedOpts, {
      ...bigDeps(10),
      cacheFs,
    });
    // 600 operations, but --deny leaves 489 exposed: under the budget
    const refreshed = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...cachedOpts, deny: [parseFilterPattern('GET /r1*')], nowMs: 3_600_001 },
      { ...bigDeps(600), cacheFs },
    );
    expect(refreshed.cacheStatus).toBe('candidate');
    expect(refreshed.warnings.join('\n')).not.toContain('tool budget');
  });

  it('refuses an over-budget exposed set on an unchanged 200 before any bookkeeping touch', async () => {
    // The unchanged-200 path only touches meta.json
    // (kaisers-io/openapi-mcp-archive#106); that touch must not happen for a
    // run the tool budget refuses (kaisers-io/openapi-mcp-archive#32)
    const cacheFs = memoryCacheFs();
    const cachedOpts = { ...baseOpts, cacheRoot: '/cache' };
    await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...cachedOpts, allow: [parseFilterPattern('op1')] },
      { ...bigDeps(600), cacheFs },
    );
    const before = metaOf(cacheFs);
    // Past the TTL, same bytes, but without the narrowing filter
    await expect(
      runSpecPipeline(
        'https://api.example.com/big.json',
        { ...cachedOpts, nowMs: 3_600_001 },
        { ...bigDeps(600), cacheFs },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('512-tool budget') as string,
    });
    expect(metaOf(cacheFs)).toEqual(before);
  });

  it('applies the same two-level rule when serving a cached spec', async () => {
    const cacheFs = memoryCacheFs();
    const cachedOpts = { ...baseOpts, cacheRoot: '/cache' };
    const narrow = { ...cachedOpts, allow: [parseFilterPattern('op1')] };
    const first = await runSpecPipeline('https://api.example.com/big.json', narrow, {
      ...bigDeps(600),
      cacheFs,
    });
    expect(first.cacheStatus).toBe('accepted-first');
    // Inside the TTL: served from the cache, filtered the same way
    const hit = await runSpecPipeline(
      'https://api.example.com/big.json',
      { ...narrow, nowMs: 60_000 },
      { ...bigDeps(600), cacheFs },
    );
    expect(hit.cacheStatus).toBe('fresh');
    expect(hit.namedOperations.map((named) => named.toolName)).toEqual(['op1']);
    // The same cached spec without the filter would expose all 600
    await expect(
      runSpecPipeline(
        'https://api.example.com/big.json',
        { ...cachedOpts, nowMs: 60_000 },
        { ...bigDeps(600), cacheFs },
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('512-tool budget') as string,
    });
  });
});

describe('runSpecPipeline — filter before dereference, raw-document cache (issue kaisers-io/openapi-mcp-archive#89)', () => {
  const specUrl = 'https://api.example.com/layered.json';
  // Issue kaisers-io/openapi-mcp-archive#89's generator: `schemas` schemas in
  // `layers` layers, each referencing `refs` schemas of the next one
  const layered = (schemas: number, refs: number, pathCount: number, layers: number): string => {
    const perLayer = Math.ceil(schemas / layers);
    const components: Record<string, unknown> = {};
    for (let index = 0; index < schemas; index += 1) {
      const layer = Math.floor(index / perLayer);
      const properties: Record<string, unknown> = {
        id: { type: 'string' },
        name: { type: 'string', maxLength: 64 },
        count: { type: 'integer', minimum: 0 },
      };
      if (layer < layers - 1) {
        for (let ref = 0; ref < refs; ref += 1) {
          const target = Math.min(schemas - 1, (layer + 1) * perLayer + ((index + ref) % perLayer));
          properties[`rel${ref}`] = { $ref: `#/components/schemas/S${target}` };
        }
      }
      components[`S${index}`] = { type: 'object', required: ['id'], properties };
    }
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < pathCount; index += 1) {
      const schema = { $ref: `#/components/schemas/S${index % schemas}` };
      const ok = { 200: { description: 'ok', content: { 'application/json': { schema } } } };
      paths[`/r${index}`] = {
        get: { operationId: `get${index}`, responses: ok },
        put: {
          operationId: `put${index}`,
          requestBody: { content: { 'application/json': { schema } } },
          responses: ok,
        },
      };
    }
    return JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'layered', version: '1' },
      paths,
      components: { schemas: components },
    });
  };
  const textDeps = (text: string): typeof fileDeps => ({
    ...fileDeps,
    fetcher: (() => Promise.resolve(new Response(text))) as unknown as SpecFetcher,
  });

  it('accepts a spec whose shared nested models used to exceed the node budget', async () => {
    // 200 x 2 x 8: about 11,000 source nodes; copying every $ref occurrence
    // went past 500,000 nodes, sharing them stays far below
    const result = await runSpecPipeline(
      specUrl,
      { ...baseOpts, ...allowAll },
      textDeps(layered(200, 2, 200, 8)),
    );
    expect(result.namedOperations).toHaveLength(400);
  });

  it('dereferences only the exposed operations', async () => {
    // The getDeep response runs through a 70-deep $ref chain, past the 64-level
    // depth budget: refused when exposed, irrelevant when filtered out
    const chain: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) {
      chain[`C${index}`] = {
        type: 'object',
        properties: { next: { $ref: `#/components/schemas/C${index + 1}` } },
      };
    }
    chain['C70'] = { type: 'string' };
    const text = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'deep', version: '1' },
      paths: {
        '/ok': { get: { operationId: 'getOk', responses: { 200: { description: 'ok' } } } },
        '/deep': {
          get: {
            operationId: 'getDeep',
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/C0' } } },
              },
            },
          },
        },
      },
      components: { schemas: chain },
    });
    const narrow = await runSpecPipeline(
      specUrl,
      { ...baseOpts, allow: [parseFilterPattern('getOk')] },
      textDeps(text),
    );
    expect(narrow.namedOperations.map((named) => named.toolName)).toEqual(['getOk']);
    await expect(
      runSpecPipeline(
        specUrl,
        { ...baseOpts, allow: [parseFilterPattern('getDeep')] },
        textDeps(text),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('maximum depth') as string });
  });

  it('still refuses a dangling $ref anywhere in the spec before caching it', async () => {
    const cacheFs = memoryCacheFs();
    const text = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'dangling', version: '1' },
      paths: {
        '/ok': { get: { operationId: 'getOk', responses: { 200: { description: 'ok' } } } },
        '/bad': {
          get: {
            operationId: 'getBad',
            responses: { 200: { $ref: '#/components/responses/Missing' } },
          },
        },
      },
    });
    await expect(
      runSpecPipeline(
        specUrl,
        { ...baseOpts, cacheRoot: '/cache', allow: [parseFilterPattern('getOk')] },
        { ...textDeps(text), cacheFs },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('does not resolve') as string });
    expect(cacheFs.files.size).toBe(0);
  });

  it('persists the validated source document, not its dereferenced form', async () => {
    const cacheFs = memoryCacheFs();
    const text = layered(200, 2, 200, 7);
    await runSpecPipeline(
      specUrl,
      { ...baseOpts, cacheRoot: '/cache', ...allowAll },
      {
        ...textDeps(text),
        cacheFs,
      },
    );
    const meta = metaOf(cacheFs);
    expect(meta.schemaVersion).toBe(CACHE_META_SCHEMA_VERSION);
    const stored = [...cacheFs.files.entries()].find(([key]) =>
      key.includes(meta.acceptedContentHash),
    )?.[1];
    // The same JSON the source parses to: $refs and components intact, about
    // the source's size where the dereferenced form was about 4.5 MB
    expect(JSON.parse(stored ?? '')).toEqual(JSON.parse(text));
    expect(stored?.length).toBeLessThan(2 * text.length);
  });

  it('generates the same tools as dereferencing the whole document first', async () => {
    for (const name of ['petstore-3.0.json', 'petstore-3.1.yaml']) {
      const text = await readFile(fixture(name), 'utf8');
      const validated = validateOpenApiDocument(parseSpecText(text));
      const reference = normalizeSpec(dereference(validated.document), validated.version);
      const result = await runSpecPipeline(fixture(name), { ...baseOpts, ...allowAll }, fileDeps);
      const opts = { reservedHeaders: SYSTEM_HEADERS, openapiVersion: validated.version };
      const before = buildTools(assignToolNames(reference.operations), opts);
      const after = buildTools(result.namedOperations, opts);
      const wire = (built: typeof before): unknown =>
        built.tools.map((tool) => [
          tool.toolName,
          tool.description,
          tool.wireSchema,
          tool.outputSchema,
        ]);
      expect(JSON.stringify(wire(after))).toBe(JSON.stringify(wire(before)));
      expect(after.omitted).toEqual(before.omitted);
      expect(result.spec.omitted).toEqual(reference.omitted);
    }
  });

  it('migrates a version 1 cache entry: refetched without validators, rewritten as the source document', async () => {
    const cacheFs = memoryCacheFs();
    const text = remoteSpec('Remote');
    const seen: (string | null)[] = [];
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('if-none-match'));
      return Promise.resolve(new Response(text, { headers: { etag: '"v1"' } }));
    }) as unknown as SpecFetcher;
    const opts = { ...baseOpts, cacheRoot: '/cache', ...allowAll };
    await runSpecPipeline(specUrl, opts, { ...fileDeps, fetcher, cacheFs });
    // Rewrite the entry the way a version 1 build stored it: schemaVersion 1
    // and the document in its dereferenced form
    const meta = metaOf(cacheFs);
    const legacyText = JSON.stringify(dereference(JSON.parse(text) as Record<string, unknown>));
    const legacyHash = hashContent(legacyText);
    const objectKey = [...cacheFs.files.keys()].find((key) =>
      key.includes(meta.acceptedContentHash),
    )!;
    cacheFs.files.delete(objectKey);
    cacheFs.files.set(objectKey.replace(meta.acceptedContentHash, legacyHash), legacyText);
    cacheFs.files.set(
      metaPathOf(cacheFs),
      JSON.stringify({ ...meta, schemaVersion: 1, acceptedContentHash: legacyHash }),
    );
    // Inside the TTL: a current-format entry would be served without a fetch
    const migrated = await runSpecPipeline(
      specUrl,
      { ...opts, nowMs: 60_000 },
      {
        ...fileDeps,
        fetcher,
        cacheFs,
      },
    );
    expect(migrated.cacheStatus).toBe('revalidated');
    expect(seen).toEqual([null, null]);
    expect(metaOf(cacheFs).schemaVersion).toBe(CACHE_META_SCHEMA_VERSION);
    // Now current: the next start inside the TTL is a plain cache hit
    const hit = await runSpecPipeline(
      specUrl,
      { ...opts, nowMs: 120_000 },
      {
        ...fileDeps,
        fetcher,
        cacheFs,
      },
    );
    expect(hit.cacheStatus).toBe('fresh');
    expect(seen).toHaveLength(2);
  });

  it('serves a version 1 cache entry as the last known good baseline when the migration fetch fails', async () => {
    const cacheFs = memoryCacheFs();
    const text = remoteSpec('Remote');
    const opts = { ...baseOpts, cacheRoot: '/cache', ...allowAll };
    await runSpecPipeline(specUrl, opts, { ...textDeps(text), cacheFs });
    cacheFs.files.set(
      metaPathOf(cacheFs),
      JSON.stringify({ ...metaOf(cacheFs), schemaVersion: 1 }),
    );
    const down = {
      ...fileDeps,
      cacheFs,
      fetcher: (() =>
        Promise.resolve(new Response('down', { status: 503 }))) as unknown as SpecFetcher,
    };
    const stale = await runSpecPipeline(specUrl, { ...opts, nowMs: 60_000 }, down);
    expect(stale.cacheStatus).toBe('stale');
    expect(stale.namedOperations.map((named) => named.toolName)).toEqual(['listThings']);
  });
});

describe('runSpecPipeline — wide containers (issue kaisers-io/openapi-mcp-archive#89 review)', () => {
  // 130,000 elements is far inside every spec budget, but well past V8's
  // argument-count limit for a variadic call such as push(...array)
  const WIDE = 130_000;
  const wideObject = (): Record<string, number> =>
    Object.fromEntries(Array.from({ length: WIDE }, (_, index) => [`k${index}`, 0]));
  const post = (schema: unknown): Record<string, unknown> => ({
    post: {
      operationId: 'create',
      requestBody: { content: { 'application/json': { schema } } },
      responses: { '200': { description: 'ok' } },
    },
  });
  const run = (document: Record<string, unknown>) =>
    runSpecPipeline(
      'https://api.example.com/wide.json',
      { ...baseOpts, ...allowAll },
      {
        ...fileDeps,
        fetcher: (() => Promise.resolve(Response.json(document))) as unknown as SpecFetcher,
      },
    );

  it('accepts a wide array and a wide object in an unrelated extension', async () => {
    const result = await run({
      openapi: '3.1.0',
      info: { title: 'wide', version: '1' },
      'x-wide': Array.from({ length: WIDE }, () => 0),
      'x-wide-object': wideObject(),
      paths: { '/things': post({ type: 'object' }) },
    });
    expect(result.namedOperations.map((named) => named.toolName)).toEqual(['create']);
  });

  it('accepts a wide container inside a $ref target an exposed operation uses', async () => {
    const result = await run({
      openapi: '3.1.0',
      info: { title: 'wide', version: '1' },
      paths: { '/things': post({ $ref: '#/components/schemas/Thing' }) },
      components: {
        schemas: {
          Thing: {
            type: 'object',
            properties: { next: { $ref: '#/components/schemas/Thing' } },
            'x-wide': Array.from({ length: WIDE }, () => 0),
            'x-wide-object': wideObject(),
          },
        },
      },
    });
    expect(result.namedOperations.map((named) => named.toolName)).toEqual(['create']);
  });
});

describe('runSpecPipeline — densely cyclic models (issue kaisers-io/openapi-mcp-archive#89)', () => {
  it('serves a spec whose cyclic models used to exhaust the node budget, failing closed per schema', async () => {
    // Ten mutually referencing schemas, like a SaaS model where customer,
    // subscription and invoice all expand each other
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 10; index += 1) {
      const properties: Record<string, unknown> = { id: { type: 'string' } };
      for (let other = 0; other < 10; other += 1) {
        properties[`to${other}`] = { $ref: `#/components/schemas/S${other}` };
      }
      schemas[`S${index}`] = { type: 'object', properties };
    }
    const text = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'cyclic', version: '1' },
      paths: {
        '/cyclic': {
          get: {
            operationId: 'getCyclic',
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
              },
            },
          },
        },
        '/plain': {
          get: {
            operationId: 'getPlain',
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
      components: { schemas },
    });
    const result = await runSpecPipeline('https://api.example.com/cyclic.json', baseOpts, {
      ...fileDeps,
      fetcher: (() => Promise.resolve(new Response(text))) as unknown as SpecFetcher,
    });
    const built = buildTools(result.namedOperations, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    // The cyclic response cannot be represented, so that tool has no output
    // schema — the same verdict a full expansion reaches; the plain one does
    const byName = new Map(built.tools.map((tool) => [tool.toolName, tool]));
    expect(byName.get('getCyclic')?.outputSchema).toBeUndefined();
    expect(byName.get('getPlain')?.outputSchema).toBeDefined();
  });
});

describe('runSpecPipeline — collapseCycles differential (issue kaisers-io/openapi-mcp-archive#89 review)', () => {
  // Mulberry32: a tiny seeded PRNG so a failure names a reproducible seed
  const prng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d_2b_79_f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  // A random schema graph: `size` component schemas whose properties, array
  // items and allOf members reference each other at random (self, mutual and
  // pass-through cycles, shared acyclic targets), used by request bodies,
  // responses and parameters of a few operations
  const randomSpec = (seed: number): string => {
    const random = prng(seed);
    const pick = (count: number): number => Math.floor(random() * count);
    const size = 2 + pick(5);
    const ref = (): Record<string, string> => ({ $ref: `#/components/schemas/S${pick(size)}` });
    const leaves = [{ type: 'string' }, { type: 'integer', minimum: 0 }, { type: 'boolean' }];
    const member = (): Record<string, unknown> => {
      const roll = random();
      if (roll < 0.35) {
        return ref();
      }
      if (roll < 0.5) {
        return { type: 'array', items: ref() };
      }
      return leaves[pick(leaves.length)] ?? { type: 'string' };
    };
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < size; index += 1) {
      const roll = random();
      if (roll < 0.15) {
        // A bare indirection: pass-through cycles and chains
        schemas[`S${index}`] = ref();
      } else if (roll < 0.3) {
        schemas[`S${index}`] = { allOf: [member(), { type: 'object' }] };
      } else {
        const properties: Record<string, unknown> = {};
        const count = 1 + pick(3);
        for (let property = 0; property < count; property += 1) {
          properties[`p${property}`] = member();
        }
        schemas[`S${index}`] = { type: 'object', properties };
      }
    }
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 4; index += 1) {
      const body = member();
      paths[`/r${index}`] = {
        post: {
          operationId: `op${index}`,
          parameters: random() < 0.3 ? [{ name: 'q', in: 'query', schema: member() }] : [],
          requestBody: { content: { 'application/json': { schema: body } } },
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: member() } } },
          },
        },
      };
    }
    return JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'random', version: '1' },
      paths,
      components: { schemas },
    });
  };

  it('exposes exactly the tools a full expansion exposes, over random cyclic graphs', async () => {
    const opts = { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' as const };
    const wire = (built: ReturnType<typeof buildTools>): string =>
      JSON.stringify(
        built.tools.map((tool) => [tool.toolName, tool.wireSchema, tool.outputSchema]),
      );
    const omittedOps = (built: ReturnType<typeof buildTools>): string[] =>
      built.omitted.map((entry) => `${entry.method} ${entry.path}`);
    let compared = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const text = randomSpec(seed);
      const validated = validateOpenApiDocument(parseSpecText(text));
      let reference: ReturnType<typeof buildTools> | undefined;
      try {
        const full = normalizeSpec(dereference(validated.document), validated.version);
        reference = buildTools(assignToolNames(full.operations), opts);
      } catch {
        // A graph whose full expansion exceeds a budget has no reference
        reference = undefined;
      }
      if (reference !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: one seed at a time
        const result = await runSpecPipeline(
          'https://api.example.com/random.json',
          { ...baseOpts, ...allowAll },
          {
            ...fileDeps,
            fetcher: (() => Promise.resolve(new Response(text))) as unknown as SpecFetcher,
          },
        );
        const collapsed = buildTools(result.namedOperations, opts);
        expect(wire(collapsed), `seed ${seed}`).toBe(wire(reference));
        expect(omittedOps(collapsed), `seed ${seed}`).toEqual(omittedOps(reference));
        compared += 1;
      }
    }
    // Most graphs must actually be compared, not skipped
    expect(compared).toBeGreaterThan(250);
  });
});

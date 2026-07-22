import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HTTP_METHODS,
  hashContent,
  parseFilterPattern,
  runSpecPipeline,
  type CacheFs,
  type CacheMeta,
} from '../src/index.ts';

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
  fetcher: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch,
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

// Matches every operation: restores the pre-filter inventory for the M2a assertions.
// Task-9 finding (round 9): a bare "**" alone is NOT enough — it compiles to an
// `operationId`-kind pattern, and filter-engine.test.ts's own contract ("never
// matches an operationId pattern against an operation without one") means it
// skips petstore-3.0.json's GET /pets/{petId}, which has neither an
// operationId nor a tag. A methodPath pattern matches on method and path alone,
// independent of operationId or tags, so one per exposable method truly
// restores the full inventory regardless of fixture.
const allowAll = {
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`)),
};

const suffix = (method: string, path: string): string =>
  createHash('sha256').update(`${method} ${path}`).digest('hex').slice(0, 8);

describe('runSpecPipeline — file sources', () => {
  it('runs the 3.0 JSON fixture end-to-end', async () => {
    const result = await runSpecPipeline(fixture('petstore-3.0.json'), baseOpts, fileDeps);
    expect(result.spec.title).toBe('Petstore');
    expect(result.spec.openapiVersion).toBe('3.0');
    expect(result.spec.omitted).toEqual([]);
    // The read-only default (spec §3.2 rule 3) drops the POST unless allowed
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
      { method: 'TRACE', path: '/admin', reason: 'TRACE operations are never exposed in v1' },
      {
        method: 'GET',
        path: '/admin',
        reason: 'per-operation servers overrides are not supported',
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
    fetcher: (() => Promise.resolve(new Response(text))) as typeof fetch,
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
    // Benign query strings are allowed but dropped from the display source (§5.3)
    expect(result.displaySource).toBe('https://api.example.com/openapi.json');
  });

  it('rejects credential-bearing query parameters before any fetch (D8)', async () => {
    let fetched = false;
    const deps = {
      ...fileDeps,
      fetcher: (() => {
        fetched = true;
        return Promise.resolve(new Response('{}'));
      }) as typeof fetch,
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
      fetcher: (() => Promise.resolve(new Response('down', { status: 503 }))) as typeof fetch,
    };
    await expect(
      runSpecPipeline('https://api.example.com/spec.json', baseOpts, failing),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

interface MemoryCacheFs extends CacheFs {
  files: Map<string, string>;
  calls: string[];
}

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
  ): { fetcher: typeof fetch; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      fetcher: (() => {
        calls += 1;
        return Promise.resolve(new Response(text, { headers }));
      }) as typeof fetch,
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

  it('writes the accepted baseline on a first-ever fetch (trust-on-first-use)', async () => {
    const cacheFs = memoryCacheFs();
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    const result = await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    expect(result.cacheStatus).toBe('accepted-first');
    expect(result.warnings).toEqual([]);
    expect(calls()).toBe(1);
    const meta = metaOf(cacheFs);
    // D14: the source hash and the persisted-bytes hash are distinct values
    expect(meta.sourceContentHash).toBe(hashContent(remoteSpec('Remote')));
    expect(meta.acceptedContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(meta.candidate).toBeUndefined();
    // The redacted display source is what lands on disk (spec §5.3)
    expect(meta.displaySource).toBe(specUrl);
    expect(meta.title).toBe('Remote');
    // D16b: the discriminator is persisted, because a hit will not revalidate
    // to recover it
    expect(meta.openapiVersion).toBe('3.1');
    // D14: contentHash keeps its M2a meaning — the source hash of the bytes used
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

  it('refuses a metadata version that contradicts the accepted bytes (round-3 finding 7)', async () => {
    // The round-3 draft asserted the OPPOSITE of this — that the rewritten
    // metadata simply won — and called it evidence for D16(b). That was wrong:
    // the content hash protects the OBJECT, not meta.json, so anyone who can
    // edit metadata could force a 3.1 document to be normalized under 3.0
    // rules without breaking a single hash. The discriminator is verified
    // against the document's own "openapi" field, which is one field read, not
    // a revalidation.
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
    // fresh trust-on-first-use acceptance either (D5)
    expect(calls()).toBe(1);
  });

  it('still serves a hit without revalidating when metadata and bytes agree (D16b)', async () => {
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
    // No network, and no Ajv pass — the point D16(b) actually makes
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
    }) as typeof fetch;
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
    }) as typeof fetch;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const second = await runSpecPipeline(
      specUrl,
      { ...cachedOpts, nowMs: 3_600_001 },
      { ...fileDeps, fetcher, cacheFs },
    );
    // Spec §5.4: the changed spec waits as a candidate; the accepted baseline serves
    expect(second.cacheStatus).toBe('candidate');
    expect(second.namedOperations.map((named) => named.toolName)).toEqual(['listThings']);
    expect(second.warnings.join('\n')).toContain('cache promote');
    expect(second.candidateContentHash).toMatch(/^[0-9a-f]{64}$/u);
    const meta = metaOf(cacheFs);
    expect(meta.sourceContentHash).toBe(hashContent(remoteSpec('Remote')));
    expect(meta.candidate?.sourceContentHash).toBe(hashContent(remoteSpec('Remote', '/extra')));
  });

  it('still reports the candidate on a restart INSIDE the TTL (D16a2)', async () => {
    // The round-1 draft reported the candidate only on the run that created it.
    // A later start returned `fresh` with no candidate hash and no warning —
    // the candidate was on disk, gating the update, and invisible.
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(calls === 1 ? remoteSpec('Remote') : remoteSpec('Remote', '/extra')),
      );
    }) as typeof fetch;
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

  it('preserves and reports the candidate across a later 304 (D16a2)', async () => {
    // The round-1 draft ran writeAccepted on a 304, which rewrites the accepted
    // entry and CLEARS the candidate — silently discarding a candidate awaiting
    // promotion without ever approving it.
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
    }) as typeof fetch;
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
    }) as typeof fetch;
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

  it('replays the candidate validators on the next revalidation (D16a2)', async () => {
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
    }) as typeof fetch;
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

  it('reports the candidate on a stale result too (D16a2)', async () => {
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
    }) as typeof fetch;
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
    }) as typeof fetch;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    // Task-9 finding (round 9): the brief's own draft added `cacheKey: 'prod'`
    // ONLY on this second call. cacheNamespace binds the namespace to the key
    // whenever one is given, authenticated or not, so that alone points the
    // second run at an entirely different, still-empty namespace — the read
    // then misses, and the run reports `accepted-first` again rather than
    // exercising the update path this test is named for. Omitting it here
    // keeps both calls in the same namespace.
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

  it('serves the last known good baseline with a warning when a refresh fails (§5.4)', async () => {
    const cacheFs = memoryCacheFs();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(new Response(remoteSpec('Remote')))
        : Promise.resolve(new Response('down', { status: 503 }));
    }) as typeof fetch;
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
    }) as typeof fetch;
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
    const fetcher = (() => Promise.resolve(new Response('down', { status: 503 }))) as typeof fetch;
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

  it('fails closed on a corrupt accepted baseline instead of refetching (D5)', async () => {
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
    }) as typeof fetch;
    await runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs });
    const acceptedBefore = metaOf(cacheFs).acceptedContentHash;
    // An attacker who can write into the cache directory corrupts the anchor
    cacheFs.files.set(metaPathOf(cacheFs), '{"schemaVersion":1}');
    await expect(
      runSpecPipeline(specUrl, { ...cachedOpts, nowMs: 1000 }, { ...fileDeps, fetcher, cacheFs }),
    ).rejects.toMatchObject({ code: 'validation' });
    // Task-9 finding (round 9): `calls` here is the plain counter this test
    // increments itself, not the `() => number` countingFetcher() returns
    // elsewhere in this file — `calls()` throws TypeError before the assertion
    // is ever checked
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

  it('fails closed when the namespace cannot be prepared — never a bypass (D17)', async () => {
    // The round-1 draft treated this as a degraded mode and served the remote
    // document anyway. That is an authorization reset: with the namespace
    // unreachable, nothing consults the durable accepted baseline, so the run
    // behaves exactly like trust-on-first-use. An attacker who can make one
    // mkdir fail gets the rug pull §6.3 exists to prevent.
    const failing: CacheFs = {
      ...memoryCacheFs(),
      mkdirSecure: () => Promise.reject(new Error('EACCES: permission denied')),
    };
    const { fetcher, calls } = countingFetcher(remoteSpec('Remote'));
    await expect(
      runSpecPipeline(specUrl, cachedOpts, { ...fileDeps, fetcher, cacheFs: failing }),
    ).rejects.toMatchObject({
      // Round-3 finding 3: the DECLARED exit code, not merely "it rejects".
      // The round-3 draft let a raw fs error through, which exits 1; asserting
      // only rejection is what let that pass unnoticed.
      code: 'validation',
      exitCode: 3,
    });
    // The load-bearing assertion: no fetch was issued and no document served
    expect(calls()).toBe(0);
  });

  it('fails closed when the entry cannot be read, rather than treating it as absent (D17)', async () => {
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

  it('propagates a non-absence error from pathExists instead of reporting a miss (D17)', async () => {
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

  it('bypasses ONLY through an explicit D13 policy branch', async () => {
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

  it('re-reads a file source on every run and reports fresh when unchanged (§5.4)', async () => {
    const cacheFs = memoryCacheFs();
    const opts = { ...cachedOpts, cwd: fixturesDir };
    const first = await runSpecPipeline('petstore-3.0.json', opts, { ...fileDeps, cacheFs });
    expect(first.cacheStatus).toBe('accepted-first');
    const second = await runSpecPipeline(
      'petstore-3.0.json',
      { ...opts, nowMs: 999_999_999 },
      { ...fileDeps, cacheFs },
    );
    // Spec §5.4 rule 2: file specs are re-read and hash-compared on every tick,
    // so the TTL never short-circuits them — an unchanged file still reports fresh
    expect(second.cacheStatus).toBe('revalidated');
  });

  it('bypasses persistence entirely for an authenticated source under --trust-spec-updates (D13)', async () => {
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

  it('persists an authenticated source when --cache-key separates it (D13)', async () => {
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
    // No secret material derived the namespace or reached the disk (§5.3)
    expect([...cacheFs.files.values()].join('\n')).not.toContain('Bearer x');
  });

  it('rejects an authenticated source with no cache decision (spec §5.3, D13)', async () => {
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

  it('enforces the tool-count budget on the unfiltered inventory', async () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 513; index += 1) {
      paths[`/p${index}`] = { post: { responses: { '200': { description: 'ok' } } } };
    }
    const big = JSON.stringify({ openapi: '3.1.0', info: { title: 'Big', version: '1' }, paths });
    const deps = {
      ...fileDeps,
      fetcher: (() => Promise.resolve(new Response(big))) as typeof fetch,
    };
    // Every operation is a POST the read-only default would drop: the budget
    // still fires, because filters must never smuggle an oversized spec past §4.1
    await expect(
      runSpecPipeline('https://api.example.com/big.json', baseOpts, deps),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

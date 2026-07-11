import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashContent, runSpecPipeline } from '../src/index.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

const fileDeps = {
  readFileText: (path: string) => readFile(path, 'utf8'),
  fileSizeBytes: async (path: string) => {
    const stats = await stat(path);
    return stats.size;
  },
  fetcher: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch,
  lookup: (): Promise<readonly string[]> => Promise.reject(new Error('no dns in this test')),
};

const baseOpts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
};

const suffix = (method: string, path: string): string =>
  createHash('sha256').update(`${method} ${path}`).digest('hex').slice(0, 8);

describe('runSpecPipeline — file sources', () => {
  it('runs the 3.0 JSON fixture end-to-end', async () => {
    const result = await runSpecPipeline(fixture('petstore-3.0.json'), baseOpts, fileDeps);
    expect(result.spec.title).toBe('Petstore');
    expect(result.spec.openapiVersion).toBe('3.0');
    expect(result.spec.omitted).toEqual([]);
    expect(result.namedOperations.map((named) => named.toolName)).toEqual([
      'listPets',
      'createPet',
      'get_pets_by_petid',
    ]);
    // The $ref parameter was dereferenced into a concrete parameter object
    const listPets = result.namedOperations[0]?.operation;
    expect(listPets?.parameters[0]?.['name']).toBe('limit');
    // Path-level parameters were merged into the operation
    const byId = result.namedOperations[2]?.operation;
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
    const result = await runSpecPipeline(fixture('petstore-3.1.yaml'), baseOpts, fileDeps);
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
      baseOpts,
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

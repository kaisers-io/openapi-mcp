import { sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  CACHE_META_SCHEMA_VERSION,
  HTTP_METHODS,
  LEGACY_CACHE_META_SCHEMA_VERSION,
  parseFilterPattern,
  runSpecPipeline,
  SPEC_BUDGETS,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { SpecPipelineDeps, SpecPipelineOptions, SpecPipelineResult } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// #76: a start whose source bytes are identical to the accepted ones reuses
// the accepted document the run already read from the cache, instead of
// parsing and validating the source again. The counters show which runs did
// the work; everything else in the pipeline is the real implementation.
const counts = vi.hoisted(() => ({ parse: 0, validate: 0 }));

vi.mock(import('../src/spec/parse.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseSpecText: (...args: Parameters<typeof actual.parseSpecText>) => {
      counts.parse += 1;
      return actual.parseSpecText(...args);
    },
  };
});

vi.mock(import('../src/spec/validate.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateOpenApiDocument: (...args: Parameters<typeof actual.validateOpenApiDocument>) => {
      counts.validate += 1;
      return actual.validateOpenApiDocument(...args);
    },
  };
});

// YAML, with shared $ref components, a header parameter, a `default`
// response and JSON bodies: every input the tool-generation flags act on
const specYaml = (title = 'Things'): string => `openapi: 3.1.0
info:
  title: ${title}
  version: 1.0.0
servers:
  - url: https://api.example.com
paths:
  /things:
    get:
      operationId: listThings
      tags: [things]
      parameters:
        - name: X-Tenant
          in: header
          schema: { type: string }
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Thing' }
        default:
          description: error
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
    post:
      operationId: createThing
      tags: [things]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Thing' }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
  /things/{id}:
    delete:
      operationId: deleteThing
      tags: [admin]
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        default:
          description: done
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
components:
  parameters:
    Limit:
      name: limit
      in: query
      schema: { type: integer, minimum: 1 }
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id: { type: string }
        owner: { $ref: '#/components/schemas/Owner' }
    Owner:
      type: object
      properties:
        name: { type: string }
    Error:
      type: object
      properties:
        message: { type: string }
`;

const allowAll = HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`));

const baseOpts: SpecPipelineOptions = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/specs',
  allowPrivateNetwork: false,
  allow: allowAll,
  deny: [],
  ttlMs: 3_600_000,
  trustSpecUpdates: false,
  cacheRoot: '/cache',
  nowMs: 1000,
};

// The spec "file" is whatever `source.text` holds when the run reads it
const deps = (fs: MemoryCacheFs, source: { text: string }): SpecPipelineDeps => ({
  readFileText: () => Promise.resolve(source.text),
  fileSizeBytes: () => Promise.resolve(Buffer.byteLength(source.text)),
  fetcher: () => Promise.reject(new Error('no network in this test')),
  lookup: () => Promise.resolve(['93.184.216.34']),
  cacheFs: fs,
});

const run = (
  fs: MemoryCacheFs,
  source: { text: string },
  opts: Partial<SpecPipelineOptions> = {},
): Promise<SpecPipelineResult> =>
  runSpecPipeline('api.yaml', { ...baseOpts, ...opts }, deps(fs, source));

type ToolgenOptions = {
  reservedHeaders?: ReadonlySet<string>;
  projection?: boolean;
  defaultResponseIsError?: boolean;
  toolMode?: 'per-operation' | 'discover';
};

// What a client sees: the serialized tools/list of the snapshot built from a
// pipeline result, the way `serve` builds it
const toolsList = (result: SpecPipelineResult, toolgen: ToolgenOptions = {}): string => {
  const built = buildTools(result.namedOperations, {
    reservedHeaders: toolgen.reservedHeaders ?? SYSTEM_HEADERS,
    openapiVersion: result.spec.openapiVersion,
    projection: toolgen.projection === true,
    defaultResponseIsError: toolgen.defaultResponseIsError === true,
  });
  const snapshot = buildSnapshot(built, result, { toolMode: toolgen.toolMode ?? 'per-operation' });
  return JSON.stringify(snapshot.tools.map((tool) => tool.wireTool));
};

const metaPathOf = (fs: MemoryCacheFs): string => {
  const path = [...fs.files.keys()].find((key) => key.endsWith(`${sep}meta.json`));
  if (path === undefined) {
    throw new Error('no meta.json written');
  }
  return path;
};

// A primed cache: one accepted run under the default options
const primed = async (
  text = specYaml(),
): Promise<{ fs: MemoryCacheFs; source: { text: string } }> => {
  const fs = memoryCacheFs();
  const source = { text };
  const first = await run(fs, source);
  expect(first.cacheStatus).toBe('accepted-first');
  return { fs, source };
};

const resetCounts = (): void => {
  counts.parse = 0;
  counts.validate = 0;
};

describe('an unchanged source reuses the accepted document (#76)', () => {
  it('a second start of an unchanged YAML file neither parses nor validates it again', async () => {
    resetCounts();
    const { fs, source } = await primed();
    expect(counts).toStrictEqual({ parse: 1, validate: 1 });

    const second = await run(fs, source, { nowMs: 999_999_999 });
    expect(second.cacheStatus).toBe('revalidated');
    expect(counts).toStrictEqual({ parse: 1, validate: 1 });
  });

  it('serves exactly what a cold start serves', async () => {
    const { fs, source } = await primed();
    const warm = await run(fs, source);
    const cold = await run(memoryCacheFs(), source);
    expect(warm.namedOperations).toStrictEqual(cold.namedOperations);
    expect(warm.spec).toStrictEqual(cold.spec);
    expect(warm.contentHash).toBe(cold.contentHash);
    expect(warm.warnings).toStrictEqual(cold.warnings);
    expect(toolsList(warm)).toBe(toolsList(cold));
  });

  it('a URL answering 200 with identical bytes after the TTL is not parsed again either', async () => {
    const fs = memoryCacheFs();
    const fetcher = (() =>
      Promise.resolve(new Response(specYaml()))) as unknown as SpecPipelineDeps['fetcher'];
    const urlRun = (nowMs: number): Promise<SpecPipelineResult> =>
      runSpecPipeline(
        'https://api.example.com/openapi.yaml',
        { ...baseOpts, nowMs },
        { ...deps(fs, { text: '' }), fetcher },
      );
    resetCounts();
    const first = await urlRun(1000);
    expect(first.cacheStatus).toBe('accepted-first');
    // Past the 1 h TTL: refetched, byte-identical
    const second = await urlRun(1000 + 7_200_000);
    expect(second.cacheStatus).toBe('revalidated');
    expect(counts).toStrictEqual({ parse: 1, validate: 1 });
  });

  it('a single changed byte is parsed and validated again', async () => {
    const { fs, source } = await primed();
    resetCounts();
    source.text = specYaml('Thingz');
    const changed = await run(fs, source);
    expect(counts).toStrictEqual({ parse: 1, validate: 1 });
    // The usual gate: the change waits as a candidate, the baseline serves
    expect(changed.cacheStatus).toBe('candidate');
  });

  it('with --trust-spec-updates a changed file is served from its own bytes', async () => {
    const { fs, source } = await primed();
    source.text = specYaml('Thingz');
    const changed = await run(fs, source, { trustSpecUpdates: true });
    expect(changed.cacheStatus).toBe('accepted-update');
    expect(changed.spec.title).toBe('Thingz');
  });

  it('an entry written by other processing is processed again and migrated', async () => {
    const { fs, source } = await primed();
    const metaPath = metaPathOf(fs);
    const meta = JSON.parse(fs.files.get(metaPath)!) as Record<string, unknown>;
    fs.files.set(
      metaPath,
      JSON.stringify({ ...meta, schemaVersion: LEGACY_CACHE_META_SCHEMA_VERSION }),
    );
    resetCounts();
    await run(fs, source);
    expect(counts).toStrictEqual({ parse: 1, validate: 1 });
    const rewritten = JSON.parse(fs.files.get(metaPath)!) as Record<string, unknown>;
    expect(rewritten['schemaVersion']).toBe(CACHE_META_SCHEMA_VERSION);
  });

  it('a damaged accepted object still fails closed instead of being reused', async () => {
    const { fs, source } = await primed();
    const objectKey = [...fs.files.keys()].find((key) => key.includes(`${sep}objects${sep}`))!;
    fs.files.set(objectKey, fs.files.get(objectKey)!.replace('Things', 'Thingz'));
    await expect(run(fs, source)).rejects.toThrow(/does not match its recorded content hash/u);
  });

  // Every option that changes what the tools are. The cache is primed under
  // the defaults; each variant must then produce on the warm path exactly
  // what a cold start under that variant produces — never the primed set.
  const variants: readonly {
    name: string;
    pipeline?: Partial<SpecPipelineOptions>;
    toolgen?: ToolgenOptions;
    check: (tools: string) => void;
  }[] = [
    {
      name: '--allow narrower than the primed run',
      pipeline: { allow: [parseFilterPattern('tag:things')] },
      check: (tools) => expect(tools).not.toContain('deleteThing'),
    },
    {
      name: '--deny',
      pipeline: { deny: [parseFilterPattern('DELETE /**')] },
      check: (tools) => expect(tools).not.toContain('deleteThing'),
    },
    {
      // The primed run allowed every method; the default must not inherit it
      name: 'no --allow (the read-only default: GET only)',
      pipeline: { allow: [] },
      check: (tools) => {
        expect(tools).toContain('listThings');
        expect(tools).not.toContain('createThing');
        expect(tools).not.toContain('deleteThing');
      },
    },
    {
      name: 'a reserved (operator-configured) header',
      toolgen: { reservedHeaders: new Set([...SYSTEM_HEADERS, 'x-tenant']) },
      check: (tools) => expect(tools).not.toContain('X-Tenant'),
    },
    {
      name: '--response-projection',
      toolgen: { projection: true },
      check: (tools) => expect(tools).toContain('_fields'),
    },
    {
      name: '--default-response-is-error',
      toolgen: { defaultResponseIsError: true },
      check: (tools) => expect(tools).toContain('outputSchema'),
    },
    {
      name: '--tool-mode discover',
      toolgen: { toolMode: 'discover' },
      check: (tools) => expect(tools).toContain('call_operation'),
    },
  ];

  it.each(variants)('$name: the warm start matches a cold one', async (variant) => {
    const { fs, source } = await primed();
    const primedTools = toolsList(await run(fs, source));
    const warm = await run(fs, source, variant.pipeline);
    const cold = await run(memoryCacheFs(), source, variant.pipeline);
    expect(warm.namedOperations).toStrictEqual(cold.namedOperations);
    expect(warm.deadPatterns).toStrictEqual(cold.deadPatterns);
    const warmTools = toolsList(warm, variant.toolgen);
    expect(warmTools).toBe(toolsList(cold, variant.toolgen));
    expect(warmTools).not.toBe(primedTools);
    variant.check(warmTools);
  });

  it('the tool budget is enforced on the warm path too', async () => {
    const { fs, source } = await primed();
    const opts = { maxToolCount: 2 };
    await expect(run(memoryCacheFs(), source, opts)).rejects.toThrow(/3 tools would be exposed/u);
    await expect(run(fs, source, opts)).rejects.toThrow(/3 tools would be exposed/u);
    expect(SPEC_BUDGETS.maxToolCount).toBeGreaterThan(2);
  });
});

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import type { BuildToolsResult, SpecPipelineResult } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { exposureReport, OVERLAP_WARNING_MAX } from '../src/exposure-report.ts';
import { run } from '../src/main.ts';

// Issue #41: every operation of the spec is either a tool or reported with
// its reason, and an exposed tool that overlaps an excluded path is named at
// startup. An invented shop API (fixtures/shop-not-exposed.json).

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

const runTools = async (
  args: readonly string[],
): Promise<{ code: number; lines: string[]; errLines: string[] }> => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const ctx = testContext({
    lines,
    errLines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => fixturesDir,
  });
  const code = await run(ctx, ['node', 'openapi-mcp', ...args]);
  return { code, lines, errLines };
};

const SPEC = ['--spec', 'shop-not-exposed.json'];
const FILTERS = ['--allow', 'tag:Orders', '--allow', 'tag:Reports', '--deny', 'route:DELETE /**'];

type Envelope = {
  data: {
    notExposed: { method: string; path: string; decision: string; reason: string }[];
    omitted: Record<string, unknown>[];
    overlaps: { exposed: string; excluded: string }[];
    overlapCheckComplete: boolean;
  };
};

describe('tools — operations that are not exposed (issue #41)', () => {
  it('lists every one with its reason in --json, and keeps omitted as it was', async () => {
    const { code, lines } = await runTools(['--json', 'tools', ...SPEC, ...FILTERS]);
    expect(code).toBe(EXIT.OK);
    const { data } = JSON.parse(lines[0]!) as Envelope;
    expect(
      data.notExposed.map(
        (operation) => `${operation.method} ${operation.path}: ${operation.reason}`,
      ),
    ).toEqual([
      'GET /orders/{orderId}/{section}: matched by no --allow pattern',
      'DELETE /orders/{orderId}: excluded by --deny "route:DELETE /**"',
      'GET /customers: cookie parameters are not supported',
      'SEARCH /search: path-level servers overrides are not supported',
    ]);
    // The internal provenance is not part of an omission
    expect(data.omitted).toEqual([
      { method: 'GET', path: '/customers', reason: 'cookie parameters are not supported' },
      {
        method: 'SEARCH',
        path: '/search',
        reason: 'path-level servers overrides are not supported',
      },
    ]);
    expect(data.overlaps).toEqual([
      { exposed: 'GET /orders/{orderId}/items', excluded: 'GET /orders/{orderId}/{section}' },
    ]);
    expect(data.overlapCheckComplete).toBe(true);
  });

  it('prints one summary line and names the overlap', async () => {
    const { code, errLines } = await runTools(['tools', ...SPEC, ...FILTERS]);
    expect(code).toBe(EXIT.OK);
    const warnings = errLines.join('\n');
    expect(warnings).toContain(
      'operations not exposed: 1 excluded by --deny, 1 matched by no --allow, 2 omitted as not supported; every one with its reason: openapi-mcp --json tools with the same options',
    );
    expect(warnings).toContain(
      'tool listOrderItems (GET /orders/{orderId}/items): a request that also matches GET /orders/{orderId}/{section}, which is not exposed, is refused; review --allow, --deny and the spec',
    );
  });

  it('stops under --strict-filters when a tool overlaps an excluded path', async () => {
    const { code, errLines } = await runTools(['tools', ...SPEC, ...FILTERS, '--strict-filters']);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('tool listOrderItems (GET /orders/{orderId}/items)');
    // Excluding both resolves it
    const both = await runTools([
      'tools',
      ...SPEC,
      ...FILTERS,
      '--deny',
      'operationId:listOrderItems',
      '--strict-filters',
    ]);
    expect(both.code).toBe(EXIT.OK);
  });

  it('names an omitted operation as such instead of suggesting another one', async () => {
    const { code, errLines } = await runTools([
      'tools',
      ...SPEC,
      '--allow',
      'operationId:listCustomers',
      '--deny',
      'route:SEARCH /search',
    ]);
    expect(code).toBe(EXIT.OK);
    const warnings = errLines.join('\n');
    expect(warnings).toContain(
      '--allow "operationId:listCustomers" matches no operation; it names only operations that are omitted as not supported',
    );
    // SEARCH is declared, by an operation that is omitted: no usage error
    expect(warnings).toContain(
      '--deny "route:SEARCH /search" matches no operation; it names only operations that are omitted as not supported',
    );
  });
});

describe('exposureReport — bounds', () => {
  const ok = { '200': { description: 'ok' } };
  const param = (name: string) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  });
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 25; index += 1) {
    paths[`/r${String(index)}/{id}/items`] = {
      get: { operationId: `items${String(index)}`, parameters: [param('id')], responses: ok },
    };
    paths[`/r${String(index)}/{id}/{part}`] = {
      get: {
        operationId: `part${String(index)}`,
        parameters: [param('id'), param('part')],
        responses: ok,
      },
    };
  }

  // Review of #44: a version prefix shared by every path completes the check
  it('passes --strict-filters for a large catalog under one version prefix', async () => {
    const catalog: Record<string, unknown> = {};
    for (let index = 0; index < 1024; index += 1) {
      catalog[`/v1/resources${String(index)}/{id}`] = {
        get: {
          operationId: `getResource${String(index)}`,
          tags: [index % 2 === 0 ? 'public' : 'internal'],
          parameters: [param('id')],
          responses: ok,
        },
      };
    }
    const dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-catalog-'));
    const spec = join(dir, 'catalog.json');
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Catalog', version: '1' },
        paths: catalog,
      }),
    );
    try {
      const { code, lines } = await runTools([
        '--json',
        'tools',
        '--spec',
        spec,
        '--deny',
        'tag:internal',
        '--strict-filters',
      ]);
      expect(code).toBe(EXIT.OK);
      const { data } = JSON.parse(lines[0]!) as Envelope & { data: { toolCount: number } };
      expect(data.toolCount).toBe(512);
      expect(data.overlapCheckComplete).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names at most 20 overlaps and counts the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-overlaps-'));
    const spec = join(dir, 'many.json');
    await writeFile(
      spec,
      JSON.stringify({ openapi: '3.1.0', info: { title: 'Shop', version: '1' }, paths }),
    );
    try {
      const { code, errLines } = await runTools([
        'tools',
        '--spec',
        spec,
        '--deny',
        'operationId:part*',
      ]);
      expect(code).toBe(EXIT.OK);
      const overlapLines = errLines.filter((line) => line.includes('which is not exposed'));
      expect(overlapLines).toHaveLength(OVERLAP_WARNING_MAX);
      expect(errLines.join('\n')).toContain('and 5 more such overlaps, all listed by --json tools');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Review of #41: an incomplete check cannot show that there is no overlap
describe('exposureReport — an incomplete overlap check', () => {
  const operation = (method: string, path: string) => ({
    method,
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: {},
  });
  const result = {
    spec: {
      operations: [operation('get', '/{p}'), operation('get', '/{y}')],
      omitted: [],
    },
    withheldOperations: [],
    filteredOut: [],
  } as unknown as SpecPipelineResult;
  const built = {
    tools: [{ operation: operation('get', '/{p}'), toolName: 'get_p' }],
    omitted: [],
  } as unknown as BuildToolsResult;

  it('warns, and fails under --strict-filters', () => {
    const report = exposureReport(result, built, false, 0);
    expect(report.overlapCheckComplete).toBe(false);
    expect(report.warnings).toContain(
      'the check for overlapping paths ran out of its work budget, so the list is incomplete',
    );
    expect(() => exposureReport(result, built, true, 0)).toThrow('ran out of its work budget');
  });
});

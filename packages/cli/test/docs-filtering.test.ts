import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT, parseFilterPattern } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// Issue #42: docs/filtering.md shows what each configuration does. Its
// examples run here against the same invented shop API
// (fixtures/shop-filtering.json), so the document cannot drift from the code.

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
const GUIDE = readFileSync(
  fileURLToPath(new URL('../../../docs/filtering.md', import.meta.url)),
  'utf8',
);

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

const toolsFor = async (filters: readonly string[]): Promise<string[]> => {
  const { code, lines } = await runTools([
    '--json',
    'tools',
    '--spec',
    'shop-filtering.json',
    ...filters,
  ]);
  expect(code).toBe(EXIT.OK);
  const { data } = JSON.parse(lines[0]!) as { data: { tools: { name: string }[] } };
  return data.tools.map((tool) => tool.name);
};

const READS = [
  'listOrders',
  'getOrder',
  'listOrderItems',
  'getOrderSection',
  'listCustomers',
  'get_reports',
];
const ORDERS = [
  'listOrders',
  'createOrder',
  'getOrder',
  'deleteOrder',
  'cancelOrder',
  'listOrderItems',
  'getOrderSection',
];
const WITH_ID = [...ORDERS, 'listCustomers', 'removeCustomer', 'customerDelete'];

describe('docs/filtering.md', () => {
  it('parses every pattern it shows, and rejects the earlier syntax with the replacement', () => {
    const shown = [...GUIDE.matchAll(/--(?:allow|deny) "(?<pattern>[^"]+)"/gu)].map(
      (match) => match.groups?.['pattern'] ?? '',
    );
    expect(shown.length).toBeGreaterThan(20);
    const earlier = new Map([
      ['DELETE /**', 'route:DELETE /**'],
      ['GET /orders/**', 'route:GET /orders/**'],
      ['**', 'path:/**'],
      ['read*', 'operationId:read*'],
    ]);
    for (const raw of shown) {
      const replacement = earlier.get(raw);
      if (replacement === undefined) {
        expect(() => parseFilterPattern(raw)).not.toThrow();
      } else {
        expect(() => parseFilterPattern(raw)).toThrow(replacement);
      }
    }
  });

  it('exposes the tools its example table names', async () => {
    expect(await toolsFor([])).toEqual(READS);
    expect(await toolsFor(['--allow', 'tag:Orders'])).toEqual(ORDERS);
    expect(await toolsFor(['--allow', 'tag:Orders', '--deny', 'method:delete'])).toEqual(
      ORDERS.filter((name) => name !== 'deleteOrder'),
    );
    expect(await toolsFor(['--allow', 'method:get', '--allow', 'operationId:createOrder'])).toEqual(
      ['listOrders', 'createOrder', ...READS.slice(1)],
    );
    expect(await toolsFor(['--allow', 'route:GET /orders/**'])).toEqual([
      'getOrder',
      'listOrderItems',
      'getOrderSection',
    ]);
    expect(await toolsFor(['--allow', 'operationId:*'])).toEqual(WITH_ID);
    expect(await toolsFor(['--allow', 'path:/**'])).toEqual([...WITH_ID, 'get_reports']);
  });

  it('never deletes with the three-pattern recipe, except what no pattern can tell', async () => {
    const tools = await toolsFor([
      '--allow',
      'path:/**',
      '--deny',
      'method:delete',
      '--deny',
      'path:**delete**',
      '--deny',
      'operationId:*delete*',
    ]);
    expect(tools).not.toContain('deleteOrder');
    expect(tools).not.toContain('removeCustomer');
    expect(tools).not.toContain('customerDelete');
    expect(tools).toContain('cancelOrder');
  });

  it('shows the overlap line startup prints, and the overlaps of its table', async () => {
    const { code, lines } = await runTools([
      '--json',
      'tools',
      '--spec',
      'shop-filtering.json',
      '--allow',
      'route:GET /orders/*/items',
    ]);
    expect(code).toBe(EXIT.OK);
    const { data, warnings } = JSON.parse(lines[0]!) as {
      data: { overlaps: unknown[] };
      warnings: string[];
    };
    const line = warnings.find((entry) => entry.startsWith('tool listOrderItems'));
    expect(line).toBeDefined();
    expect(GUIDE).toContain(line);
    expect(data.overlaps).toHaveLength(1);
    const both = await runTools([
      '--json',
      'tools',
      '--spec',
      'shop-filtering.json',
      '--allow',
      'route:GET /orders/**',
      '--deny',
      'operationId:getOrderSection',
      '--deny',
      'operationId:listOrderItems',
      '--strict-filters',
    ]);
    expect(both.code).toBe(EXIT.OK);
  });

  it('shows the case-collision line startup prints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-filtering-'));
    const spec = join(dir, 'case.json');
    const ok = { '200': { description: 'ok' } };
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Shop', version: '1' },
        paths: {
          '/orders/export': { get: { operationId: 'exportOrders', responses: ok } },
          '/Orders/export': { get: { operationId: 'exportOrdersLegacy', responses: ok } },
        },
      }),
    );
    try {
      const { code, errLines } = await runTools([
        'tools',
        '--spec',
        spec,
        '--allow',
        'path:/orders/**',
      ]);
      expect(code).toBe(EXIT.OK);
      const line = errLines
        .map((entry) => entry.replace(/^openapi-mcp: warning: /u, ''))
        .find((entry) => entry.includes('differ only by case'));
      expect(line).toBeDefined();
      expect(GUIDE).toContain(line);
      const strict = await runTools([
        'tools',
        '--spec',
        spec,
        '--allow',
        'path:/orders/**',
        '--strict-filters',
      ]);
      expect(strict.code).toBe(EXIT.VALIDATION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

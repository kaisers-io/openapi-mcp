import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './cli-subprocess.ts';
import { startUpstream, withServe } from './filter-harness.ts';
import type { McpSession, Upstream } from './filter-harness.ts';
import { SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #68 end to end: the real CLI over MCP stdio, in both tool modes,
// against an upstream that records every request. A HEAD request reaches the
// GET on the same path, so a HEAD whose GET is not a tool is refused on every
// call and must not be offered. Every expectation is written by hand from the
// spec below, never computed with the server's code. For each configuration:
// exactly the expected tools are offered and every one of them reaches the
// upstream (nothing is refused wrongly); every other operation is refused by
// name and the upstream never sees it (nothing is allowed wrongly).

const ok = { '200': { description: 'ok' } };
const param = (name: string, where = 'path') => ({
  name,
  in: where,
  required: where === 'path',
  schema: { type: 'string' },
});
const op = (operationId: string, parameters: readonly object[] = []) => ({
  operationId,
  parameters,
  responses: ok,
});

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Heads', version: '1' },
  paths: {
    // The same template
    '/orders/{orderId}': {
      get: op('getOrder', [param('orderId')]),
      head: op('headOrder', [param('orderId')]),
    },
    // The same template with another placeholder name and letter case
    '/items/{itemId}': { get: op('getItem', [param('itemId')]) },
    '/Items/{id}': { head: op('headItem', [param('id')]) },
    // A GET that is omitted while its tool is built (a deepObject array)
    '/search': {
      get: op('search', [
        {
          name: 'expand',
          in: 'query',
          style: 'deepObject',
          explode: true,
          schema: { type: 'array', items: { type: 'string' } },
        },
      ]),
      head: op('headSearch'),
    },
    // A concrete HEAD under a templated GET
    '/files/{name}': { get: op('getFile', [param('name')]) },
    '/files/latest': { head: op('headLatest') },
    // A concrete HEAD whose concrete GET wins over the template
    '/docs/{docId}': { get: op('getDoc', [param('docId')]) },
    '/docs/index': { get: op('getDocIndex'), head: op('headDocIndex') },
    // A templated HEAD that a concrete GET only overlaps: one URL refused
    '/reports/{reportId}': { head: op('headReport', [param('reportId')]) },
    '/reports/summary': { get: op('getSummary') },
    // A HEAD with its GET
    '/pets': { get: op('listPets'), head: op('headPets') },
  },
};

// Every operation that can be a tool, with its arguments and the request
// its call must send
const CALLS: Readonly<Record<string, { args: Record<string, string>; request: string }>> = {
  getOrder: { args: { orderId: 'o-1' }, request: 'GET /orders/o-1' },
  headOrder: { args: { orderId: 'o-1' }, request: 'HEAD /orders/o-1' },
  getItem: { args: { itemId: 'i-1' }, request: 'GET /items/i-1' },
  headItem: { args: { id: 'i-1' }, request: 'HEAD /Items/i-1' },
  headSearch: { args: {}, request: 'HEAD /search' },
  getFile: { args: { name: 'a.txt' }, request: 'GET /files/a.txt' },
  headLatest: { args: {}, request: 'HEAD /files/latest' },
  getDoc: { args: { docId: 'd-1' }, request: 'GET /docs/d-1' },
  getDocIndex: { args: {}, request: 'GET /docs/index' },
  headDocIndex: { args: {}, request: 'HEAD /docs/index' },
  headReport: { args: { reportId: 'r-1' }, request: 'HEAD /reports/r-1' },
  getSummary: { args: {}, request: 'GET /reports/summary' },
  listPets: { args: {}, request: 'GET /pets' },
  headPets: { args: {}, request: 'HEAD /pets' },
};
const ALL = Object.keys(CALLS);
const HEADS = ALL.filter((name) => name.startsWith('head'));
// Omitted as not supported in every configuration
const NEVER = ['search'];

const CASES: readonly {
  title: string;
  args: string[];
  expected: readonly string[];
  // The HEADs left out with the decision head-without-get
  leftOut: readonly string[];
}[] = [
  {
    title: 'the read-only default',
    args: [],
    expected: ALL.filter((name) => name !== 'headSearch'),
    leftOut: ['headSearch'],
  },
  {
    title: '--deny method:get leaves only the HEAD that a GET merely overlaps',
    args: ['--deny', 'method:get'],
    expected: ['headReport'],
    leftOut: HEADS.filter((name) => name !== 'headReport'),
  },
  {
    title: '--allow method:head, the same',
    args: ['--allow', 'method:head'],
    expected: ['headReport'],
    leftOut: HEADS.filter((name) => name !== 'headReport'),
  },
  {
    title: 'a denied GET template: its concrete HEAD goes, an exposed concrete GET keeps its HEAD',
    args: ['--deny', 'route:GET /files/{name}', '--deny', 'route:GET /docs/{docId}'],
    expected: ALL.filter(
      (name) => !['headSearch', 'getFile', 'headLatest', 'getDoc'].includes(name),
    ),
    leftOut: ['headSearch', 'headLatest'],
  },
  {
    title: 'one denied GET, the other placeholder name and letter case',
    args: ['--deny', 'operationId:getItem'],
    expected: ALL.filter((name) => !['headSearch', 'getItem', 'headItem'].includes(name)),
    leftOut: ['headSearch', 'headItem'],
  },
];

const without = (names: readonly string[], drop: readonly string[]) =>
  names.filter((name) => !drop.includes(name));

describe('serve — a HEAD whose GET is not a tool (issue #68)', () => {
  let home: string;
  let specPath: string;
  let upstream: Upstream;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp heads '));
    specPath = join(home, 'spec.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    upstream = await startUpstream();
  });

  afterAll(async () => {
    await upstream.close();
    rmSync(home, { recursive: true, force: true });
  });

  const options = (extra: readonly string[]) => [
    '--spec',
    specPath,
    '--base-url',
    upstream.url,
    '--allow-private-network',
    '--allow-insecure-http',
    '--rate-limit',
    '100000/1m',
    ...extra,
  ];
  const sent = () => upstream.requests.map(({ method, url }) => `${method} ${url}`).toSorted();
  const requestsOf = (names: readonly string[]) =>
    names.map((name) => CALLS[name]?.request ?? '').toSorted();

  const expectSent = async (session: McpSession, name: string, call: () => Promise<unknown>) => {
    const reply = await call();
    expect({ name, reply }).toMatchObject({ name, reply: { kind: 'result', isError: false } });
    expect(session.stderr()).not.toContain('panic');
  };

  it.each(CASES)('per-operation: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options(args), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual(['openapi_mcp_status', ...expected].toSorted());
      for (const name of [...without(ALL, expected), ...NEVER]) {
        const reply = await session.callTool(name, CALLS[name]?.args ?? {});
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'rpc-error' } });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        await expectSent(session, name, () => session.callTool(name, CALLS[name]?.args));
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  it.each(CASES)('discover: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options([...args, '--tool-mode', 'discover']), home, async (session) => {
      const search = await session.callTool('search_operations', { limit: 25, detail: 'names' });
      const found = JSON.stringify(search);
      const listed = [...ALL, ...NEVER].filter((name) => found.includes(`"${name}"`));
      expect(listed.toSorted()).toStrictEqual([...expected].toSorted());
      for (const name of [...without(ALL, expected), ...NEVER]) {
        const reply = await session.callTool('call_operation', {
          name,
          arguments: CALLS[name]?.args ?? {},
        });
        expect({ name, reply }).toMatchObject({
          name,
          reply: {
            kind: 'result',
            isError: true,
            text: expect.stringContaining('unknown operation'),
          },
        });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        await expectSent(session, name, () =>
          session.callTool('call_operation', { name, arguments: CALLS[name]?.args ?? {} }),
        );
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  it('refuses the one URL a merely overlapping GET covers, and only that one', async () => {
    upstream.requests.length = 0;
    await withServe(options(['--deny', 'method:get']), home, async (session) => {
      const refused = await session.callTool('headReport', { reportId: 'summary' });
      expect(refused).toMatchObject({ kind: 'result', isError: true });
      expect(upstream.requests).toStrictEqual([]);
      await expectSent(session, 'headReport', () =>
        session.callTool('headReport', { reportId: 'monthly' }),
      );
    });
    expect(sent()).toStrictEqual(['HEAD /reports/monthly']);
  });

  it.each(CASES)('tools --json lists the left-out HEADs: $title', ({ args, leftOut }) => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, '--json', 'tools', '--spec', specPath, ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: SUBPROCESS_WAIT_MS },
    );
    const data = (
      JSON.parse(result.stdout) as {
        data: {
          notExposed: { operationId?: string; decision: string }[];
          counts: { notExposed: Record<string, number> };
        };
      }
    ).data;
    const heads = data.notExposed
      .filter((row) => row.decision === 'head-without-get')
      .map((row) => row.operationId);
    expect(heads.toSorted()).toStrictEqual([...leftOut].toSorted());
    expect(data.counts.notExposed['head-without-get']).toBe(leftOut.length);
  });
});

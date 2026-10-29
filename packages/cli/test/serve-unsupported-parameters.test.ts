import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUpstream, withServe } from './filter-harness.ts';
import type { McpSession, Upstream } from './filter-harness.ts';

// Issue #67 end to end: the real CLI over MCP stdio, in both tool modes,
// against an upstream that records every request. With
// --omit-unsupported-parameters, an operation omitted only for optional
// parameters this server cannot send becomes a tool without them. Every
// expectation is written by hand from the spec below. For each
// configuration: exactly the expected tools are offered and each reaches the
// upstream with exactly the expected request (nothing refused wrongly);
// every other operation is refused by name, a left-out parameter is refused
// as an argument, and the upstream never sees either (nothing allowed wrongly).

const ok = { '200': { description: 'ok' } };
const expand = {
  name: 'expand',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: { type: 'array', items: { type: 'string' } },
};
const limit = { name: 'limit', in: 'query', schema: { type: 'integer' } };
// A header defined by `content`, which this server cannot send
const trace = {
  name: 'x-trace',
  in: 'header',
  content: { 'application/json': { schema: { type: 'object' } } },
};

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Unsupported parameters', version: '1' },
  paths: {
    '/items': {
      get: { operationId: 'listItems', parameters: [limit, expand, trace], responses: ok },
      // Reaches GET /items (#68): a tool only while listItems is one
      head: { operationId: 'headItems', responses: ok },
      post: {
        operationId: 'createItem',
        parameters: [expand],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
        responses: ok,
      },
    },
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getItem', parameters: [expand], responses: ok },
    },
    // Required: omitted whatever the flag says
    '/reports': {
      get: { operationId: 'getReport', parameters: [{ ...expand, required: true }], responses: ok },
    },
    // An exploded object could send `expand` itself: omitted whatever the flag says
    '/search': {
      get: {
        operationId: 'search',
        parameters: [{ name: 'filter', in: 'query', schema: { type: 'object' } }, expand],
        responses: ok,
      },
    },
    // PHP reads `dry.run` as `dry_run`: omitted whatever the flag says
    '/runs': {
      get: {
        operationId: 'listRuns',
        parameters: [
          { ...expand, name: 'dry_run' },
          { name: 'dry.run', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: ok,
      },
    },
    '/pets': { get: { operationId: 'listPets', parameters: [limit], responses: ok } },
  },
};

const CALLS: Readonly<Record<string, { args: Record<string, unknown>; request: string }>> = {
  listItems: { args: { limit: 2 }, request: 'GET /items?limit=2' },
  headItems: { args: {}, request: 'HEAD /items' },
  createItem: { args: { name: 'n' }, request: 'POST /items' },
  getItem: { args: { id: 'i-1' }, request: 'GET /items/i-1' },
  getReport: { args: { expand: ['a'] }, request: 'GET /reports' },
  search: { args: {}, request: 'GET /search' },
  listRuns: { args: { 'dry.run': false }, request: 'GET /runs?dry.run=false' },
  listPets: { args: { limit: 1 }, request: 'GET /pets?limit=1' },
};
const ALL = Object.keys(CALLS);

const CASES: readonly { title: string; args: string[]; expected: readonly string[] }[] = [
  {
    title: 'without the flag nothing changes',
    args: [],
    expected: ['listPets'],
  },
  {
    title: 'the reads, under the read-only default',
    args: ['--omit-unsupported-parameters', 'method:get'],
    expected: ['listItems', 'headItems', 'getItem', 'listPets'],
  },
  {
    title: 'every operation the filters allow',
    args: ['--allow', 'path:/**', '--omit-unsupported-parameters', 'path:/**'],
    expected: ['listItems', 'headItems', 'createItem', 'getItem', 'listPets'],
  },
  {
    title: 'one operation by name',
    args: ['--omit-unsupported-parameters', 'operationId:getItem'],
    expected: ['getItem', 'listPets'],
  },
  {
    title: '--deny still wins',
    args: ['--omit-unsupported-parameters', 'method:get', '--deny', 'operationId:getItem'],
    expected: ['listItems', 'headItems', 'listPets'],
  },
];

// Arguments that name a left-out parameter: refused before any request
const SMUGGLED: readonly { name: string; args: Record<string, unknown> }[] = [
  { name: 'listItems', args: { limit: 2, expand: ['customer'] } },
  { name: 'listItems', args: { 'x-trace': 't' } },
  { name: 'getItem', args: { id: 'i-1', expand: ['customer'] } },
  { name: 'listItems', args: { 'expand[0]': 'customer' } },
];

describe('serve --omit-unsupported-parameters (issue #67)', () => {
  let home: string;
  let specPath: string;
  let upstream: Upstream;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp unsupported '));
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
  const without = (names: readonly string[], drop: readonly string[]) =>
    names.filter((name) => !drop.includes(name));

  const expectSent = async (name: string, call: () => Promise<unknown>) => {
    const reply = await call();
    expect({ name, reply }).toMatchObject({ name, reply: { kind: 'result', isError: false } });
  };

  it.each(CASES)('per-operation: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options(args), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual(
        ['execute_code', 'openapi_mcp_status', ...expected].toSorted(),
      );
      for (const name of without(ALL, expected)) {
        const reply = await session.callTool(name, CALLS[name]?.args ?? {});
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'rpc-error' } });
      }
      for (const { name, args: smuggled } of SMUGGLED.filter((entry) =>
        expected.includes(entry.name),
      )) {
        const reply = await session.callTool(name, smuggled);
        expect({ name, smuggled, reply }).toMatchObject({ reply: { isError: true } });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        await expectSent(name, () => session.callTool(name, CALLS[name]?.args));
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  it.each(CASES)('discover: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options([...args, '--tool-mode', 'discover']), home, async (session) => {
      const search = await session.callTool('search_operations', { limit: 25, detail: 'names' });
      const found = JSON.stringify(search);
      expect(ALL.filter((name) => found.includes(`"${name}"`)).toSorted()).toStrictEqual(
        [...expected].toSorted(),
      );
      for (const name of without(ALL, expected)) {
        const reply = await session.callTool('call_operation', {
          name,
          arguments: CALLS[name]?.args ?? {},
        });
        expect({ name, reply }).toMatchObject({
          reply: { isError: true, text: expect.stringContaining('unknown operation') },
        });
      }
      for (const { name, args: smuggled } of SMUGGLED.filter((entry) =>
        expected.includes(entry.name),
      )) {
        const reply = await session.callTool('call_operation', { name, arguments: smuggled });
        expect({ name, smuggled, reply }).toMatchObject({ reply: { isError: true } });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        await expectSent(name, () =>
          session.callTool('call_operation', { name, arguments: CALLS[name]?.args ?? {} }),
        );
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  const listed = async (session: McpSession, name: string) => {
    const reply = await session.request('tools/list');
    const tools = (reply.result?.['tools'] ?? []) as {
      name: string;
      description?: string;
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    return tools.find((tool) => tool.name === name);
  };

  it('tells the agent which parameters are not available, and offers only the others', async () => {
    await withServe(
      options(['--omit-unsupported-parameters', 'method:get']),
      home,
      async (session) => {
        const tool = await listed(session, 'listItems');
        expect(tool?.description).toBe('[Parameters not available here: expand, x-trace.]');
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toStrictEqual(['limit']);
        expect(session.stderr()).toContain(
          '--omit-unsupported-parameters: 2 tools leave out optional parameters the agent cannot set: listItems (expand, x-trace), getItem (expand); each with its reason: openapi-mcp --json tools',
        );
        const described = await session.callTool('openapi_mcp_status', {});
        expect(described).toMatchObject({ kind: 'result', isError: false });
      },
    );
    await withServe(
      options(['--omit-unsupported-parameters', 'method:get', '--tool-mode', 'discover']),
      home,
      async (session) => {
        const described = await session.callTool('describe_operation', { name: 'listItems' });
        expect(JSON.stringify(described)).toContain('Parameters not available here: expand');
        expect(JSON.stringify(described)).not.toContain('deepObject');
      },
    );
  });

  it('names the flag at startup when operations are omitted only for such parameters', async () => {
    await withServe(options([]), home, (session) => {
      expect(session.stderr()).toContain(
        '2 operations are omitted only for optional parameters this server cannot send; --omit-unsupported-parameters <pattern> builds them without those parameters: listItems (expand, x-trace), getItem (expand)',
      );
      return Promise.resolve();
    });
  });
});

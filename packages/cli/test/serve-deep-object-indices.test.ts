import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, startUpstream, withServe } from './filter-harness.ts';
import type { Upstream } from './filter-harness.ts';

// Issues #95 and #96 end to end: the real CLI over MCP stdio, in both tool
// modes, against an upstream that records every request with its body. With
// --deep-object-indices, an operation omitted only for deepObject values
// OpenAPI does not define becomes a tool that sends them as
// `name[a][0]=value`. Every expectation is written by hand from the spec
// below: exactly the expected tools are offered and each reaches the
// upstream with exactly the expected bytes; every other operation is refused
// by name and the upstream never sees it.

const ok = { '200': { description: 'ok' } };
const DEEP = { style: 'deepObject', explode: true };
const expand = {
  name: 'expand',
  in: 'query',
  ...DEEP,
  schema: { type: 'array', items: { type: 'string' } },
};
const created = {
  name: 'created',
  in: 'query',
  ...DEEP,
  schema: {
    anyOf: [{ type: 'integer' }, { type: 'object', properties: { gte: { type: 'integer' } } }],
  },
};
const color = {
  name: 'color',
  in: 'query',
  ...DEEP,
  schema: { type: 'object', properties: { R: { type: 'integer' } } },
};
const form = (properties: Record<string, unknown>, encoding: Record<string, unknown>) => ({
  required: true,
  content: {
    'application/x-www-form-urlencoded': {
      schema: { type: 'object', properties, additionalProperties: false },
      encoding,
    },
  },
});

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Deep objects', version: '1' },
  paths: {
    '/customers': {
      get: { operationId: 'listCustomers', parameters: [expand, created], responses: ok },
      post: {
        operationId: 'createCustomer',
        requestBody: form(
          {
            email: { type: 'string' },
            metadata: {
              anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { enum: [''] }],
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { price: { type: 'string' }, quantity: { type: 'integer' } },
              },
            },
          },
          { metadata: DEEP, items: DEEP },
        ),
        responses: ok,
      },
    },
    // No deepObject value: the flag changes nothing
    '/health': { get: { operationId: 'getHealth', responses: ok } },
    // One level of scalars, as OpenAPI defines it: a tool with or without the flag
    '/colors': {
      get: { operationId: 'listColors', parameters: [color], responses: ok },
      post: {
        operationId: 'createColor',
        requestBody: form(
          { rgb: { type: 'object', properties: { R: { type: 'integer' } } } },
          { rgb: DEEP },
        ),
        responses: ok,
      },
    },
  },
};

const CALLS: Readonly<
  Record<
    string,
    { args: Record<string, unknown>; request: { method: string; url: string; body?: string } }
  >
> = {
  listCustomers: {
    args: { expand: ['data.address', 'a b'], created: { gte: 5 } },
    request: {
      method: 'GET',
      url: '/customers?expand%5B0%5D=data.address&expand%5B1%5D=a%20b&created%5Bgte%5D=5',
    },
  },
  createCustomer: {
    args: {
      email: 'a@example.test',
      metadata: { order: '7' },
      items: [{ price: 'p_1', quantity: 2 }, { price: 'p_2' }],
    },
    request: {
      method: 'POST',
      url: '/customers',
      body: 'email=a%40example.test&metadata%5Border%5D=7&items%5B0%5D%5Bprice%5D=p_1&items%5B0%5D%5Bquantity%5D=2&items%5B1%5D%5Bprice%5D=p_2',
    },
  },
  getHealth: { args: {}, request: { method: 'GET', url: '/health' } },
  listColors: {
    args: { color: { R: 1 } },
    request: { method: 'GET', url: '/colors?color%5BR%5D=1' },
  },
  createColor: {
    args: { rgb: { R: 2 } },
    request: { method: 'POST', url: '/colors', body: 'rgb%5BR%5D=2' },
  },
};
const ALL = Object.keys(CALLS);

const CASES: readonly { title: string; args: string[]; expected: readonly string[] }[] = [
  {
    title: 'without the flag, only what OpenAPI defines',
    args: [],
    expected: ['getHealth', 'listColors', 'createColor'],
  },
  {
    title: 'every operation',
    args: ['--deep-object-indices', 'path:/**'],
    expected: ALL,
  },
  {
    title: 'one operation by name',
    args: ['--deep-object-indices', 'operationId:listCustomers'],
    expected: ['listCustomers', 'getHealth', 'listColors', 'createColor'],
  },
  {
    title: '--deny still wins',
    args: ['--deep-object-indices', 'path:/**', '--deny', 'method:post'],
    expected: ['listCustomers', 'getHealth', 'listColors'],
  },
];

describe('serve --deep-object-indices (issues #95 and #96)', () => {
  let home: string;
  let specPath: string;
  let upstream: Upstream;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp deep objects '));
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
    '--allow',
    'path:/**',
    '--allow-private-network',
    '--allow-insecure-http',
    '--rate-limit',
    '100000/1m',
    ...extra,
  ];
  const requestsOf = (names: readonly string[]) =>
    names
      .map((name) => CALLS[name]?.request)
      .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const sent = () =>
    upstream.requests.toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

  it.each(CASES)('per-operation: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options(args), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual(
        ['execute_code', 'openapi_mcp_status', ...expected].toSorted(),
      );
      for (const name of ALL.filter((candidate) => !expected.includes(candidate))) {
        const reply = await session.callTool(name, CALLS[name]?.args ?? {});
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'rpc-error' } });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        const reply = await session.callTool(name, CALLS[name]?.args);
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'result', isError: false } });
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  it.each(CASES)('discover: $title', async ({ args, expected }) => {
    upstream.requests.length = 0;
    await withServe(options([...args, '--tool-mode', 'discover']), home, async (session) => {
      for (const name of ALL.filter((candidate) => !expected.includes(candidate))) {
        const reply = await session.callTool('call_operation', {
          name,
          arguments: CALLS[name]?.args ?? {},
        });
        expect({ name, reply }).toMatchObject({
          reply: { isError: true, text: expect.stringContaining('unknown operation') },
        });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        const reply = await session.callTool('call_operation', {
          name,
          arguments: CALLS[name]?.args ?? {},
        });
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'result', isError: false } });
      }
    });
    expect(sent()).toStrictEqual(requestsOf(expected));
  });

  it('refuses a value the convention cannot send, before any request', async () => {
    upstream.requests.length = 0;
    await withServe(options(['--deep-object-indices', 'path:/**']), home, async (session) => {
      const reply = await session.callTool('createCustomer', { items: [] });
      expect(reply).toMatchObject({
        isError: true,
        text: expect.stringContaining(
          'body field "items" is an empty array, which cannot be sent: leave it out',
        ),
      });
    });
    expect(upstream.requests).toStrictEqual([]);
  });

  it('names the flag at startup, and a pattern that changes nothing', async () => {
    await withServe(options([]), home, (session) => {
      expect(session.stderr()).toContain(
        '2 operations are omitted only for deepObject values OpenAPI does not define (nested objects, arrays or scalars); --deep-object-indices <pattern> builds them and sends those values as name[key][0]=value, if the API reads that: listCustomers, createCustomer',
      );
      return Promise.resolve();
    });
    await withServe(options(['--deep-object-indices', 'path:/health']), home, (session) => {
      expect(session.stderr()).toContain(
        '--deep-object-indices "path:/health" matches no operation with a deepObject value, so it changes nothing',
      );
      return Promise.resolve();
    });
  });

  it('marks the tools in tools --json, and the omitted operations it would build', async () => {
    const report = JSON.parse(
      await runCli(
        [
          '--json',
          'tools',
          '--spec',
          specPath,
          '--allow',
          'path:/**',
          '--deep-object-indices',
          'method:get',
        ],
        home,
      ),
    ) as {
      data: {
        tools: { name: string; deepObjectIndices?: true }[];
        notExposed: { toolName?: string; buildsWithDeepObjectIndices?: true }[];
      };
    };
    expect(
      report.data.tools.map((tool) => [tool.name, tool.deepObjectIndices ?? false]),
    ).toStrictEqual([
      ['listCustomers', true],
      ['getHealth', false],
      ['listColors', true],
      ['createColor', false],
    ]);
    expect(
      report.data.notExposed.map((entry) => [entry.toolName, entry.buildsWithDeepObjectIndices]),
    ).toStrictEqual([['createCustomer', true]]);
  });

  it('marks the tools in the text output of tools', async () => {
    const text = await runCli(
      ['tools', '--spec', specPath, '--allow', 'path:/**', '--deep-object-indices', 'method:get'],
      home,
    );
    expect(text).toMatch(/listCustomers +GET +\/customers \[deepObject indices\]\n/u);
    expect(text).toMatch(/createColor +POST +\/colors\n/u);
  });

  it('call --dry-run shows the keys it would send, and sends nothing', async () => {
    upstream.requests.length = 0;
    const report = JSON.parse(
      await runCli(
        [
          '--json',
          'call',
          'listCustomers',
          '--dry-run',
          '--args-json',
          JSON.stringify(CALLS['listCustomers']?.args),
          ...options(['--deep-object-indices', 'path:/**']),
        ],
        home,
      ),
    ) as { data: { query: string[] } };
    expect(report.data.query).toStrictEqual(['expand[0]', 'expand[1]', 'created[gte]']);
    expect(upstream.requests).toStrictEqual([]);
  });
});

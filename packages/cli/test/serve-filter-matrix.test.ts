import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServe, startUpstream, withServe } from './filter-harness.ts';
import type { McpSession, ToolReply, Upstream } from './filter-harness.ts';

// --allow and --deny end to end: the real CLI over MCP stdio, in both tool
// modes, against an upstream that records every request. Every expectation
// below is written by hand from the spec, never computed with the filter
// code, so a filter bug cannot confirm itself. For each configuration:
// exactly the expected tools are offered; every other operation is refused
// by name (and by a case variant) with the specific error, and the upstream
// never sees it; every expected operation is called and reaches the upstream
// with its own method and path, which also proves the server was working
// while it refused the rest.

const ok = { '200': { description: 'ok' } };
const op = (operationId: string | undefined, tag: string) => ({
  ...(operationId === undefined ? {} : { operationId }),
  tags: [tag],
  responses: ok,
});
const param = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Filters', version: '1' },
  paths: {
    '/orders': { get: op('listOrders', 'Orders'), post: op('createOrder', 'Orders') },
    '/orders/{orderId}': {
      // A path-level parameter, inherited by every operation below
      parameters: [param('orderId')],
      get: op('getOrder', 'Orders'),
      delete: op('deleteOrder', 'Orders'),
      head: op('headOrder', 'Orders'),
      patch: op('updateOrder', 'Orders'),
      // Never a tool, whatever the filters say
      options: op('optionsOrder', 'Orders'),
    },
    '/orders/{orderId}/cancel': {
      post: { ...op('cancelOrder', 'Orders'), parameters: [param('orderId')] },
    },
    '/orders-archive': { get: op('listArchivedOrders', 'Orders') },
    '/customers': {
      get: op('listCustomers', 'Customers'),
      delete: op('deleteCustomers', 'Customers'),
    },
    // The same tag in another letter case
    '/customers/{customerId}': {
      delete: { ...op('removeCustomer', 'customers'), parameters: [param('customerId')] },
    },
    // No operationId: the tool name is generated
    '/reports': { get: op(undefined, 'Reports') },
    // A `/` and a `.` in the operationId
    '/billing/invoices': { get: op('billing/invoices.list', 'Billing') },
    '/support': { get: op('getSupport', 'Customer Support') },
    // Lower-casing without normalization: STRASSE is not straße
    '/straße': { get: op('getStrasse', 'Straße') },
    '/admin/users/{userId}': {
      put: { ...op('replaceUser', 'Admin'), parameters: [param('userId')] },
    },
  },
};

// Every tool name with the request its call must send
const ROUTES: Readonly<Record<string, readonly [string, string]>> = {
  listOrders: ['GET', '/orders'],
  createOrder: ['POST', '/orders'],
  getOrder: ['GET', '/orders/o-1'],
  deleteOrder: ['DELETE', '/orders/o-1'],
  headOrder: ['HEAD', '/orders/o-1'],
  updateOrder: ['PATCH', '/orders/o-1'],
  cancelOrder: ['POST', '/orders/o-1/cancel'],
  listArchivedOrders: ['GET', '/orders-archive'],
  listCustomers: ['GET', '/customers'],
  deleteCustomers: ['DELETE', '/customers'],
  removeCustomer: ['DELETE', '/customers/c-1'],
  get_reports: ['GET', '/reports'],
  billing_invoices_list: ['GET', '/billing/invoices'],
  getSupport: ['GET', '/support'],
  getStrasse: ['GET', '/stra%C3%9Fe'],
  replaceUser: ['PUT', '/admin/users/u-1'],
};
const ALL = Object.keys(ROUTES);
const ARGS: Readonly<Record<string, Record<string, string>>> = {
  getOrder: { orderId: 'o-1' },
  deleteOrder: { orderId: 'o-1' },
  headOrder: { orderId: 'o-1' },
  updateOrder: { orderId: 'o-1' },
  cancelOrder: { orderId: 'o-1' },
  removeCustomer: { customerId: 'c-1' },
  replaceUser: { userId: 'u-1' },
};
const argsOf = (name: string): Record<string, string> => ARGS[name] ?? {};
// Operations no configuration can expose: never offered, never callable
const NEVER = ['optionsOrder'];

const ORDERS = [
  'listOrders',
  'createOrder',
  'getOrder',
  'deleteOrder',
  'headOrder',
  'updateOrder',
  'cancelOrder',
  'listArchivedOrders',
];
const READS = [
  'listOrders',
  'getOrder',
  'headOrder',
  'listArchivedOrders',
  'listCustomers',
  'get_reports',
  'billing_invoices_list',
  'getSupport',
  'getStrasse',
];
const DELETES = ['deleteOrder', 'deleteCustomers', 'removeCustomer'];
const without = (names: readonly string[], drop: readonly string[]) =>
  names.filter((name) => !drop.includes(name));

// `blocked`: offered as tools, but every call is refused before it is sent,
// because its URL also matches an operation the filters exclude. A HEAD
// request reads what the GET on the same path returns, so a declared HEAD
// stays closed while that GET is excluded.
const CASES: readonly {
  title: string;
  args: string[];
  expected: readonly string[];
  blocked?: readonly string[];
}[] = [
  { title: 'no --allow: the read-only default (GET and HEAD)', args: [], expected: READS },
  {
    title: 'everything but deletes',
    args: ['--allow', 'path:/**', '--deny', 'method:delete'],
    expected: without(ALL, DELETES),
  },
  { title: 'a tag, in another letter case', args: ['--allow', 'tag:orders'], expected: ORDERS },
  {
    title: 'a tag without its deletes, all upper case',
    args: ['--allow', 'TAG:ORDERS', '--deny', 'METHOD:DELETE'],
    expected: without(ORDERS, DELETES),
  },
  {
    title: '/orders/** leaves out /orders and /orders-archive',
    args: ['--allow', 'path:/orders/**'],
    expected: ['getOrder', 'deleteOrder', 'headOrder', 'updateOrder', 'cancelOrder'],
  },
  {
    title: '/orders** also matches /orders and /orders-archive',
    args: ['--allow', 'path:/orders**'],
    expected: ORDERS,
  },
  {
    title: 'one route by its template, GET only (not HEAD)',
    args: ['--allow', 'route:GET /orders/{orderId}'],
    expected: ['getOrder'],
  },
  {
    title: 'a declared HEAD alone is offered, but stays closed while its GET is excluded',
    args: ['--allow', 'route:HEAD /orders/{orderId}'],
    expected: ['headOrder'],
    blocked: ['headOrder'],
  },
  {
    title: 'a route with * for one segment, in other letter cases',
    args: ['--allow', 'route:get /ORDERS/*'],
    expected: ['getOrder'],
  },
  {
    title: 'an operationId glob across a /',
    args: ['--allow', 'operationId:billing/*'],
    expected: ['billing_invoices_list'],
  },
  {
    title: 'a generated tool name',
    args: ['--allow', 'name:get_reports'],
    expected: ['get_reports'],
  },
  {
    title: 'a tag with a space',
    args: ['--allow', 'tag:Customer Support'],
    expected: ['getSupport'],
  },
  {
    title: 'one tag in two letter cases',
    args: ['--allow', 'tag:CUSTOMERS'],
    expected: ['listCustomers', 'deleteCustomers', 'removeCustomer'],
  },
  {
    title: 'no Unicode normalization: STRASSE is not Straße',
    args: ['--allow', 'tag:STRASSE'],
    expected: [],
  },
  { title: 'straße matches Straße', args: ['--allow', 'tag:straße'], expected: ['getStrasse'] },
  {
    title: 'deny wins over allow',
    args: ['--allow', 'method:delete', '--deny', 'route:DELETE /orders/{orderId}'],
    expected: ['deleteCustomers', 'removeCustomer'],
  },
  { title: 'deny everything', args: ['--allow', 'path:/**', '--deny', 'path:/**'], expected: [] },
  {
    title: 'several --allow add up',
    args: ['--allow', 'tag:Orders', '--allow', 'tag:Billing'],
    expected: [...ORDERS, 'billing_invoices_list'],
  },
  {
    title: 'an operationId glob in the middle',
    args: ['--allow', 'operationId:*order*'],
    expected: ORDERS,
  },
  {
    title: '--deny alone narrows the read-only default',
    args: ['--deny', 'method:get'],
    expected: ['headOrder'],
    blocked: ['headOrder'],
  },
];

// A name the server must not resolve to another tool by letter case
const caseVariant = (name: string): string =>
  name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();

describe('serve — --allow and --deny end to end', () => {
  let home: string;
  let specPath: string;
  let upstream: Upstream;

  beforeAll(async () => {
    // A space in the path, as on many Windows and macOS machines
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp filters '));
    specPath = join(home, 'spec.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    upstream = await startUpstream();
  });

  afterAll(async () => {
    await upstream.close();
    rmSync(home, { recursive: true, force: true });
  });

  const serveArgs = (extra: readonly string[]) => [
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
  const expectedRequests = (names: readonly string[], blocked: readonly string[] = []) =>
    without(names, blocked)
      .map((name) => (ROUTES[name] ?? []).join(' '))
      .toSorted();
  const OVERLAP =
    'tool execution failed: the request was not sent: its URL also matches an operation this server does not expose; see the server startup diagnostics';
  // A called tool either reaches the upstream or, when blocked, is refused
  // with exactly this message
  const expectCalled = (name: string, reply: ToolReply, blocked: readonly string[] = []) => {
    if (blocked.includes(name)) {
      expect({ name, reply }).toMatchObject({
        name,
        reply: { kind: 'result', isError: true, text: OVERLAP },
      });
    } else {
      expect({ name, kind: reply.kind }).toStrictEqual({ name, kind: 'result' });
    }
  };

  const expectRefusedPerOperation = async (session: McpSession, name: string) => {
    for (const candidate of [name, caseVariant(name)]) {
      if (ROUTES[candidate] !== undefined && candidate !== name) {
        continue;
      }
      const reply = await session.callTool(candidate, argsOf(name));
      expect({ candidate, reply }).toStrictEqual({
        candidate,
        reply: { kind: 'rpc-error', code: -32_602, message: `unknown tool "${candidate}"` },
      });
    }
  };

  const expectRefusedDiscover = async (session: McpSession, name: string) => {
    for (const candidate of [name, caseVariant(name)]) {
      const unknown = `unknown operation "${candidate}" — use search_operations to find an operation name`;
      const described = await session.callTool('describe_operation', { name: candidate });
      const called = await session.callTool('call_operation', {
        name: candidate,
        arguments: argsOf(name),
      });
      const refusal = { kind: 'result', isError: true, text: unknown };
      expect({ candidate, described, called }).toMatchObject({
        candidate,
        described: refusal,
        called: refusal,
      });
    }
  };

  it.each(CASES)('per-operation: $title', async ({ args, expected, blocked }) => {
    upstream.requests.length = 0;
    await withServe(serveArgs(args), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual(['openapi_mcp_status', ...expected].toSorted());
      for (const name of [...without(ALL, expected), ...NEVER]) {
        await expectRefusedPerOperation(session, name);
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        expectCalled(name, await session.callTool(name, argsOf(name)), blocked);
      }
    });
    expect(sent()).toStrictEqual(expectedRequests(expected, blocked));
  });

  it.each(CASES)('discover: $title', async ({ args, expected, blocked }) => {
    upstream.requests.length = 0;
    await withServe(serveArgs([...args, '--tool-mode', 'discover']), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual([
        'call_operation',
        'describe_operation',
        'openapi_mcp_status',
        'search_operations',
      ]);
      // Fewer than the search limit, so one search lists every exposed one
      const search = await session.callTool('search_operations', { limit: 25, detail: 'names' });
      const found = JSON.stringify(search);
      const listed = ALL.filter((name) => found.includes(`"${name}"`));
      expect(listed.toSorted()).toStrictEqual([...expected].toSorted());
      for (const name of [...without(ALL, expected), ...NEVER]) {
        await expectRefusedDiscover(session, name);
      }
      // A direct tool call is not a way around discover mode
      for (const name of ALL) {
        expect(await session.callTool(name, argsOf(name))).toMatchObject({ kind: 'rpc-error' });
      }
      expect(upstream.requests).toStrictEqual([]);
      for (const name of expected) {
        const described = await session.callTool('describe_operation', { name });
        expect(described).toMatchObject({ kind: 'result', isError: false });
        const reply = await session.callTool('call_operation', { name, arguments: argsOf(name) });
        expectCalled(name, reply, blocked);
      }
    });
    expect(sent()).toStrictEqual(expectedRequests(expected, blocked));
  });

  // The arguments of an exposed tool must not reach another operation
  it('keeps every argument inside the exposed operation', async () => {
    upstream.requests.length = 0;
    const args = serveArgs(['--allow', 'route:GET /orders/{orderId}']);
    await withServe(args, home, async (session) => {
      for (const extra of ['path', 'url', 'method', 'baseUrl', 'arguments']) {
        const reply = await session.callTool('getOrder', { orderId: 'o-1', [extra]: '/customers' });
        expect(reply).toMatchObject({ kind: 'result', isError: true });
        expect((reply as { text: string }).text).toContain('unrecognized_keys');
      }
      expect(upstream.requests).toStrictEqual([]);
      // A separator or dot-segment never leaves its path parameter
      for (const orderId of [
        'o-1/cancel',
        '../customers',
        '..%2Fcustomers',
        'a\\b',
        '%2e%2e',
        '.',
      ]) {
        const reply = await session.callTool('getOrder', { orderId });
        expect({ orderId, reply }).toMatchObject({
          orderId,
          reply: {
            kind: 'result',
            isError: true,
            text: expect.stringContaining('path parameter "orderId" was refused'),
          },
        });
      }
      expect(upstream.requests).toStrictEqual([]);
      // The control: the same tool with a plain value reaches the upstream
      expect(await session.callTool('getOrder', { orderId: 'o-1' })).toMatchObject({
        kind: 'result',
        isError: false,
      });
    });
    expect(sent()).toStrictEqual(['GET /orders/o-1']);
  });

  it('refuses names that are not operations, in both modes', async () => {
    upstream.requests.length = 0;
    const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ''];
    await withServe(serveArgs(['--allow', 'path:/**']), home, async (session) => {
      for (const name of odd) {
        const reply = await session.callTool(name);
        expect({ name, reply }).toMatchObject({
          name,
          reply: { kind: 'rpc-error', code: -32_602 },
        });
      }
    });
    await withServe(
      serveArgs(['--allow', 'path:/**', '--tool-mode', 'discover']),
      home,
      async (session) => {
        for (const name of [
          ...odd.filter((entry) => entry !== ''),
          'call_operation',
          'openapi_mcp_status',
        ]) {
          const reply = await session.callTool('call_operation', { name, arguments: {} });
          expect({ name, reply }).toMatchObject({
            name,
            reply: {
              kind: 'result',
              isError: true,
              text: expect.stringContaining('unknown operation'),
            },
          });
        }
      },
    );
    expect(upstream.requests).toStrictEqual([]);
  });

  it('warns about a pattern that matches nothing, and refuses to start with --strict-filters', async () => {
    const dead = ['--allow', 'tag:Orders', '--allow', 'tag:Nothing'];
    await withServe(serveArgs(dead), home, async (session) => {
      expect(await session.listTools()).toContain('listOrders');
      expect(session.stderr()).toContain('tag:Nothing');
    });
    await expect(startServe(serveArgs([...dead, '--strict-filters']), home)).rejects.toThrow(
      /serve exited/u,
    );
  });
});

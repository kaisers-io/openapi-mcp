import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServe } from './filter-harness.ts';

// `serve --execute` end to end (issue #60): the real CLI over MCP stdio runs
// a script in its worker, against two APIs behind one server and a local
// upstream that records every request. One script joins data from both APIs;
// each nested call keeps its own API's credential, and a write is never sent.

const SHOP_TOKEN = 'Bearer shop-token-example-not-a-secret';
const CRM_TOKEN = 'Bearer crm-token-example-not-a-secret';

const json = (schema: Record<string, unknown>) => ({
  '200': { description: 'ok', content: { 'application/json': { schema } } },
});
const SHOP = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/orders': {
      get: { operationId: 'listOrders', responses: json({ type: 'array' }) },
      post: { operationId: 'createOrder', responses: json({ type: 'object' }) },
    },
  },
};
const CRM = {
  openapi: '3.1.0',
  info: { title: 'CRM', version: '1' },
  paths: {
    '/customers/{id}': {
      get: {
        operationId: 'getCustomer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: json({ type: 'object' }),
      },
    },
  },
};

const ORDERS = [
  { id: 'o-1', customerId: 'c-1', total: 10.5 },
  { id: 'o-2', customerId: 'c-2', total: 5 },
  { id: 'o-3', customerId: 'c-1', total: 7 },
  { id: 'o-4', customerId: 'c-3', total: 2 },
];
const COUNTRIES: Record<string, string> = { 'c-1': 'AT', 'c-2': 'DE', 'c-3': 'AT' };

type Recorded = { method: string; url: string; authorization?: string };

describe('serve --execute (#60)', () => {
  let home: string;
  let url: string;
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      ...(req.headers.authorization === undefined
        ? {}
        : { authorization: req.headers.authorization }),
    });
    req.resume();
    const customer = /^\/crm\/customers\/(?<id>[\w-]+)$/u.exec(req.url ?? '')?.groups?.['id'];
    const body =
      req.url === '/shop/orders'
        ? ORDERS
        : { id: customer, country: COUNTRIES[customer ?? ''] ?? 'XX' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const saved = { shop: process.env['SHOP_TOKEN'], crm: process.env['CRM_TOKEN'] };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp execute '));
    writeFileSync(join(home, 'shop.json'), JSON.stringify(SHOP));
    writeFileSync(join(home, 'crm.json'), JSON.stringify(CRM));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    process.env['SHOP_TOKEN'] = SHOP_TOKEN;
    process.env['CRM_TOKEN'] = CRM_TOKEN;
  });

  afterAll(async () => {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of [
      ['SHOP_TOKEN', saved.shop],
      ['CRM_TOKEN', saved.crm],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const severalApis = (extra: readonly string[] = []) => [
    '--api',
    `shop=${join(home, 'shop.json')}`,
    '--api',
    `crm=${join(home, 'crm.json')}`,
    '--base-url',
    `shop=${url}/shop`,
    '--base-url',
    `crm=${url}/crm`,
    '--header-env',
    'shop=Authorization=SHOP_TOKEN',
    '--header-env',
    'crm=Authorization=CRM_TOKEN',
    ...['shop', 'crm'].flatMap((api) => [
      '--enable',
      `${api}=allow-private-network`,
      '--enable',
      `${api}=allow-insecure-http`,
      '--enable',
      `${api}=trust-spec-updates`,
    ]),
    // The write is exposed too, so only execute_code's own rule keeps it out
    '--allow',
    'shop=method:get',
    '--allow',
    'shop=method:post',
    '--tool-mode',
    'discover',
    ...extra,
  ];

  it('joins two APIs in one script, each call with its own credential only', async () => {
    requests.length = 0;
    await withServe(severalApis(), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual([
        'call_operation',
        'describe_operation',
        'execute_code',
        'openapi_mcp_status',
        'search_operations',
      ]);
      const reply = await session.callTool('execute_code', {
        code: `
          const orders = (await api.call('shop_listOrders')).data;
          const ids = [...new Set(orders.map((order) => order.customerId))];
          const customers = await Promise.all(ids.map((id) => api.call('crm_getCustomer', { id })));
          const austrian = new Set(customers.map((c) => c.data).filter((c) => c.country === 'AT').map((c) => c.id));
          return orders.filter((order) => austrian.has(order.customerId)).reduce((sum, order) => sum + order.total, 0);
        `,
      });
      expect(reply).toMatchObject({
        kind: 'result',
        isError: false,
        structured: {
          result: 19.5,
          calls: [
            { name: 'shop_listOrders', status: 'ok' },
            { name: 'crm_getCustomer', status: 'ok' },
            { name: 'crm_getCustomer', status: 'ok' },
            { name: 'crm_getCustomer', status: 'ok' },
          ],
        },
      });
    });
    expect(requests.toSorted((a, b) => a.url.localeCompare(b.url))).toStrictEqual([
      { method: 'GET', url: '/crm/customers/c-1', authorization: CRM_TOKEN },
      { method: 'GET', url: '/crm/customers/c-2', authorization: CRM_TOKEN },
      { method: 'GET', url: '/crm/customers/c-3', authorization: CRM_TOKEN },
      { method: 'GET', url: '/shop/orders', authorization: SHOP_TOKEN },
    ]);
  });

  it('joins two APIs by their tool names under --tool-mode per-operation', async () => {
    requests.length = 0;
    const perOperation = severalApis().map((arg) => (arg === 'discover' ? 'per-operation' : arg));
    await withServe(perOperation, home, async (session) => {
      const reply = await session.callTool('execute_code', {
        code: `
          const orders = (await api.call('shop_listOrders')).data;
          const first = await api.call('crm_getCustomer', { id: orders[0].customerId });
          return first.data.country;
        `,
      });
      expect(reply).toMatchObject({ isError: false, structured: { result: 'AT' } });
    });
    expect(requests.toSorted((a, b) => a.url.localeCompare(b.url))).toStrictEqual([
      { method: 'GET', url: '/crm/customers/c-1', authorization: CRM_TOKEN },
      { method: 'GET', url: '/shop/orders', authorization: SHOP_TOKEN },
    ]);
  });

  it('never sends a write from a script, though call_operation may', async () => {
    requests.length = 0;
    await withServe(severalApis(), home, async (session) => {
      const reply = await session.callTool('execute_code', {
        code: `try { await api.call('shop_createOrder', {}); } catch (error) { return error.message; }`,
      });
      expect(reply).toMatchObject({
        isError: false,
        structured: {
          result:
            'shop_createOrder is not read-only: execute_code calls read-only operations only; use call_operation for it',
        },
      });
      expect(requests).toStrictEqual([]);
    });
  });

  it('ends a runaway script and keeps serving', async () => {
    await withServe(severalApis(), home, async (session) => {
      const hog = await session.callTool('execute_code', {
        code: 'const a = []; for (;;) a.push(new Array(1e5).fill(1));',
      });
      expect(hog).toMatchObject({ isError: true, text: expect.stringContaining('memory') });
      const after = await session.callTool('execute_code', { code: 'return 42;' });
      expect(after).toMatchObject({ isError: false, structured: { result: 42 } });
    });
  });

  it('is on by default in every tool mode, and --no-execute turns it off', async () => {
    const base = severalApis();
    for (const mode of ['discover', 'per-operation', 'auto']) {
      const modeArgs = [
        ...base.filter((arg) => arg !== 'discover' && arg !== '--tool-mode'),
        '--tool-mode',
        mode,
      ];
      await withServe(modeArgs, home, async (session) => {
        expect(await session.listTools()).toContain('execute_code');
      });
      await withServe([...modeArgs, '--no-execute'], home, async (session) => {
        expect(await session.listTools()).not.toContain('execute_code');
      });
    }
  });

  it('runs next to the operation tools under --tool-mode per-operation', async () => {
    requests.length = 0;
    await withServe(
      [
        '--spec',
        join(home, 'shop.json'),
        '--base-url',
        `${url}/shop`,
        '--allow-private-network',
        '--allow-insecure-http',
        '--tool-mode',
        'per-operation',
      ],
      home,
      async (session) => {
        const tools = await session.listTools();
        expect(tools.toSorted()).toStrictEqual([
          'execute_code',
          'listOrders',
          'openapi_mcp_status',
        ]);
        const reply = await session.callTool('execute_code', {
          code: `const orders = (await api.call('listOrders')).data; return orders.length;`,
        });
        expect(reply).toMatchObject({ isError: false, structured: { result: 4 } });
      },
    );
    expect(requests).toStrictEqual([{ method: 'GET', url: '/shop/orders' }]);
  });

  it('starts with an operation named execute_code, which keeps its name', async () => {
    const spec = join(home, 'collide.json');
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Collide', version: '1' },
        paths: {
          '/run': { get: { operationId: 'execute_code', responses: json({ type: 'object' }) } },
        },
      }),
    );
    for (const mode of ['per-operation', 'auto']) {
      requests.length = 0;
      await withServe(
        [
          '--spec',
          spec,
          '--base-url',
          `${url}/run`,
          '--allow-private-network',
          '--allow-insecure-http',
          '--tool-mode',
          mode,
        ],
        home,
        async (session) => {
          const listed = await session.listTools();
          expect(listed.toSorted()).toStrictEqual(['execute_code', 'openapi_mcp_status']);
          // The listed execute_code is the operation: it takes no code and calls the API
          expect(await session.callTool('execute_code', {})).toMatchObject({ isError: false });
          expect(session.stderr()).toContain(
            'operation "execute_code" has the name of the program tool, so this server lists the operation and no program tool',
          );
        },
      );
      expect(requests).toStrictEqual([{ method: 'GET', url: '/run/run' }]);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServe, startUpstream, withServe } from './filter-harness.ts';
import type { Upstream } from './filter-harness.ts';

// Several APIs behind one serve (issue #16), end to end: the real CLI over
// MCP stdio, two specs, one recording upstream with each API under its own
// base path. Each API's filters, credentials and redirects stay its own.

const SHOP_TOKEN = 'Bearer shop-token-example-not-a-secret';
const CRM_TOKEN = 'Bearer crm-token-example-not-a-secret';

const ok = { '200': { description: 'ok' } };
const param = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const SHOP = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/orders': {
      get: { operationId: 'listOrders', responses: ok },
      post: { operationId: 'createOrder', responses: ok },
    },
    '/orders/{orderId}': {
      parameters: [param('orderId')],
      get: { operationId: 'getOrder', responses: ok },
      delete: { operationId: 'deleteOrder', responses: ok },
    },
    // Answered with a redirect into the CRM's base path
    '/jump': { get: { operationId: 'jump', responses: ok } },
  },
};
const CRM = {
  openapi: '3.1.0',
  info: { title: 'CRM', version: '2' },
  paths: {
    '/contacts': {
      get: { operationId: 'listContacts', responses: ok },
      post: { operationId: 'createContact', responses: ok },
    },
    '/contacts/{contactId}': {
      parameters: [param('contactId')],
      delete: { operationId: 'deleteContact', responses: ok },
    },
  },
};

describe('serve — several APIs (#16)', () => {
  let home: string;
  let upstream: Upstream;
  const saved = { shop: process.env['SHOP_TOKEN'], crm: process.env['CRM_TOKEN'] };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp several apis '));
    writeFileSync(join(home, 'shop.json'), JSON.stringify(SHOP));
    writeFileSync(join(home, 'crm.json'), JSON.stringify(CRM));
    upstream = await startUpstream({ '/shop/jump': '/crm/contacts' });
    process.env['SHOP_TOKEN'] = SHOP_TOKEN;
    process.env['CRM_TOKEN'] = CRM_TOKEN;
  });

  afterAll(async () => {
    await upstream.close();
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

  const args = (extra: readonly string[] = []) => [
    '--api',
    `shop=${join(home, 'shop.json')}`,
    '--api',
    `crm=${join(home, 'crm.json')}`,
    '--base-url',
    `shop=${upstream.url}/shop`,
    '--base-url',
    `crm=${upstream.url}/crm`,
    '--header-env',
    'shop=Authorization=SHOP_TOKEN',
    '--header-env',
    'crm=Authorization=CRM_TOKEN',
    '--enable',
    'shop=allow-private-network',
    '--enable',
    'crm=allow-private-network',
    '--enable',
    'shop=allow-insecure-http',
    '--enable',
    'crm=allow-insecure-http',
    '--enable',
    'shop=trust-spec-updates',
    '--enable',
    'crm=trust-spec-updates',
    '--rate-limit',
    '100000/1m',
    ...extra,
  ];

  it('offers each API under its own prefix, with its own filters and an unnamed deny for all', async () => {
    upstream.requests.length = 0;
    const filters = ['--allow', 'shop=path:/**', '--deny', 'method:delete'];
    await withServe(args(filters), home, async (session) => {
      const tools = await session.listTools();
      expect(tools.toSorted()).toStrictEqual([
        'crm_listContacts',
        'openapi_mcp_status',
        'shop_createOrder',
        'shop_getOrder',
        'shop_jump',
        'shop_listOrders',
      ]);
      for (const name of [
        'shop_deleteOrder',
        'crm_createContact',
        'crm_deleteContact',
        'listOrders',
      ]) {
        const reply = await session.callTool(name, {});
        expect({ name, reply }).toMatchObject({
          name,
          reply: { kind: 'rpc-error', code: -32_602 },
        });
      }
      expect(upstream.requests).toStrictEqual([]);
      await session.callTool('shop_getOrder', { orderId: 'o-1' });
      await session.callTool('crm_listContacts', {});
      const status = await session.callTool('openapi_mcp_status', {});
      const apis = (status as { structured?: { apis?: { name: string; toolCount: number }[] } })
        .structured?.apis;
      expect(apis?.map((api) => [api.name, api.toolCount])).toStrictEqual([
        ['shop', 4],
        ['crm', 1],
      ]);
    });
    // Each call went to its own API, with its own credential only
    expect(upstream.requests).toStrictEqual([
      { method: 'GET', url: '/shop/orders/o-1', authorization: SHOP_TOKEN },
      { method: 'GET', url: '/crm/contacts', authorization: CRM_TOKEN },
    ]);
  });

  it('searches, describes and calls qualified names in discover mode', async () => {
    upstream.requests.length = 0;
    await withServe(args(['--tool-mode', 'discover']), home, async (session) => {
      const search = await session.callTool('search_operations', { api: 'crm', detail: 'names' });
      expect(JSON.stringify(search)).toContain('crm_listContacts');
      expect(JSON.stringify(search)).not.toContain('shop_');
      const described = await session.callTool('describe_operation', { name: 'shop_listOrders' });
      expect(described).toMatchObject({ kind: 'result', isError: false });
      const called = await session.callTool('call_operation', {
        name: 'crm_listContacts',
        arguments: {},
      });
      expect(called.kind).toBe('result');
      const unknown = await session.callTool('call_operation', {
        name: 'listContacts',
        arguments: {},
      });
      expect(unknown).toMatchObject({
        isError: true,
        text: expect.stringContaining('unknown operation'),
      });
    });
    expect(upstream.requests).toStrictEqual([
      { method: 'GET', url: '/crm/contacts', authorization: CRM_TOKEN },
    ]);
  });

  // A redirect from one API into another's base path on the same origin
  it('never carries one API’s credential into another, also when the redirect is followed', async () => {
    upstream.requests.length = 0;
    await withServe(args(), home, async (session) => {
      const reply = await session.callTool('shop_jump', {});
      expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('redirect') });
    });
    expect(upstream.requests).toStrictEqual([
      { method: 'GET', url: '/shop/jump', authorization: SHOP_TOKEN },
    ]);
    upstream.requests.length = 0;
    await withServe(args(['--enable', 'shop=allow-offsite-redirects']), home, async (session) => {
      await session.callTool('shop_jump', {});
    });
    expect(upstream.requests).toStrictEqual([
      { method: 'GET', url: '/shop/jump', authorization: SHOP_TOKEN },
      { method: 'GET', url: '/crm/contacts' },
    ]);
  });

  it.each([
    [['--allow', 'path:/**'], 'does not start with the name of an API'],
    [['--allow-private-network'], 'write --enable <name>=allow-private-network'],
    [['--spec', 'x.json'], '--spec and --api cannot be combined'],
    [['--allow', 'crm=path:/**', '--base-url', 'crm=http://127.0.0.1:9/shop/v1'], 'is given twice'],
  ])('refuses to start with %j', async (extra, message) => {
    const start = startServe(args(extra), home);
    await expect(start).rejects.toThrow(/serve exited \(code [12]/u);
    await start.catch((error: unknown) => {
      expect(String(error)).toContain(message);
    });
  });

  it('refuses overlapping base URLs and a spec that does not load', async () => {
    const overlapping = [
      '--api',
      `shop=${join(home, 'shop.json')}`,
      '--api',
      `crm=${join(home, 'crm.json')}`,
      '--base-url',
      `shop=${upstream.url}/`,
      '--base-url',
      `crm=${upstream.url}/crm`,
      '--enable',
      'shop=allow-private-network',
      '--enable',
      'crm=allow-private-network',
    ];
    await expect(startServe(overlapping, home)).rejects.toThrow('overlap');
    const broken = [...args(), '--api', `missing=${join(home, 'missing.json')}`];
    await expect(startServe(broken, home)).rejects.toThrow(/serve exited/u);
  });
});

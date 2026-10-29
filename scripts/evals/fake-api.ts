// A deterministic fake shop API for agent task evaluations. The data comes
// from a seeded generator, so every run sees the same customers, orders and
// tickets. The server records every request so the harness can check the
// final state, for example that a write happened exactly once.
/* oxlint-disable max-lines -- One fixture: the data, the OpenAPI description of it and the server that answers it change together */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const seededRandom = (seed: number) => () => {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to a 32-bit integer, which the generator needs; Math.trunc does not wrap
  seed = (seed + 0x6d_2b_79_f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
};
const pad = (value: number, width: number) => String(value).padStart(width, '0');

export type Data = ReturnType<typeof buildData>;

export const buildData = () => {
  const random = seededRandom(60);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const firstNames = [
    'Anna',
    'Ben',
    'Clara',
    'David',
    'Eva',
    'Felix',
    'Greta',
    'Hugo',
    'Ida',
    'Jonas',
    'Klara',
    'Leo',
  ];
  const lastNames = [
    'Fischer',
    'Weber',
    'Meyer',
    'Wagner',
    'Becker',
    'Schulz',
    'Hoffmann',
    'Koch',
    'Richter',
    'Wolf',
  ];
  const customers = Array.from({ length: 60 }, (_unused, index) => {
    const name = `${pick(firstNames)} ${pick(lastNames)}`;
    return {
      id: `C-${pad(index + 1, 3)}`,
      name,
      email: `${name.toLowerCase().replace(' ', '.')}.${index + 1}@example.test`,
      country: pick(['DE', 'DE', 'AT', 'CH', 'FR', 'US', 'GB']),
      tier: pick(['basic', 'plus', 'pro']),
      // oxlint-disable-next-line unicorn/no-null -- The API answers a JSON null phone, which the filter-nullable task is about
      phone: random() < 0.3 ? null : `+49 30 ${pad(Math.floor(random() * 1e6), 6)}`,
    };
  });
  const categories = ['audio', 'video', 'home', 'garden'] as const;
  const nouns = [
    'Speaker',
    'Headphones',
    'Lamp',
    'Camera',
    'Kettle',
    'Hose',
    'Projector',
    'Radio',
    'Shears',
    'Fan',
  ];
  const products = Array.from({ length: 20 }, (_unused, index) => ({
    sku: `P-${pad(index + 1, 2)}`,
    name: `${pick(['Nova', 'Atlas', 'Orbit', 'Pulse', 'Terra'])} ${nouns[index % nouns.length]}`,
    category: categories[index % categories.length] as string,
    price: Math.round((10 + random() * 240) * 100) / 100,
  }));
  const orders = Array.from({ length: 200 }, (_unused, index) => {
    const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      sku: pick(products).sku,
      quantity: 1 + Math.floor(random() * 5),
    }));
    const total = items.reduce(
      (sum, item) =>
        sum + item.quantity * products.find((product) => product.sku === item.sku)!.price,
      0,
    );
    return {
      id: `O-${1001 + index}`,
      customerId: pick(customers).id,
      status:
        random() < 0.07 ? 'cancelled' : pick(['pending', 'shipped', 'delivered', 'delivered']),
      createdAt: new Date(
        Date.UTC(2026, 0, 1) + index * 37 * 3_600_000 + Math.floor(random() * 3_600_000),
      ).toISOString(),
      items,
      total: Math.round(total * 100) / 100,
    };
  });
  const warehouses = ['W-1', 'W-2', 'W-3'].map((id, index) => ({
    id,
    city: ['Berlin', 'Hamburg', 'Munich'][index]!,
  }));
  const stock = warehouses.flatMap((warehouse) =>
    products.map((product) => ({
      warehouseId: warehouse.id,
      sku: product.sku,
      onHand: Math.floor(random() * 400),
      reserved: Math.floor(random() * 30),
    })),
  );
  const tickets = Array.from({ length: 40 }, (_unused, index) => ({
    id: `T-${pad(index + 1, 3)}`,
    customerId: pick(customers.slice(0, 15)).id,
    status: random() < 0.6 ? 'open' : 'closed',
    subject: pick([
      'Damaged item',
      'Wrong size',
      'Invoice question',
      'Late delivery',
      'Return request',
    ]),
    createdAt: new Date(Date.UTC(2026, 5, 1) + index * 86_400_000).toISOString(),
  }));
  return { customers, products, orders, warehouses, stock, tickets };
};

// A long event log with bulky payloads, so a task about one event means
// reading or filtering a large result
export const orderEvents = (data: Data, orderId: string) => {
  const order = data.orders.find((candidate) => candidate.id === orderId);
  if (!order) {
    return;
  }
  const random = seededRandom(Number(orderId.slice(2)));
  const start = Date.parse(order.createdAt);
  const kinds = ['tracking.scan', 'tracking.scan', 'tracking.scan', 'note.added', 'sensor.reading'];
  const events = Array.from({ length: 300 }, (_unused, index) => ({
    seq: index + 1,
    at: new Date(start + index * 600_000 + Math.floor(random() * 300_000)).toISOString(),
    type: kinds[Math.floor(random() * kinds.length)]!,
    // oxlint-disable-next-line unicorn/no-null -- The API answers a JSON null status on every event that is not a status change
    status: null as string | null,
    payload: {
      hub: `HUB-${Math.floor(random() * 90) + 10}`,
      note: 'Lorem ipsum dolor sit amet. '.repeat(4),
    },
  }));
  const flow = ['pending', 'shipped', 'delivered'];
  const statuses =
    order.status === 'cancelled'
      ? ['pending', 'cancelled']
      : flow.slice(0, flow.indexOf(order.status) + 1);
  statuses.forEach((status, index) => {
    const event = events[Math.floor(((index + 0.5) * 300) / statuses.length)]!;
    event.type = 'status.changed';
    event.status = status;
  });
  return events;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const int = { type: 'integer' };
const page = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: 'Page number, starting at 1',
  },
  {
    name: 'pageSize',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 10, default: 10 },
    description: 'Items per page, at most 10',
  },
];
const paged = (item: unknown) => ({
  type: 'object',
  required: ['items', 'page', 'totalPages'],
  properties: { items: { type: 'array', items: item }, page: int, totalPages: int },
});
const pathParam = (name: string) => ({ name, in: 'path', required: true, schema: str });
const ok = (schema: unknown, description = 'OK') => ({
  '200': { description, content: { 'application/json': { schema } } },
  '404': { description: 'Not found' },
});
const get = (
  operationId: string,
  summary: string,
  tag: string,
  response: unknown,
  parameters: unknown[] = [],
) => ({
  get: { operationId, summary, tags: [tag], parameters, responses: ok(response) },
});

// Operations that look like the right one for a task but are not. A few
// near-duplicates make search and selection mistakes visible.
const FILLER: [string, string, string, string][] = [
  ['/invoices', 'listInvoices', 'List invoices', 'billing'],
  ['/invoices/{invoiceId}', 'getInvoice', 'Get an invoice', 'billing'],
  ['/credit-notes', 'listCreditNotes', 'List credit notes', 'billing'],
  ['/shipments', 'listShipments', 'List shipments', 'logistics'],
  ['/shipments/{shipmentId}', 'getShipment', 'Get a shipment', 'logistics'],
  ['/carriers', 'listCarriers', 'List shipping carriers', 'logistics'],
  ['/coupons', 'listCoupons', 'List coupons', 'marketing'],
  ['/campaigns', 'listCampaigns', 'List marketing campaigns', 'marketing'],
  ['/suppliers', 'listSuppliers', 'List suppliers', 'purchasing'],
  ['/suppliers/{supplierId}', 'getSupplier', 'Get a supplier', 'purchasing'],
  [
    '/purchase-orders',
    'listPurchaseOrders',
    'List purchase orders sent to suppliers',
    'purchasing',
  ],
  ['/returns', 'listReturns', 'List customer returns', 'support'],
  ['/returns/{returnId}', 'getReturn', 'Get a customer return', 'support'],
  ['/reviews', 'listReviews', 'List product reviews', 'catalog'],
  ['/categories', 'listCategories', 'List product categories', 'catalog'],
  ['/employees', 'listEmployees', 'List employees', 'admin'],
  ['/stores', 'listStores', 'List retail stores', 'admin'],
  ['/audit-log', 'listAuditLog', 'List admin audit log entries', 'admin'],
  [
    '/customer-segments',
    'listCustomerSegments',
    'List customer segments for marketing',
    'marketing',
  ],
  ['/order-exports', 'listOrderExports', 'List finished order export files', 'reports'],
  [
    '/sales-reports/{year}',
    'getSalesReport',
    'Get the yearly sales report (precomputed, updated monthly)',
    'reports',
  ],
];

// The large API: the same core plus generated resources, about 260
// operations, many named like the core ones (customer notes, order
// adjustments, inventory transfers). Each has a realistic schema size.
const LARGE_RESOURCES = [
  'customer-notes',
  'customer-addresses',
  'customer-consents',
  'customer-groups',
  'customer-wallets',
  'order-adjustments',
  'order-notes',
  'order-holds',
  'order-splits',
  'order-fees',
  'product-bundles',
  'product-variants',
  'product-images',
  'product-attributes',
  'product-prices',
  'inventory-transfers',
  'inventory-counts',
  'inventory-adjustments',
  'inventory-reservations',
  'inventory-forecasts',
  'warehouse-zones',
  'warehouse-bins',
  'warehouse-shifts',
  'warehouse-docks',
  'warehouse-devices',
  'ticket-macros',
  'ticket-tags',
  'ticket-slas',
  'ticket-surveys',
  'ticket-escalations',
  'payment-methods',
  'payment-disputes',
  'payouts',
  'tax-rates',
  'tax-exemptions',
  'shipping-zones',
  'shipping-rates',
  'delivery-slots',
  'pickup-points',
  'parcel-labels',
  'loyalty-accounts',
  'gift-cards',
  'subscriptions',
  'price-rules',
  'webhooks',
];
const camel = (text: string) =>
  text.replaceAll(/-(?<letter>\w)/gu, (_match, letter: string) => letter.toUpperCase());
const pascal = (text: string) => camel(text).replace(/^\w/u, (letter) => letter.toUpperCase());
const words = (text: string) => text.replaceAll('-', ' ');
const largeRecord = (resource: string) => ({
  type: 'object',
  properties: Object.fromEntries(
    ['id', 'name', 'status', 'createdAt', 'updatedAt', 'ownerId', 'notes', 'externalRef'].map(
      (field) => [
        field,
        {
          type: 'string',
          description: `The ${field} of the ${words(resource).replace(/s$/u, '')}`,
        },
      ],
    ),
  ),
});
const largeQuery = [
  ...page,
  {
    name: 'updatedSince',
    in: 'query',
    schema: { type: 'string', format: 'date-time' },
    description: 'Only records changed after this time',
  },
  {
    name: 'sort',
    in: 'query',
    schema: { type: 'string', enum: ['createdAt', '-createdAt', 'name'] },
    description: 'Sort order',
  },
];

const addLarge = (paths: Record<string, unknown>) => {
  for (const resource of LARGE_RESOURCES) {
    const singular = pascal(resource).replace(/s$/u, '');
    const id = `${camel(resource).replace(/s$/u, '')}Id`;
    const tag = resource.split('-')[0]!;
    const plural = words(resource);
    paths[`/${resource}`] = get(
      `list${pascal(resource)}`,
      `List ${plural}`,
      tag,
      paged(largeRecord(resource)),
      largeQuery,
    );
    paths[`/${resource}/{${id}}`] = get(
      `get${singular}`,
      `Get one of the ${plural}`,
      tag,
      largeRecord(resource),
      [pathParam(id)],
    );
    paths[`/${resource}/{${id}}/history`] = get(
      `get${singular}History`,
      `List the change history of one of the ${plural}`,
      tag,
      paged(largeRecord(resource)),
      [pathParam(id), ...page],
    );
    paths[`/${resource}/{${id}}/stats`] = get(
      `get${singular}Stats`,
      `Get usage statistics of one of the ${plural}`,
      tag,
      largeRecord(resource),
      [pathParam(id)],
    );
    paths[`/${resource}/summary`] = get(
      `get${pascal(resource)}Summary`,
      `Get a summary over all ${plural}`,
      tag,
      largeRecord(resource),
      [{ name: 'updatedSince', in: 'query', schema: { type: 'string', format: 'date-time' } }],
    );
  }
};

export const buildSpec = (baseUrl: string, size: 'small' | 'large' = 'small') => {
  const paths: Record<string, unknown> = {
    '/customers': get(
      'listCustomers',
      'List customers, ten per page',
      'customers',
      paged(ref('Customer')),
      page,
    ),
    '/customers/{customerId}': get('getCustomer', 'Get a customer', 'customers', ref('Customer'), [
      pathParam('customerId'),
    ]),
    '/customers/{customerId}/orders': get(
      'listCustomerOrders',
      'List the orders of one customer, newest first',
      'orders',
      paged(ref('OrderSummary')),
      [pathParam('customerId'), ...page],
    ),
    '/orders': get(
      'listOrders',
      'List orders, optionally filtered by status',
      'orders',
      paged(ref('OrderSummary')),
      [
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['pending', 'shipped', 'delivered', 'cancelled'] },
        },
        ...page,
      ],
    ),
    '/orders/{orderId}': get(
      'getOrder',
      'Get an order with its items and total',
      'orders',
      ref('Order'),
      [pathParam('orderId')],
    ),
    '/orders/{orderId}/events': get(
      'listOrderEvents',
      'List every tracking and status event of an order',
      'orders',
      { type: 'array', items: ref('OrderEvent') },
      [pathParam('orderId')],
    ),
    '/products': get(
      'listProducts',
      'List products, optionally filtered by category',
      'catalog',
      paged(ref('Product')),
      [{ name: 'category', in: 'query', schema: str }, ...page],
    ),
    '/products/{sku}': get('getProduct', 'Get a product', 'catalog', ref('Product'), [
      pathParam('sku'),
    ]),
    '/warehouses': get('listWarehouses', 'List warehouses', 'inventory', {
      type: 'array',
      items: ref('Warehouse'),
    }),
    '/warehouses/{warehouseId}/stock/{sku}': get(
      'getWarehouseStock',
      'Get the current stock of one product in one warehouse',
      'inventory',
      ref('StockLevel'),
      [pathParam('warehouseId'), pathParam('sku')],
    ),
    '/inventory/{sku}': get(
      'getInventory',
      'Get the current stock of one product summed over all warehouses',
      'inventory',
      { type: 'object', properties: { sku: str, onHand: int, reserved: int } },
      [pathParam('sku')],
    ),
    '/stock-reports/{sku}': get(
      'getStockReport',
      'Get the stock report of one product as of the last monthly closing',
      'reports',
      {
        type: 'object',
        properties: {
          sku: str,
          asOf: str,
          warehouses: { type: 'array', items: ref('StockLevel') },
        },
      },
      [pathParam('sku')],
    ),
    '/tickets': {
      ...get('listTickets', 'List support tickets', 'support', paged(ref('Ticket')), [
        { name: 'customerId', in: 'query', schema: str },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] } },
        ...page,
      ]),
      post: {
        operationId: 'createTicket',
        summary: 'Open a support ticket',
        tags: ['support'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customerId', 'subject'],
                properties: { customerId: str, subject: str },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: ref('Ticket') } },
          },
        },
      },
    },
    '/tickets/{ticketId}': get('getTicket', 'Get a support ticket', 'support', ref('Ticket'), [
      pathParam('ticketId'),
    ]),
  };
  for (const [path, operationId, summary, tag] of FILLER) {
    const params = [...path.matchAll(/\{(?<name>\w+)\}/gu)].map((match) =>
      pathParam(match.groups!['name']!),
    );
    paths[path] = get(
      operationId,
      summary,
      tag,
      { type: 'object', additionalProperties: true },
      params,
    );
  }
  if (size === 'large') {
    addLarge(paths);
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Example Shop API', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas: {
        Customer: {
          type: 'object',
          required: ['id', 'name', 'email', 'country', 'tier', 'phone'],
          properties: {
            id: str,
            name: str,
            email: str,
            country: { type: 'string', description: 'ISO 3166-1 alpha-2' },
            tier: str,
            phone: { type: ['string', 'null'] },
          },
        },
        OrderSummary: {
          type: 'object',
          properties: { id: str, customerId: str, status: str, createdAt: str },
        },
        Order: {
          type: 'object',
          properties: {
            id: str,
            customerId: str,
            status: str,
            createdAt: str,
            total: { type: 'number' },
            items: {
              type: 'array',
              items: { type: 'object', properties: { sku: str, quantity: int } },
            },
          },
        },
        OrderEvent: {
          type: 'object',
          properties: {
            seq: int,
            at: str,
            type: str,
            status: { type: ['string', 'null'] },
            payload: { type: 'object', additionalProperties: true },
          },
        },
        Product: {
          type: 'object',
          properties: { sku: str, name: str, category: str, price: { type: 'number' } },
        },
        Warehouse: { type: 'object', properties: { id: str, city: str } },
        StockLevel: {
          type: 'object',
          properties: { warehouseId: str, sku: str, onHand: int, reserved: int },
        },
        Ticket: {
          type: 'object',
          properties: { id: str, customerId: str, status: str, subject: str, createdAt: str },
        },
      },
    },
  };
};

// The same API as two specs, for one server with several APIs: `crm` holds
// customers and support tickets, `shop` everything else. A task such as
// revenue per country then needs both. The fake server answers both under
// their own base paths (/crm, /shop).
export const CRM_PATHS = /^\/(?:customers(?:\/\{customerId\})?|tickets(?:\/\{ticketId\})?)$/u;

export const splitSpec = (spec: ReturnType<typeof buildSpec>, baseUrl: string) => {
  const part = (api: 'crm' | 'shop', title: string) => ({
    ...spec,
    info: { ...spec.info, title },
    servers: [{ url: `${baseUrl}/${api}` }],
    paths: Object.fromEntries(
      Object.entries(spec.paths).filter(([path]) => CRM_PATHS.test(path) === (api === 'crm')),
    ),
  });
  return { crm: part('crm', 'Example CRM API'), shop: part('shop', 'Example Shop API') };
};

export interface Recorded {
  method: string;
  path: string;
  status: number;
  body?: unknown;
}

const send = (response: ServerResponse, status: number, body?: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
  return status;
};
const pageOf = <T>(list: T[], query: URLSearchParams) => {
  const size = Math.min(Number(query.get('pageSize') ?? 10) || 10, 10);
  const number = Math.max(Number(query.get('page') ?? 1) || 1, 1);
  return {
    items: list.slice((number - 1) * size, number * size),
    page: number,
    totalPages: Math.max(Math.ceil(list.length / size), 1),
  };
};
const orderSummary = (order: Data['orders'][number]) => ({
  id: order.id,
  customerId: order.customerId,
  status: order.status,
  createdAt: order.createdAt,
});

// Starts the API on a loopback port. `createTicket` stores the ticket and
// then answers 504 the first time, so the agent cannot tell from the
// response whether the write happened.
export const startFakeApi = async () => {
  const data = buildData();
  const tickets = [...data.tickets];
  const requests: Recorded[] = [];
  let created = 0;
  const route = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: unknown,
  ): number => {
    const query = url.searchParams;
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const [head, id, sub, subId] = parts;
    const found = <T>(value: T | undefined) =>
      value === undefined
        ? send(response, 404, { error: 'not found' })
        : send(response, 200, value);
    if (request.method === 'POST' && url.pathname === '/tickets') {
      const input = body as { customerId?: string; subject?: string };
      const ticket = {
        id: `T-${pad(tickets.length + 1, 3)}`,
        customerId: String(input.customerId),
        status: 'open',
        subject: String(input.subject),
        createdAt: '2026-10-01T09:00:00.000Z',
      };
      tickets.push(ticket);
      created += 1;
      return created === 1
        ? send(response, 504, { error: 'upstream timeout' })
        : send(response, 201, ticket);
    }
    if (request.method !== 'GET') {
      return send(response, 405, { error: 'method not allowed' });
    }
    switch (head) {
      case 'customers': {
        if (!id) {
          return send(response, 200, pageOf(data.customers, query));
        }
        if (sub === 'orders') {
          const list = data.orders
            .filter((order) => order.customerId === id)
            .toReversed()
            .map((order) => orderSummary(order));
          return send(response, 200, pageOf(list, query));
        }
        return found(data.customers.find((customer) => customer.id === id));
      }
      case 'orders': {
        if (!id) {
          const list = data.orders
            .filter((order) => !query.get('status') || order.status === query.get('status'))
            .map((order) => orderSummary(order));
          return send(response, 200, pageOf(list, query));
        }
        if (sub === 'events') {
          return found(orderEvents(data, id));
        }
        return found(data.orders.find((order) => order.id === id));
      }
      case 'products': {
        if (!id) {
          const list = data.products.filter(
            (product) => !query.get('category') || product.category === query.get('category'),
          );
          return send(response, 200, pageOf(list, query));
        }
        return found(data.products.find((product) => product.sku === id));
      }
      case 'warehouses': {
        if (!id) {
          return send(response, 200, data.warehouses);
        }
        return found(
          sub === 'stock'
            ? data.stock.find((row) => row.warehouseId === id && row.sku === subId)
            : undefined,
        );
      }
      case 'inventory': {
        const rows = data.stock.filter((row) => row.sku === id);
        return found(
          rows.length > 0
            ? {
                sku: id,
                onHand: rows.reduce((sum, row) => sum + row.onHand, 0),
                reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
              }
            : undefined,
        );
      }
      case 'stock-reports': {
        // Last month's numbers: deliberately different from the current stock
        const rows = data.stock
          .filter((row) => row.sku === id)
          .map((row) => ({
            warehouseId: row.warehouseId,
            sku: row.sku,
            onHand: row.onHand + 17,
            reserved: row.reserved,
          }));
        return found(
          rows.length > 0 ? { sku: id, asOf: '2026-09-30', warehouses: rows } : undefined,
        );
      }
      case 'tickets': {
        if (!id) {
          const list = tickets.filter(
            (ticket) =>
              (!query.get('customerId') || ticket.customerId === query.get('customerId')) &&
              (!query.get('status') || ticket.status === query.get('status')),
          );
          return send(response, 200, pageOf(list, query));
        }
        return found(tickets.find((ticket) => ticket.id === id));
      }
      default: {
        return send(response, 200, {
          items: [],
          note: 'This resource has no data in the fake API.',
        });
      }
    }
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.example.test');
      // Several APIs: each one's base path, which the routes do not know
      url.pathname = url.pathname.replace(/^\/(?:crm|shop)(?=\/)/u, '');
      let body: unknown;
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      const status = route(request, response, url, body);
      requests.push({
        method: request.method ?? '',
        path: url.pathname + url.search,
        status,
        ...(body === undefined ? {} : { body }),
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    data,
    tickets,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
};

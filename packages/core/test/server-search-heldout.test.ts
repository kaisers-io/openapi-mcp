import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createDispatcher,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type { NamedOperation, ServerSnapshot } from '../src/index.ts';

// A HELD-OUT query set for search_operations (issue #38 review). The ranking
// weights were chosen on task-style queries against DigitalOcean and GitHub;
// these queries and this API were written afterwards, without looking at how
// the index scores them, and must not be used to tune the weights. Changing
// the ranking should keep (or improve) these numbers; a drop means the change
// overfits. The API is a self-contained commerce/support service in the
// naming styles real specs use (snake_case and camelCase operationIds,
// nested resource paths, tags, path and query parameters).

const PIPELINE = {
  spec: { title: 't', specVersion: '1', omitted: [] },
  contentHash: 'h',
  displaySource: 's',
  deadPatterns: [],
};

type Spec = {
  method: NamedOperation['operation']['method'];
  path: string;
  summary: string;
  tags: string[];
  params?: string[];
  description?: string;
};

const op = (toolName: string, spec: Spec): NamedOperation => ({
  toolName,
  operation: {
    operationId: toolName,
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    tags: spec.tags,
    deprecated: false,
    parameters: (spec.params ?? []).map((name) => ({
      name,
      in: spec.path.includes(`{${name}}`) ? 'path' : 'query',
      required: spec.path.includes(`{${name}}`),
      schema: { type: 'string' },
    })),
    responses: { '204': { description: 'no content' } },
  },
});

const API: NamedOperation[] = [
  op('customers_list', {
    method: 'get',
    path: '/customers',
    summary: 'List customers',
    tags: ['Customers'],
    params: ['email', 'cursor'],
  }),
  op('customers_create', {
    method: 'post',
    path: '/customers',
    summary: 'Create a customer',
    tags: ['Customers'],
  }),
  op('customers_get', {
    method: 'get',
    path: '/customers/{customer_id}',
    summary: 'Retrieve a customer',
    tags: ['Customers'],
    params: ['customer_id'],
  }),
  op('customers_update', {
    method: 'patch',
    path: '/customers/{customer_id}',
    summary: 'Update a customer',
    tags: ['Customers'],
    params: ['customer_id'],
  }),
  op('customers_delete', {
    method: 'delete',
    path: '/customers/{customer_id}',
    summary: 'Delete a customer',
    tags: ['Customers'],
    params: ['customer_id'],
  }),
  op('customers_list_addresses', {
    method: 'get',
    path: '/customers/{customer_id}/addresses',
    summary: "List a customer's shipping addresses",
    tags: ['Customers'],
    params: ['customer_id'],
  }),
  op('orders_list', {
    method: 'get',
    path: '/orders',
    summary: 'List orders',
    tags: ['Orders'],
    params: ['status', 'customer_id', 'created_after'],
  }),
  op('orders_create', {
    method: 'post',
    path: '/orders',
    summary: 'Place an order',
    tags: ['Orders'],
  }),
  op('orders_get', {
    method: 'get',
    path: '/orders/{order_id}',
    summary: 'Retrieve an order',
    tags: ['Orders'],
    params: ['order_id'],
  }),
  op('orders_cancel', {
    method: 'post',
    path: '/orders/{order_id}/cancel',
    summary: 'Cancel an order',
    description: 'Cancels an order that has not shipped yet and releases reserved stock.',
    tags: ['Orders'],
    params: ['order_id'],
  }),
  op('orders_list_items', {
    method: 'get',
    path: '/orders/{order_id}/items',
    summary: 'List the line items of an order',
    tags: ['Orders'],
    params: ['order_id'],
  }),
  op('shipments_create', {
    method: 'post',
    path: '/orders/{order_id}/shipments',
    summary: 'Create a shipment for an order',
    tags: ['Fulfillment'],
    params: ['order_id'],
  }),
  op('shipments_track', {
    method: 'get',
    path: '/shipments/{shipment_id}/tracking',
    summary: 'Get tracking events for a shipment',
    tags: ['Fulfillment'],
    params: ['shipment_id'],
  }),
  op('refunds_create', {
    method: 'post',
    path: '/payments/{payment_id}/refunds',
    summary: 'Refund a payment',
    description: 'Issues a full or partial refund to the original payment method.',
    tags: ['Payments'],
    params: ['payment_id'],
  }),
  op('payments_list', {
    method: 'get',
    path: '/payments',
    summary: 'List payments',
    tags: ['Payments'],
    params: ['order_id', 'status'],
  }),
  op('payments_capture', {
    method: 'post',
    path: '/payments/{payment_id}/capture',
    summary: 'Capture an authorized payment',
    tags: ['Payments'],
    params: ['payment_id'],
  }),
  op('invoices_list', {
    method: 'get',
    path: '/invoices',
    summary: 'List invoices',
    tags: ['Billing'],
    params: ['customer_id', 'due_before'],
  }),
  op('invoices_get_pdf', {
    method: 'get',
    path: '/invoices/{invoice_id}/pdf',
    summary: 'Download an invoice as PDF',
    tags: ['Billing'],
    params: ['invoice_id'],
  }),
  op('invoices_send', {
    method: 'post',
    path: '/invoices/{invoice_id}/send',
    summary: 'Email an invoice to the customer',
    tags: ['Billing'],
    params: ['invoice_id'],
  }),
  op('subscriptions_list', {
    method: 'get',
    path: '/subscriptions',
    summary: 'List subscriptions',
    tags: ['Billing'],
    params: ['customer_id', 'plan_id'],
  }),
  op('subscriptions_pause', {
    method: 'post',
    path: '/subscriptions/{subscription_id}/pause',
    summary: 'Pause a subscription',
    tags: ['Billing'],
    params: ['subscription_id'],
  }),
  op('plans_list', {
    method: 'get',
    path: '/plans',
    summary: 'List pricing plans',
    tags: ['Billing'],
  }),
  op('products_list', {
    method: 'get',
    path: '/products',
    summary: 'List products in the catalog',
    tags: ['Catalog'],
    params: ['category', 'q'],
  }),
  op('products_get', {
    method: 'get',
    path: '/products/{product_id}',
    summary: 'Retrieve a product',
    tags: ['Catalog'],
    params: ['product_id'],
  }),
  op('products_update_price', {
    method: 'put',
    path: '/products/{product_id}/price',
    summary: "Change a product's price",
    tags: ['Catalog'],
    params: ['product_id'],
  }),
  op('inventory_get', {
    method: 'get',
    path: '/products/{product_id}/inventory',
    summary: 'Get stock levels for a product',
    description: 'Returns on-hand and reserved quantities per warehouse.',
    tags: ['Inventory'],
    params: ['product_id', 'warehouse_id'],
  }),
  op('inventory_adjust', {
    method: 'post',
    path: '/inventory/adjustments',
    summary: 'Adjust stock quantity',
    tags: ['Inventory'],
  }),
  op('warehouses_list', {
    method: 'get',
    path: '/warehouses',
    summary: 'List warehouses',
    tags: ['Inventory'],
  }),
  op('coupons_create', {
    method: 'post',
    path: '/coupons',
    summary: 'Create a discount coupon',
    tags: ['Promotions'],
  }),
  op('coupons_list', {
    method: 'get',
    path: '/coupons',
    summary: 'List coupons',
    tags: ['Promotions'],
    params: ['active'],
  }),
  op('tickets_list', {
    method: 'get',
    path: '/support/tickets',
    summary: 'List support tickets',
    tags: ['Support'],
    params: ['status', 'assignee'],
  }),
  op('tickets_create', {
    method: 'post',
    path: '/support/tickets',
    summary: 'Open a support ticket',
    tags: ['Support'],
  }),
  op('tickets_add_comment', {
    method: 'post',
    path: '/support/tickets/{ticket_id}/comments',
    summary: 'Reply to a support ticket',
    tags: ['Support'],
    params: ['ticket_id'],
  }),
  op('tickets_close', {
    method: 'post',
    path: '/support/tickets/{ticket_id}/close',
    summary: 'Close a support ticket',
    tags: ['Support'],
    params: ['ticket_id'],
  }),
  op('webhooks_list', {
    method: 'get',
    path: '/webhooks',
    summary: 'List webhook endpoints',
    tags: ['Developers'],
  }),
  op('webhooks_create', {
    method: 'post',
    path: '/webhooks',
    summary: 'Register a webhook endpoint',
    tags: ['Developers'],
  }),
  op('webhooks_delete', {
    method: 'delete',
    path: '/webhooks/{webhook_id}',
    summary: 'Delete a webhook endpoint',
    tags: ['Developers'],
    params: ['webhook_id'],
  }),
  op('apiKeys_rotate', {
    method: 'post',
    path: '/api-keys/{key_id}/rotate',
    summary: 'Rotate an API key',
    tags: ['Developers'],
    params: ['key_id'],
  }),
  op('events_list', {
    method: 'get',
    path: '/events',
    summary: 'List account events (audit log)',
    tags: ['Developers'],
    params: ['type', 'created_after'],
  }),
  op('reports_sales', {
    method: 'get',
    path: '/reports/sales',
    summary: 'Sales report by day',
    tags: ['Reports'],
    params: ['from', 'to'],
  }),
];

// Task-style queries, as a model would phrase them, and the operation each
// task needs
const HELD_OUT: readonly (readonly [string, string])[] = [
  ['find a customer by email', 'customers_list'],
  ['delete customer', 'customers_delete'],
  ['shipping addresses of a customer', 'customers_list_addresses'],
  ['cancel order', 'orders_cancel'],
  ['what items are in an order', 'orders_list_items'],
  ['track a package shipment', 'shipments_track'],
  ['ship an order', 'shipments_create'],
  ['refund payment', 'refunds_create'],
  ['capture payment', 'payments_capture'],
  ['download invoice pdf', 'invoices_get_pdf'],
  ['send invoice by email', 'invoices_send'],
  ['pause subscription', 'subscriptions_pause'],
  ['pricing plans', 'plans_list'],
  ['change product price', 'products_update_price'],
  ['how much stock is left for a product', 'inventory_get'],
  ['adjust inventory', 'inventory_adjust'],
  ['create discount coupon', 'coupons_create'],
  ['open support ticket', 'tickets_create'],
  ['reply to ticket', 'tickets_add_comment'],
  ['close ticket', 'tickets_close'],
  ['register webhook', 'webhooks_create'],
  ['rotate api key', 'apiKeys_rotate'],
  ['audit log', 'events_list'],
  ['daily sales report', 'reports_sales'],
  // Paraphrases with little or no word overlap: the hard part of the set
  ['remove a customer account', 'customers_delete'],
  ['stop an order before it ships', 'orders_cancel'],
  ['issue a partial refund to the card', 'refunds_create'],
  ['reserved quantity per warehouse', 'inventory_get'],
  ['invoices that are due soon', 'invoices_list'],
  ['products in a category', 'products_list'],
  ['which webhook endpoints are configured', 'webhooks_list'],
  ['generate new api credentials', 'apiKeys_rotate'],
  ['where is my parcel', 'shipments_track'],
  ['revenue between two dates', 'reports_sales'],
];

const snapshot = ((): ServerSnapshot => {
  const built = buildTools(API, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, PIPELINE, { toolMode: 'discover' });
})();

const rankOf = async (query: string, expected: string): Promise<number | undefined> => {
  const dispatcher = createDispatcher({
    snapshot,
    limiter: { consume: () => true },
    now: () => 0,
    executor: () => Promise.resolve(textOutcome('unused', true)),
    metaExecutor: createMetaExecutor(),
    redactor: createRedactor([]),
  });
  const result = await dispatcher.call({
    name: 'search_operations',
    arguments: { query, limit: 10, detail: 'names' },
    signal: new AbortController().signal,
  });
  if (result.kind !== 'outcome') {
    throw new Error('search_operations is a listed tool');
  }
  const names = (result.outcome.structuredContent as { results: { name: string }[] }).results.map(
    (entry) => entry.name,
  );
  const index = names.indexOf(expected);
  return index === -1 ? undefined : index + 1;
};

describe('search_operations — held-out query set', () => {
  it('exposes every operation the queries expect (the set is about ranking, not coverage)', () => {
    const names = new Set(snapshot.operations.map((tool) => tool.name));
    expect(HELD_OUT.filter(([, expected]) => !names.has(expected))).toEqual([]);
  });

  it('keeps top-1 and top-5 recall at or above the recorded floor', async () => {
    const ranks = await Promise.all(HELD_OUT.map(([query, expected]) => rankOf(query, expected)));
    const top1 = ranks.filter((rank) => rank === 1).length;
    const top5 = ranks.filter((rank) => rank !== undefined && rank <= 5).length;
    expect(top1).toBeGreaterThanOrEqual(HELD_OUT_FLOOR.top1);
    expect(top5).toBeGreaterThanOrEqual(HELD_OUT_FLOOR.top5);
  });
});

// Recorded when the set was added, of 34 queries: 29 rank first and 32 in the
// top 5. The two misses are pure synonyms ("where is my parcel" for shipment
// tracking, "revenue between two dates" for the sales report), which keyword
// search cannot bridge. Raise the floor when a change improves it; a change
// that lowers it is a regression.
const HELD_OUT_FLOOR = { top1: 29, top5: 32 };

import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  assignToolNames,
  createMatchBudget,
  matchesOperation,
  parseFilterPattern,
} from '../src/index.ts';
import type { OperationMethod, OperationRecord } from '../src/index.ts';

// Issue #42: explicit selectors that match regardless of case. An invented
// shop API.

const record = (
  method: OperationMethod,
  path: string,
  operationId?: string,
  tags: readonly string[] = [],
): OperationRecord => ({
  method,
  path,
  ...(operationId === undefined ? {} : { operationId }),
  tags,
  deprecated: false,
  parameters: [],
  responses: {},
});

const decide = (operations: readonly OperationRecord[], allow: string[], deny: string[] = []) =>
  applyFilters(
    assignToolNames(operations),
    allow.map((raw) => parseFilterPattern(raw)),
    deny.map((raw) => parseFilterPattern(raw)),
  );

const exposed = (operations: readonly OperationRecord[], allow: string[], deny: string[] = []) =>
  decide(operations, allow, deny).exposed.map((named) => named.toolName);

describe('selectors (issue #42)', () => {
  // The configuration from the issue: method-like prefixes were operationId
  // globs, so every DELETE whose name started with an allowed word stayed
  const SHOP = [
    record('get', '/posts', 'readsList'),
    record('delete', '/posts/{id}', 'postsDelete'),
    record('delete', '/reads/{id}', 'readsRemove'),
    record('put', '/items/{id}', 'putsUpdate'),
    record('delete', '/items/{id}', 'putsDelete'),
    record('delete', '/orders/{id}', 'DeleteOrder'),
    record('post', '/orders', 'createOrder'),
  ];

  it('selects by method, whatever the operations are called', () => {
    const named = exposed(
      SHOP,
      ['method:get', 'method:post', 'method:put', 'method:patch'],
      ['method:delete'],
    );
    expect(named).toEqual(['readsList', 'putsUpdate', 'createOrder']);
    // The names alone would have let every DELETE through
    expect(exposed(SHOP, ['operationId:read*', 'operationId:post*', 'operationId:put*'])).toEqual([
      'readsList',
      'postsDelete',
      'readsRemove',
      'putsUpdate',
      'putsDelete',
    ]);
  });

  it('matches every selector regardless of case', () => {
    const operations = [record('delete', '/Orders/{orderId}', 'DeleteOrder', ['Orders'])];
    for (const raw of [
      'method:Delete',
      'path:/orders/*',
      'route:delete /ORDERS/{ORDERID}',
      'operationId:deleteorder',
      'name:DELETEORDER',
      'tag:orders',
    ]) {
      expect({ raw, exposed: exposed(operations, [raw]) }).toEqual({
        raw,
        exposed: ['DeleteOrder'],
      });
    }
  });

  it('matches the generated tool name, also for an operation without an operationId', () => {
    const operations = [
      record('get', '/reports', undefined, ['Reports']),
      record('get', '/x', 'x'),
    ];
    expect(exposed(operations, ['name:get_reports'])).toEqual(['get_reports']);
    expect(exposed(operations, ['operationId:*'])).toEqual(['x']);
    expect(exposed(operations, ['path:/**'])).toEqual(['get_reports', 'x']);
  });

  it('matches a tool name with its collision suffix', () => {
    const operations = [record('get', '/a', 'list.items'), record('get', '/b', 'list_items')];
    const names = assignToolNames(operations).map((named) => named.toolName);
    expect(names[0]).not.toBe(names[1]);
    expect(exposed(operations, [`name:${names[1] ?? ''}`])).toEqual([names[1]]);
    expect(exposed(operations, ['name:list_items*'])).toEqual(names);
  });

  it('lets "*" cross "/" in an operationId, and only "**" cross it in a path', () => {
    const operations = [record('get', '/repos/{owner}/{repo}', 'repos/get')];
    expect(exposed(operations, ['operationId:repos*'])).toEqual(['repos_get']);
    expect(exposed(operations, ['path:/repos/*'])).toEqual([]);
    expect(exposed(operations, ['path:/repos/**'])).toEqual(['repos_get']);
    expect(exposed(operations, ['path:**{repo}'])).toEqual(['repos_get']);
  });

  it('keeps spaces and colons in a value', () => {
    const operations = [
      record('get', '/a', 'orders:read', ['Customer Support']),
      record('get', '/b', 'other'),
    ];
    expect(exposed(operations, ['operationId:orders:read'])).toEqual(['orders_read']);
    expect(exposed(operations, ['tag:customer support'])).toEqual(['orders_read']);
  });

  it('lowers values with JavaScript Unicode lower-casing, without normalization', () => {
    // "İ" lowers to "i" plus a combining dot, so "İndex" is not "index"
    const operations = [record('get', '/a', 'İndex'), record('get', '/b', 'ÄNDERN')];
    expect(exposed(operations, ['operationId:ändern'])).toEqual(['ANDERN']);
    expect(exposed(operations, ['operationId:index'])).toEqual([]);
    expect(exposed(operations, ['operationId:i̇ndex'])).toEqual(['Index']);
  });

  it('suggests the closest value of the same selector, compared regardless of case', () => {
    const { deadPatterns } = decide(SHOP, ['operationId:creatorder', 'tag:x', 'path:/order']);
    expect(deadPatterns).toEqual([
      { raw: 'operationId:creatorder', flag: 'allow', suggestion: 'operationId:createOrder' },
      { raw: 'tag:x', flag: 'allow' },
      { raw: 'path:/order', flag: 'allow', suggestion: 'path:/orders' },
    ]);
  });

  // Review of #42: a target changed after it was matched is matched by its
  // current values
  it('matches a target by its current values after it changes', () => {
    const target = { method: 'delete', path: '/a', operationId: 'read', tags: ['A'] };
    const pattern = parseFilterPattern('operationId:delete*');
    expect(matchesOperation(pattern, target)).toBe(false);
    target.operationId = 'deleteAll';
    expect(matchesOperation(pattern, target)).toBe(true);
    target.tags.push('Orders');
    expect(matchesOperation(parseFilterPattern('tag:orders'), target)).toBe(true);
    target.path = '/orders';
    expect(matchesOperation(parseFilterPattern('path:/orders'), target)).toBe(true);
  });

  // Review of #45: a suggestion is itself a pattern the parser accepts
  it('suggests only values whose full selector fits the pattern limit', () => {
    // `operationId:` plus 244 characters is exactly the 256-character limit
    const pattern = `operationId:${'a'.repeat(244)}`;
    const fits = `${'a'.repeat(243)}b`;
    const [dead] = decide([record('get', '/a', fits)], [pattern]).deadPatterns;
    expect(dead?.suggestion).toBe(`operationId:${fits}`);
    expect(() => parseFilterPattern(dead?.suggestion ?? '')).not.toThrow();
    const tooLong = `${'a'.repeat(244)}b`;
    const [none] = decide([record('get', '/a', tooLong)], [pattern]).deadPatterns;
    expect(none?.suggestion).toBeUndefined();
  });

  it('counts lowering against the match budget', () => {
    const budget = createMatchBudget(10);
    expect(() =>
      matchesOperation(
        parseFilterPattern('operationId:x'),
        record('get', '/a', 'y'.repeat(50)),
        budget,
      ),
    ).toThrow(/work budget/u);
  });
});

describe('case collisions (issue #42)', () => {
  const operations = [
    record('get', '/orders/export', 'exportOrders', ['Orders']),
    record('get', '/Orders/export', 'ExportOrders', ['orders']),
    record('delete', '/orders/{id}', 'deleteOrder', ['Orders']),
  ];

  it('names values that differ only by case, per pattern and flag', () => {
    const { caseCollisions } = decide(
      operations,
      ['path:/orders/**', 'operationId:exportorders', 'tag:orders', 'method:get'],
      ['route:GET /orders/export'],
    );
    expect(caseCollisions).toEqual([
      {
        raw: 'path:/orders/**',
        flag: 'allow',
        values: ['/orders/export', '/Orders/export'],
        operations: ['GET /orders/export', 'GET /Orders/export'],
      },
      {
        raw: 'operationId:exportorders',
        flag: 'allow',
        values: ['exportOrders', 'ExportOrders'],
        operations: ['GET /orders/export', 'GET /Orders/export'],
      },
      {
        raw: 'tag:orders',
        flag: 'allow',
        values: ['Orders', 'orders'],
        operations: ['GET /orders/export', 'DELETE /orders/{id}', 'GET /Orders/export'],
      },
      {
        raw: 'route:GET /orders/export',
        flag: 'deny',
        values: ['/orders/export', '/Orders/export'],
        operations: ['GET /orders/export', 'GET /Orders/export'],
      },
    ]);
  });

  // Review of #45: ignoring case adds nothing to a pattern that takes every
  // spelling as written too
  it('does not report a pattern that matches every spelling case-sensitively too', () => {
    expect(decide(operations, ['path:/**', 'operationId:*', 'tag:*']).caseCollisions).toEqual([]);
    expect(decide(operations, ['path:/*rders/export']).caseCollisions).toEqual([]);
    expect(decide(operations, ['path:/orders/*']).caseCollisions).toHaveLength(1);
  });

  it('does not report one spelling shared by many operations, or another method', () => {
    const shared = [
      record('get', '/orders', 'listOrders', ['Orders']),
      record('post', '/orders', 'createOrder', ['Orders']),
    ];
    expect(decide(shared, ['tag:Orders', 'path:/orders']).caseCollisions).toEqual([]);
    expect(decide(operations, ['route:DELETE /orders/**']).caseCollisions).toEqual([]);
  });
});

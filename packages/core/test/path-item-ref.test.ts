import { describe, expect, it } from 'vitest';
import { normalizeSpec, SPEC_BUDGETS } from '../src/index.ts';
import { operationKeysOf } from '../src/spec/pending-candidate.ts';
import { resolvePathItem } from '../src/spec/path-item.ts';

// Issue #40: a Path Item with a `$ref` may declare fields next to it. They
// used to disappear without a trace, because only the `$ref` was followed.

const ok = { '200': { description: 'ok' } };
const op = (operationId: string): Record<string, unknown> => ({ operationId, responses: ok });

const documentWith = (
  paths: Record<string, unknown>,
  pathItems: Record<string, unknown>,
): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths,
  components: { pathItems },
});

const summary = (document: Record<string, unknown>) => {
  const spec = normalizeSpec(document, '3.1');
  return {
    operations: spec.operations.map(
      (operation) => `${operation.method} ${operation.operationId ?? ''}`,
    ),
    omitted: spec.omitted.map((omission) => `${omission.method} ${omission.reason}`),
  };
};

describe('Path Item $ref with sibling fields', () => {
  it('keeps the operations declared next to the $ref', () => {
    const document = documentWith(
      { '/orders': { $ref: '#/components/pathItems/Orders', post: op('createOrder') } },
      { Orders: { get: op('listOrders') } },
    );
    expect(summary(document)).toEqual({
      operations: ['get listOrders', 'post createOrder'],
      omitted: [],
    });
    // A pending candidate sees both as present, so neither is withheld
    expect([...operationKeysOf(document)]).toEqual(['GET /orders', 'POST /orders']);
  });

  it('omits an operation declared on both sides, with a reason', () => {
    const document = documentWith(
      {
        '/orders': {
          $ref: '#/components/pathItems/Orders',
          get: op('localList'),
          post: op('createOrder'),
        },
      },
      { Orders: { get: op('listOrders') } },
    );
    expect(summary(document)).toEqual({
      operations: ['post createOrder'],
      omitted: ['GET declared both in the Path Item and in its $ref'],
    });
    // Present, though omitted: a candidate does not read it as removed
    expect([...operationKeysOf(document)]).toEqual(['GET /orders', 'POST /orders']);
  });

  it('omits every operation when parameters or servers are declared on both sides', () => {
    for (const field of ['parameters', 'servers']) {
      const value = field === 'servers' ? [{ url: 'https://api.example.test' }] : [];
      const document = documentWith(
        {
          '/orders': {
            $ref: '#/components/pathItems/Orders',
            [field]: value,
            post: op('createOrder'),
          },
        },
        { Orders: { [field]: value, get: op('listOrders') } },
      );
      const reason = `the Path Item and its $ref both declare "${field}"`;
      expect(summary(document)).toEqual({
        operations: [],
        omitted: [`GET ${reason}`, `POST ${reason}`],
      });
    }
  });

  it('uses path parameters declared on either side', () => {
    const parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
    const document = documentWith(
      {
        '/orders/{id}': {
          $ref: '#/components/pathItems/Order',
          parameters,
          delete: op('deleteOrder'),
        },
      },
      { Order: { get: op('getOrder') } },
    );
    const spec = normalizeSpec(document, '3.1');
    expect(spec.operations.map((operation) => operation.parameters.length)).toEqual([1, 1]);
  });

  it('merges additionalOperations by method and omits a method declared twice', () => {
    const document = {
      ...documentWith(
        {
          '/orders': {
            $ref: '#/components/pathItems/Orders',
            additionalOperations: { LINK: op('linkLocal'), COPY: op('copyOrders') },
          },
        },
        { Orders: { additionalOperations: { LINK: op('linkOrders') } } },
      ),
      openapi: '3.2.0',
    };
    const spec = normalizeSpec(document, '3.2');
    expect(spec.operations.map((operation) => operation.operationId)).toEqual(['copyOrders']);
    expect(spec.omitted).toEqual([
      {
        method: 'LINK',
        path: '/orders',
        reason: 'declared both in the Path Item and in its $ref',
        operationId: 'linkOrders',
      },
    ]);
  });

  it('follows a chain of $refs and keeps the siblings of each level', () => {
    const document = documentWith(
      { '/orders': { $ref: '#/components/pathItems/A', put: op('replaceOrders') } },
      {
        A: { $ref: '#/components/pathItems/B', post: op('createOrder') },
        B: { get: op('listOrders') },
      },
    );
    expect(summary(document).operations).toEqual([
      'get listOrders',
      'put replaceOrders',
      'post createOrder',
    ]);
  });

  it('keeps the local fields of a cyclic or dangling $ref, and the local summary', () => {
    const document = documentWith(
      {
        '/orders': { $ref: '#/components/pathItems/A', summary: 'local', post: op('createOrder') },
      },
      { A: { $ref: '#/components/pathItems/A', summary: 'shared' } },
    );
    const view = resolvePathItem(
      document,
      (document['paths'] as Record<string, unknown>)['/orders'],
    );
    expect(view.item).toMatchObject({ summary: 'local', post: op('createOrder') });
    expect(view.conflicts.size).toBe(0);
    expect(resolvePathItem(document, 'not an object')).toEqual({
      item: undefined,
      conflicts: new Set(),
    });
  });

  // Review of #40: a partial Path Item would lose the `servers` further down
  it('omits every operation when the $ref chain is too deep or does not resolve', () => {
    const depth = SPEC_BUDGETS.maxRefDepth + 2;
    const pathItems: Record<string, unknown> = {
      [`P${String(depth)}`]: { servers: [{ url: 'https://other.example.test' }] },
    };
    for (let level = depth - 1; level >= 0; level -= 1) {
      pathItems[`P${String(level)}`] = {
        $ref: `#/components/pathItems/P${String(level + 1)}`,
        ...(level === 1 ? { get: op('listOrders') } : {}),
      };
    }
    const deep = documentWith({ '/orders': { $ref: '#/components/pathItems/P0' } }, pathItems);
    const reason = 'its Path Item $ref chain is too deep or does not resolve';
    expect(summary(deep)).toEqual({ operations: [], omitted: [`GET ${reason}`] });
    const dangling = documentWith(
      { '/orders': { $ref: '#/components/pathItems/Missing', post: op('createOrder') } },
      {},
    );
    expect(summary(dangling)).toEqual({ operations: [], omitted: [`POST ${reason}`] });
    // A target that exists but is no object counts the same
    const notAnObject = documentWith(
      { '/orders': { $ref: '#/info/title', post: op('createOrder') } },
      {},
    );
    expect(summary(notAnObject)).toEqual({ operations: [], omitted: [`POST ${reason}`] });
  });

  it('keeps a __proto__ key as data', () => {
    const local = JSON.parse(
      '{"$ref":"#/components/pathItems/A","__proto__":{"polluted":true}}',
    ) as unknown;
    const document = documentWith({ '/orders': local }, { A: { get: op('listOrders') } });
    const { item } = resolvePathItem(document, local);
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

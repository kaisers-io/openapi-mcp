import { describe, expect, it } from 'vitest';
import { buildTools, deriveOutputSchema, SYSTEM_HEADERS } from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';

const op = (
  method: NamedOperation['operation']['method'],
  params: { name: string; type?: string }[],
  responseHeaders?: Record<string, unknown>,
): NamedOperation => ({
  toolName: 'listThings',
  operation: {
    method,
    path: '/things',
    tags: [],
    deprecated: false,
    parameters: params.map(({ name, type }) => ({
      name,
      in: 'query',
      schema: { type: type ?? 'string' },
    })),
    responses: {
      '200': {
        description: 'ok',
        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
        content: { 'application/json': { schema: { type: 'array' } } },
      },
    },
  },
});

const planOf = (named: NamedOperation) =>
  buildTools([named], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }).tools[0]
    ?.pagination;

describe('detectPagination (via buildTools)', () => {
  it.each([
    'cursor',
    'page_token',
    'pageToken',
    'after',
    'starting_after',
    'page',
    'offset',
    'limit',
    'per_page',
    'page_size',
    'pageSize',
  ])('treats a GET with a %s query parameter as paginated', (name) => {
    expect(planOf(op('get', [{ name }]))).toBeDefined();
  });

  it('treats a GET that declares a Link response header as paginated', () => {
    expect(planOf(op('get', [{ name: 'q' }], { Link: { schema: { type: 'string' } } }))).toEqual({
      query: { q: { field: 'q', numeric: false } },
      carried: [],
      bodyCursors: [],
    });
  });

  it('is off for an ordinary GET and for every non-GET', () => {
    expect(planOf(op('get', [{ name: 'q' }]))).toBeUndefined();
    expect(planOf(op('post', [{ name: 'page' }]))).toBeUndefined();
    expect(planOf(op('delete', [{ name: 'cursor' }]))).toBeUndefined();
  });

  it('records numeric fields and the applicable body-cursor rules', () => {
    const plan = planOf(
      op('get', [
        { name: 'cursor' },
        { name: 'limit', type: 'integer' },
        { name: 'starting_after' },
      ]),
    );
    expect(plan?.query['limit']).toEqual({ field: 'limit', numeric: true });
    expect(plan?.bodyCursors.map((rule) => rule.property)).toEqual(['next_cursor', 'nextCursor']);
    expect(plan?.startingAfter).toEqual({ field: 'starting_after', numeric: false });
  });

  it('adds the optional pagination property to the output schema only when asked', () => {
    const { operation } = op('get', [{ name: 'page' }]);
    const plain = JSON.stringify(deriveOutputSchema(operation, '3.1'));
    const paged = JSON.stringify(deriveOutputSchema(operation, '3.1', { pagination: true }));
    expect(plain).not.toContain('pagination');
    expect(paged).toContain('"pagination"');
  });
});

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
  it.each(['cursor', 'page_token', 'pageToken', 'after', 'starting_after', 'page'])(
    'treats a GET with a %s query parameter as paginated',
    (name) => {
      expect(planOf(op('get', [{ name }]))).toBeDefined();
    },
  );

  // Size/position controls alone: no hint could ever be derived (no Link
  // header, no body cursor), so `next` would always be null.
  it.each(['limit', 'offset', 'per_page', 'page_size', 'pageSize'])(
    'does not treat a GET with only a %s query parameter as paginated',
    (name) => {
      expect(planOf(op('get', [{ name, type: 'integer' }]))).toBeUndefined();
    },
  );

  it('treats a GET that declares a Link response header as paginated', () => {
    expect(planOf(op('get', [{ name: 'q' }], { Link: { schema: { type: 'string' } } }))).toEqual({
      query: { q: { field: 'q', kind: 'string' } },
      carried: [],
      bodyCursors: [],
    });
  });

  it('is off for an ordinary GET and for every non-GET', () => {
    expect(planOf(op('get', [{ name: 'q' }]))).toBeUndefined();
    expect(planOf(op('post', [{ name: 'page' }]))).toBeUndefined();
    expect(planOf(op('delete', [{ name: 'cursor' }]))).toBeUndefined();
  });

  it('records field kinds and the applicable body-cursor rules', () => {
    const plan = planOf(
      op('get', [
        { name: 'cursor' },
        { name: 'limit', type: 'integer' },
        { name: 'starting_after' },
        { name: 'archived', type: 'boolean' },
        { name: 'filter', type: 'object' },
      ]),
    );
    expect(plan?.query['limit']).toEqual({ field: 'limit', kind: 'number' });
    expect(plan?.query['archived']).toEqual({ field: 'archived', kind: 'boolean' });
    expect(plan?.query['filter']).toEqual({ field: 'filter', kind: 'unsupported' });
    expect(plan?.bodyCursors.map((rule) => rule.property)).toEqual(['next_cursor', 'nextCursor']);
    expect(plan?.startingAfter).toEqual({ field: 'starting_after', kind: 'string' });
  });

  it('adds the optional pagination property to the output schema only when asked', () => {
    const { operation } = op('get', [{ name: 'page' }]);
    const plain = JSON.stringify(deriveOutputSchema(operation, '3.1'));
    const paged = JSON.stringify(deriveOutputSchema(operation, '3.1', { pagination: true }));
    expect(plain).not.toContain('pagination');
    expect(paged).toContain('"pagination"');
  });
});

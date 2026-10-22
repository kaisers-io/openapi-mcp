import { describe, expect, it } from 'vitest';
import { buildTools, deriveOutputSchema, SYSTEM_HEADERS } from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';
import { isJsonApiResponse } from '../src/toolgen/pagination-links.ts';

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

  // JSON:API body `links.next` is read only where the spec declares that
  // shape: the JSON:API media type, or a schema with `links.next`.
  const withContent = (content: Record<string, unknown>): NamedOperation => {
    const base = op('get', [{ name: 'page' }]);
    return {
      ...base,
      operation: { ...base.operation, responses: { '200': { description: 'ok', content } } },
    };
  };

  const JSON_API = 'application/vnd.api+json';
  const linksNext = { type: 'object', properties: { next: { type: 'string' } } };

  it.each([
    ['the JSON:API media type', { [JSON_API]: { schema: { type: 'object' } } }, JSON_API],
    [
      'the JSON:API media type with parameters',
      { [`${JSON_API}; ext="https://jsonapi.org/ext/atomic"`]: {} },
      JSON_API,
    ],
    [
      'a schema declaring links.next',
      {
        'application/json': {
          schema: { type: 'object', properties: { links: linksNext } },
        },
      },
      'application/json',
    ],
    [
      'a document composed with allOf',
      {
        'application/json': {
          schema: {
            allOf: [
              { properties: { data: { type: 'array' } } },
              { properties: { links: linksNext } },
            ],
          },
        },
      },
      'application/json',
    ],
    [
      'a links object composed with allOf',
      {
        'application/json': {
          schema: {
            properties: {
              links: { allOf: [{ properties: { self: {} } }, { properties: { next: {} } }] },
            },
          },
        },
      },
      'application/json',
    ],
  ])('reads JSON:API links.next for %s', (_label, content, essence) => {
    expect(planOf(withContent(content))?.jsonApiLinks).toEqual({ '200': [essence] });
  });

  it('records the JSON:API branches per response, not for the whole operation', () => {
    const base = withContent({ 'application/json': { schema: { type: 'object' } } });
    const mixed: NamedOperation = {
      ...base,
      operation: {
        ...base.operation,
        responses: {
          ...base.operation.responses,
          '2xx': { description: 'other', content: { [JSON_API]: {} } },
        },
      },
    };
    const branches = planOf(mixed)?.jsonApiLinks;
    expect(branches).toEqual({ '200': [], '2XX': [JSON_API] });
    if (branches === undefined) {
      return;
    }
    // The exact code documents a 200, so its plain JSON is never JSON:API;
    // a 206 falls under the range.
    expect(isJsonApiResponse(branches, 200, JSON_API)).toBe(false);
    expect(isJsonApiResponse(branches, 206, `${JSON_API}; charset=utf-8`)).toBe(true);
    expect(isJsonApiResponse(branches, 206, 'application/json')).toBe(false);
    expect(isJsonApiResponse(branches, 206)).toBe(false);
    expect(isJsonApiResponse(branches, 304, JSON_API)).toBe(false);
  });

  it.each([
    ['plain JSON', { 'application/json': { schema: { type: 'object' } } }],
    [
      'a links object without next',
      {
        'application/json': {
          schema: {
            type: 'object',
            properties: { links: { type: 'object', properties: { self: { type: 'string' } } } },
          },
        },
      },
    ],
  ])('does not read links.next for %s', (_label, content) => {
    expect(planOf(withContent(content))?.jsonApiLinks).toBeUndefined();
  });
});

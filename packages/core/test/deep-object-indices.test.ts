import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  buildRequest,
  buildTools,
  paramFields,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation, OperationRecord, OutboundBudgets } from '../src/index.ts';
import { deepObjectPairs } from '../src/server/execute/deep-object.ts';

// Issues #95 and #96: deepObject values OpenAPI does not define (nested
// objects, arrays, scalars) are sent as `name[a][0]=value` only under
// --deep-object-indices, in the query and in a form body with a deepObject
// encoding. One level of scalars in a form body works without it, as
// OpenAPI defines. Every expectation is written by hand.

const budgets: OutboundBudgets = {
  maxUrlLength: 8192,
  maxHeaderBytes: 16_384,
  maxBodyBytes: 65_536,
};
const LONE_SURROGATE = String.fromCodePoint(0xd8_00);

const op = (extra: Partial<OperationRecord>): OperationRecord => ({
  method: 'get',
  path: '/items',
  tags: [],
  deprecated: false,
  parameters: [],
  responses: {},
  ...extra,
});

// Stripe's `expand` and `created`
const EXPAND = {
  name: 'expand',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: { type: 'array', items: { type: 'string' } },
};
const CREATED = {
  name: 'created',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: {
    anyOf: [
      { type: 'integer' },
      { type: 'object', properties: { gte: { type: 'integer' }, lt: { type: 'integer' } } },
    ],
  },
};
const COLOR = {
  name: 'color',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: { type: 'object', properties: { R: { type: 'integer' } } },
};
const DEEP = { style: 'deepObject', explode: true };

const formOperation = (
  properties: Record<string, unknown>,
  encoding: Record<string, unknown>,
  media: Record<string, unknown> = {},
  contentType = 'application/x-www-form-urlencoded',
): OperationRecord =>
  op({
    method: 'post',
    requestBody: {
      required: true,
      content: {
        [contentType]: {
          schema: { type: 'object', properties, additionalProperties: false },
          encoding,
          ...media,
        },
      },
    },
  });

// A Stripe-like write: a map, a nested object, an array of objects, and a
// value that is an object or the empty string that clears it
const CUSTOMER = formOperation(
  {
    description: { type: 'string' },
    metadata: {
      anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { enum: [''] }],
    },
    address: {
      type: 'object',
      properties: { city: { type: 'string' }, geo: { type: 'object', properties: { lat: {} } } },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { price: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
    tags: { type: 'object', properties: { team: { type: 'string' } } },
  },
  { metadata: DEEP, address: DEEP, items: DEEP, tags: DEEP },
);

const layout = (operation: OperationRecord, deepIndices: boolean) => {
  const result = buildLayout(operation, new Set(), '3.1', false, undefined, false, deepIndices);
  if (!('ok' in result)) {
    throw new Error(result.unrepresentable);
  }
  return result.ok;
};

const unrepresentable = (operation: OperationRecord, deepIndices: boolean): string => {
  const result = buildLayout(operation, new Set(), '3.1', false, undefined, false, deepIndices);
  if ('ok' in result) {
    throw new Error('expected the operation to be omitted');
  }
  return result.unrepresentable;
};

const send = (operation: OperationRecord, data: Record<string, unknown>) => {
  const { mapper } = layout(operation, true);
  return buildRequest(mapper, operation.method, operation.path, data, budgets);
};

const sent = (operation: OperationRecord, data: Record<string, unknown>) => {
  const result = send(operation, data);
  if (!('ok' in result)) {
    throw new Error(result.error);
  }
  return {
    query: result.ok.query,
    body: result.ok.body === undefined ? undefined : new TextDecoder().decode(result.ok.body),
  };
};

const refused = (operation: OperationRecord, data: Record<string, unknown>): string => {
  const result = send(operation, data);
  if ('ok' in result) {
    throw new Error('expected the request to be refused');
  }
  return result.error;
};

describe('deepObjectPairs', () => {
  it('flattens nested objects and arrays by the indices convention', () => {
    expect(deepObjectPairs('a', { b: { c: 1 }, d: [true, { e: 'x' }] }, true)).toStrictEqual({
      ok: [
        { path: ['b', 'c'], value: '1' },
        { path: ['d', '0'], value: 'true' },
        { path: ['d', '1', 'e'], value: 'x' },
      ],
    });
    expect(deepObjectPairs('a', 'x', true)).toStrictEqual({ ok: [{ path: [], value: 'x' }] });
  });

  it('without the convention takes only an object of scalars', () => {
    expect(deepObjectPairs('a', { b: 1 }, false)).toStrictEqual({
      ok: [{ path: ['b'], value: '1' }],
    });
    expect(deepObjectPairs('a', {}, false)).toStrictEqual({ ok: [] });
    expect(deepObjectPairs('a', { b: { c: 1 } }, false)).toStrictEqual({
      error: '"a" (deepObject) must be an object of scalar values',
    });
    expect(deepObjectPairs('a', ['b'], false)).toStrictEqual({
      error: '"a" (deepObject) must be an object',
    });
    expect(deepObjectPairs('a', { b: null }, false)).toStrictEqual({
      error: '"a[b]" is null, which cannot be sent: leave it out',
    });
  });

  const REFUSED: readonly (readonly [string, unknown, string])[] = [
    ['null', { b: [null] }, '"a[b][0]" is null, which cannot be sent: leave it out'],
    ['an empty array', { b: [] }, '"a[b]" is an empty array, which cannot be sent: leave it out'],
    ['an empty object', [{}], '"a[0]" is an empty object, which cannot be sent: leave it out'],
    ...['', 'x[y', 'x]', `x${LONE_SURROGATE}`].map(
      (key) =>
        [
          `the key ${JSON.stringify(key)}`,
          { [key]: 1 },
          '"a" has a key that is empty, contains "[" or "]", or cannot be encoded',
        ] as const,
    ),
    ['a lone surrogate', { b: LONE_SURROGATE }, '"a[b]" could not be encoded'],
  ];

  it.each(REFUSED)('refuses %s', (_title, value, error) => {
    expect(deepObjectPairs('a', value, true)).toStrictEqual({ error });
  });

  it('refuses a value nested deeper than 32 levels', () => {
    let value: unknown = 1;
    for (let level = 0; level < 33; level += 1) {
      value = [value];
    }
    expect(deepObjectPairs('a', value, true)).toStrictEqual({
      error: '"a" nests deeper than 32 levels',
    });
  });
});

describe('a deepObject query parameter under --deep-object-indices', () => {
  it('omits the operation without the opt-in, as before', () => {
    expect(unrepresentable(op({ parameters: [EXPAND] }), false)).toBe(
      'parameter "expand": deepObject requires an object of scalar values',
    );
    expect(unrepresentable(op({ parameters: [CREATED] }), false)).toBe(
      'parameter "created": deepObject requires an object of scalar values',
    );
  });

  it('sends every deepObject value by the convention, one level of scalars too', () => {
    const { mapper } = layout(op({ parameters: [EXPAND, CREATED, COLOR] }), true);
    expect(mapper.fields).toStrictEqual({
      expand: {
        destination: 'query',
        wireName: 'expand',
        style: 'deepObject',
        explode: true,
        required: false,
        indices: true,
      },
      created: {
        destination: 'query',
        wireName: 'created',
        style: 'deepObject',
        explode: true,
        required: false,
        indices: true,
      },
      color: {
        destination: 'query',
        wireName: 'color',
        style: 'deepObject',
        explode: true,
        required: false,
        indices: true,
      },
    });
    // Without the opt-in, one level of scalars as before
    expect(layout(op({ parameters: [COLOR] }), false).mapper.fields['color']).toStrictEqual({
      destination: 'query',
      wireName: 'color',
      style: 'deepObject',
      explode: true,
      required: false,
    });
  });

  it("sends a free-form object's nested values", () => {
    const filter = { name: 'filter', in: 'query', ...DEEP, schema: { type: 'object' } };
    expect(sent(op({ parameters: [filter] }), { filter: { a: { b: 1 } } }).query).toBe(
      'filter%5Ba%5D%5Bb%5D=1',
    );
  });

  it('still needs explode: true', () => {
    expect(unrepresentable(op({ parameters: [{ ...EXPAND, explode: false }] }), true)).toBe(
      'parameter "expand": deepObject requires explode: true',
    );
  });

  it('sends arrays, scalars and objects with encoded brackets and leaves', () => {
    const operation = op({ parameters: [EXPAND, CREATED] });
    expect(sent(operation, { expand: ['customer', 'a&b=c ü'], created: 5 }).query).toBe(
      'expand%5B0%5D=customer&expand%5B1%5D=a%26b%3Dc%20%C3%BC&created=5',
    );
    expect(sent(operation, { created: { gte: 1, lt: 2 } }).query).toBe(
      'created%5Bgte%5D=1&created%5Blt%5D=2',
    );
  });

  it('refuses what it cannot send, naming the parameter', () => {
    const operation = op({ parameters: [EXPAND] });
    expect(refused(operation, { expand: [] })).toBe(
      'query parameter "expand" is an empty array, which cannot be sent: leave it out',
    );
    expect(refused(operation, { expand: [LONE_SURROGATE] })).toBe(
      'query parameter "expand[0]" could not be encoded',
    );
  });

  it('cannot leave out a parameter whose key it could send at any depth', () => {
    // A header-only style, so this server cannot send it
    const nested = { name: 'expand[a][b]', in: 'query', style: 'matrix', schema: {} };
    expect(
      paramFields(op({ parameters: [EXPAND, nested] }), new Set(), '3.1', true, true),
    ).toStrictEqual({
      unrepresentable:
        'parameter "expand[a][b]" cannot be left out: the query parameter "expand" could send it',
    });
    // Without the opt-in, one level of scalars sends only `color[R]`
    const deeper = { ...nested, name: 'color[a][b]' };
    const kept = paramFields(op({ parameters: [COLOR, deeper] }), new Set(), '3.1', true, false);
    expect('ok' in kept && kept.leftOut.map((parameter) => parameter.name)).toStrictEqual([
      'color[a][b]',
    ]);
  });

  it('counts a number as any index, as qs compacts a sparse array', () => {
    const left = { name: 'a[0][secret]', in: 'query', style: 'matrix', schema: {} };
    const sender = { ...EXPAND, name: 'a[1]' };
    expect(
      paramFields(op({ parameters: [sender, left] }), new Set(), '3.1', true, true),
    ).toStrictEqual({
      unrepresentable:
        'parameter "a[0][secret]" cannot be left out: the query parameter "a[1]" could send it',
    });
    // Without the opt-in too: `a[1]=x` alone is read as `a[0]`
    const scalar = { name: 'a[1]', in: 'query', schema: { type: 'string' } };
    const zero = { ...left, name: 'a[0]' };
    expect(paramFields(op({ parameters: [scalar, zero] }), new Set(), '3.1', true)).toStrictEqual({
      unrepresentable:
        'parameter "a[0]" cannot be left out: the query parameter "a[1]" could send it',
    });
    // A number is no key: `a[1]=x` does not set `a[status]`
    const status = { ...left, name: 'a[status]' };
    const kept = paramFields(op({ parameters: [scalar, status] }), new Set(), '3.1', true);
    expect('ok' in kept && kept.leftOut.map((parameter) => parameter.name)).toStrictEqual([
      'a[status]',
    ]);
  });
});

describe('a form body with a deepObject encoding', () => {
  it('takes one level of scalars without the opt-in, as OpenAPI defines', () => {
    const operation = formOperation(
      { tags: { type: 'object', properties: { team: { type: 'string' } } } },
      {
        tags: DEEP,
      },
    );
    const { mapper } = layout(operation, false);
    expect(mapper.fields['tags']).toStrictEqual({
      destination: 'body',
      bodyPath: ['tags'],
      required: false,
      deepObject: 'defined',
    });
    const result = buildRequest(mapper, 'post', '/items', { tags: { team: 'a b' } }, budgets);
    expect('ok' in result && new TextDecoder().decode(result.ok.body)).toBe('tags%5Bteam%5D=a+b');
  });

  it('omits nested values without the opt-in', () => {
    expect(unrepresentable(CUSTOMER, false)).toBe(
      'body property "metadata": deepObject requires an object of scalar values',
    );
  });

  it('sends a nested write by the indices convention', () => {
    expect(
      sent(CUSTOMER, {
        description: 'x y',
        metadata: { order_id: '6735' },
        address: { city: 'Berlin', geo: { lat: 52.5 } },
        items: [{ price: 'price_1', quantity: 2 }, { price: 'price_2' }],
        tags: { team: 'ü' },
      }).body,
    ).toBe(
      [
        'description=x+y',
        'metadata%5Border_id%5D=6735',
        'address%5Bcity%5D=Berlin',
        'address%5Bgeo%5D%5Blat%5D=52.5',
        'items%5B0%5D%5Bprice%5D=price_1',
        'items%5B0%5D%5Bquantity%5D=2',
        'items%5B1%5D%5Bprice%5D=price_2',
        'tags%5Bteam%5D=%C3%BC',
      ].join('&'),
    );
    // The empty string clears a value
    expect(sent(CUSTOMER, { metadata: '' }).body).toBe('metadata=');
  });

  it('refuses what it cannot send, naming the field', () => {
    expect(refused(CUSTOMER, { items: [{ price: null }] })).toBe(
      'body field "items[0][price]" is null, which cannot be sent: leave it out',
    );
    expect(refused(CUSTOMER, { metadata: { 'a]': 'b' } })).toBe(
      'body field "metadata" has a key that is empty, contains "[" or "]", or cannot be encoded',
    );
  });

  const UNSUPPORTED: readonly (readonly [string, Record<string, unknown>])[] = [
    ['another style', { tags: { style: 'form', explode: true } }],
    ['explode: false', { tags: { style: 'deepObject', explode: false } }],
    ['a content type', { tags: { ...DEEP, contentType: 'application/json' } }],
    ['headers', { tags: { ...DEEP, headers: {} } }],
    ['allowReserved', { tags: { ...DEEP, allowReserved: true } }],
    ['an undeclared property', { other: DEEP }],
  ];

  it.each(UNSUPPORTED)('omits %s', (_title, encoding) => {
    const operation = formOperation({ tags: { type: 'object' } }, encoding);
    expect(unrepresentable(operation, true)).toBe(
      `the request body encoding of "${Object.keys(encoding)[0] ?? ''}" is not supported: only style: deepObject with explode: true on a declared property`,
    );
  });

  it('omits a multipart encoding and the OAS 3.2 positional encodings', () => {
    const tags = { tags: { type: 'string' } };
    expect(
      unrepresentable(formOperation(tags, { tags: DEEP }, {}, 'multipart/form-data'), true),
    ).toBe('a request body encoding object is not supported');
    expect(unrepresentable(formOperation(tags, {}, { prefixEncoding: [DEEP] }), true)).toBe(
      'a request body encoding object is not supported',
    );
    expect(unrepresentable(formOperation(tags, {}, { itemEncoding: DEEP }), true)).toBe(
      'a request body encoding object is not supported',
    );
  });

  it('omits property names a bracket-parsing server reads as one key', () => {
    const tags = { type: 'object', properties: { team: {} } };
    expect(unrepresentable(formOperation({ 'a.b': {}, a_b: {}, tags }, { tags: DEEP }), true)).toBe(
      'body property "a_b" cannot be told apart from "a.b" in a form body with a deepObject encoding',
    );
    // A readOnly property is no tool input, but `a.b` would still set it
    expect(
      unrepresentable(
        formOperation({ 'a.b': {}, a_b: { readOnly: true }, tags }, { tags: DEEP }),
        true,
      ),
    ).toBe(
      'body property "a_b" cannot be told apart from "a.b" in a form body with a deepObject encoding',
    );
    // An empty or ill-formed name: `[x]=hi`, or U+FFFD in place of the name
    for (const name of ['', String.fromCodePoint(0xd8_00)]) {
      expect(unrepresentable(formOperation({ [name]: tags }, { [name]: DEEP }), true)).toBe(
        'a body property name is empty or cannot be encoded in a form body with a deepObject encoding',
      );
      expect(unrepresentable(formOperation({ [name]: tags }, { [name]: DEEP }), false)).toBe(
        'a body property name is empty or cannot be encoded in a form body with a deepObject encoding',
      );
    }
    expect(unrepresentable(formOperation({ 'tags[x]': {}, tags }, { tags: DEEP }), true)).toBe(
      'body property "tags[x]" cannot be told apart from nesting in a form body with a deepObject encoding',
    );
  });
});

describe('an operation omitted for a deepObject value', () => {
  const named = (operation: OperationRecord): NamedOperation => ({
    toolName: 'listItems',
    operation,
  });

  it('says --deep-object-indices would build it, and builds it with the opt-in', () => {
    const operations = [named(op({ parameters: [CREATED] }))];
    const without = buildTools(operations, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    expect(without.omitted).toStrictEqual([
      {
        method: 'GET',
        path: '/items',
        reason: 'parameter "created": deepObject requires an object of scalar values',
        toolName: 'listItems',
        omittableParameters: ['created'],
        buildsWithDeepObjectIndices: true,
      },
    ]);
    const built = buildTools(operations, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
      deepObjectIndices: new Set(['listItems']),
    });
    expect(built.tools.map((tool) => tool.toolName)).toStrictEqual(['listItems']);
    expect(built.omitted).toStrictEqual([]);
  });
});

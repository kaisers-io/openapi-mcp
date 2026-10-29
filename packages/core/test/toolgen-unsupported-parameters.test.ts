import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  buildRequest,
  buildTools,
  composeDescription,
  paramFields,
  parseFilterPatterns,
  selectUnsupportedParameterOptIn,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation, OperationRecord } from '../src/index.ts';
import { nextPageHint } from '../src/toolgen/pagination.ts';

// Issue #67: an optional query or header parameter this server cannot send
// is left out of the tool, instead of omitting the operation, only when the
// operator opts in (--omit-unsupported-parameters). Every expectation is
// written by hand.

const op = (
  parameters: readonly Record<string, unknown>[],
  responses: Record<string, unknown> = {},
): OperationRecord => ({
  method: 'get',
  path: '/items',
  tags: [],
  deprecated: false,
  parameters,
  responses,
});

// Stripe's `expand`: a deepObject over an array, which OpenAPI leaves undefined
const expand = (extra: Record<string, unknown> = {}) => ({
  name: 'expand',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: { type: 'array', items: { type: 'string' } },
  ...extra,
});
const EXPAND = expand();
const limit = { name: 'limit', in: 'query', schema: { type: 'integer' } };
const EXPAND_REASON = 'parameter "expand": deepObject requires an object of scalar values';

const fieldsOf = (result: ReturnType<typeof paramFields>) => {
  if (!('ok' in result)) {
    throw new Error(result.unrepresentable);
  }
  return result;
};

describe('paramFields with optional parameters left out', () => {
  it('omits the operation without the opt-in, as before', () => {
    expect(paramFields(op([limit, EXPAND]), new Set())).toStrictEqual({
      unrepresentable: EXPAND_REASON,
    });
  });

  it('leaves out an optional query parameter it cannot send, with its reason', () => {
    const result = fieldsOf(paramFields(op([limit, EXPAND]), new Set(), '3.1', true));
    expect(result.ok.map((field) => field.name)).toStrictEqual(['limit']);
    expect(result.leftOut).toStrictEqual([{ name: 'expand', in: 'query', reason: EXPAND_REASON }]);
  });

  it.each([
    [
      'allowReserved',
      { name: 'q', in: 'query', allowReserved: true, schema: { type: 'string' } },
      'parameter "q" uses allowReserved, which is not supported',
    ],
    [
      'content instead of schema',
      { name: 'q', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
      'parameter "q" uses content instead of schema',
    ],
    [
      'an unsupported query style',
      { name: 'q', in: 'query', style: 'matrix', schema: { type: 'string' } },
      'parameter "q" uses the unsupported style "matrix"',
    ],
    [
      'an unsupported header style',
      { name: 'x-q', in: 'header', style: 'form', schema: { type: 'string' } },
      'parameter "x-q" uses the unsupported style "form"',
    ],
    [
      'deepObject with explode: false',
      {
        name: 'q',
        in: 'query',
        style: 'deepObject',
        explode: false,
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
      'parameter "q": deepObject requires explode: true',
    ],
    [
      'a nested deepObject',
      {
        name: 'q',
        in: 'query',
        style: 'deepObject',
        explode: true,
        schema: { type: 'object', properties: { a: { type: 'object' } } },
      },
      'parameter "q": deepObject requires an object of scalar values',
    ],
  ])('leaves out an optional parameter with %s', (_name, parameter, reason) => {
    const result = fieldsOf(paramFields(op([limit, parameter]), new Set(), '3.1', true));
    expect(result.ok.map((field) => field.name)).toStrictEqual(['limit']);
    expect(result.leftOut).toStrictEqual([{ name: parameter.name, in: parameter.in, reason }]);
  });

  it('leaves out an optional parameter whose schema cannot be converted', () => {
    const result = fieldsOf(
      paramFields(
        op([{ name: 'q', in: 'query', schema: { type: 'string', enum: ['a'], maxLength: 2 } }]),
        new Set(),
        '3.1',
        true,
      ),
    );
    expect(result.ok).toStrictEqual([]);
    expect(result.leftOut).toHaveLength(1);
    expect(result.leftOut[0]).toMatchObject({ name: 'q', in: 'query' });
  });

  it.each([
    ['a required query parameter', [expand({ required: true })], EXPAND_REASON],
    [
      'a path parameter',
      [{ name: 'id', in: 'path', required: true, style: 'matrix', schema: { type: 'string' } }],
      'parameter "id" uses the unsupported style "matrix"',
    ],
    [
      // The meta-schema requires `required: true` on a path parameter; the
      // guard does not rely on it
      'a path parameter not marked required',
      [{ name: 'id', in: 'path', style: 'matrix', schema: { type: 'string' } }],
      'parameter "id" uses the unsupported style "matrix"',
    ],
    [
      'a required header',
      [{ name: 'x-q', in: 'header', required: true, style: 'form', schema: { type: 'string' } }],
      'parameter "x-q" uses the unsupported style "form"',
    ],
    [
      'a parameter in an unsupported location',
      [{ name: 'c', in: 'cookie', schema: { type: 'string' } }],
      'a parameter with an unsupported location',
    ],
  ])('still omits the operation for %s', (_name, parameters, reason) => {
    expect(paramFields(op(parameters), new Set(), '3.1', true)).toStrictEqual({
      unrepresentable: reason,
    });
  });

  it('still omits the operation for a reserved header it cannot validate', () => {
    // An operator-configured header is sent whatever the tool takes: its
    // declaration must stay valid
    const header = { name: 'X-Api-Key', in: 'header', style: 'form', schema: { type: 'string' } };
    expect(paramFields(op([header]), new Set(['x-api-key']), '3.1', true)).toStrictEqual({
      unrepresentable: 'parameter "X-Api-Key" uses the unsupported style "form"',
    });
  });

  it.each([
    'Accept-Language',
    'user-agent',
    'Accept-Encoding',
    'Sec-Fetch-Mode',
    'Cache-Control',
    'Pragma',
  ])('still omits the operation for a %s header, which the HTTP client sends anyway', (name) => {
    const header = {
      name,
      in: 'header',
      content: { 'application/json': { schema: { type: 'object' } } },
    };
    expect(paramFields(op([header]), new Set(), '3.1', true)).toStrictEqual({
      unrepresentable: `parameter "${name}" uses content instead of schema`,
    });
  });

  it.each([
    ['the left-out header first', ['bad', 'good'], 'X-Mode'],
    ['the left-out header second', ['good', 'bad'], 'x-mode'],
  ])('omits two headers differing only by case, %s', (_name, order, second) => {
    const headers = {
      good: { name: 'X-Mode', in: 'header', schema: { type: 'string' } },
      bad: { name: 'x-mode', in: 'header', style: 'form', schema: { type: 'string' } },
    } as const;
    const parameters = order.map((key) => headers[key as keyof typeof headers]);
    const result = paramFields(op(parameters), new Set(), '3.1', true);
    expect(result).toStrictEqual({
      unrepresentable: `duplicate header parameter "${second}" (case-insensitive)`,
    });
  });

  it.each([
    ['a free-form object', { type: 'object' }],
    ['an object with properties', { type: 'object', properties: { expand: { type: 'string' } } }],
    ['an object of anything', {}],
  ])(
    'omits the operation when a kept exploded form %s could send the left-out name',
    (_name, schema) => {
      const filter = { name: 'filter', in: 'query', schema };
      expect(paramFields(op([filter, EXPAND]), new Set(), '3.1', true)).toStrictEqual({
        unrepresentable:
          'parameter "expand" cannot be left out: the query parameter "filter" could send it',
      });
    },
  );

  // A server reads `name[...]` as part of `name`, and some bind names
  // without letter case (reviews of #67)
  const filterObject = {
    name: 'filter',
    in: 'query',
    style: 'deepObject',
    explode: true,
    schema: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
  };
  const unsendable = (name: string) => ({ ...EXPAND, name });
  const withLeftOut = (kept: Record<string, unknown>, leftOutName: string) =>
    paramFields(op([kept, unsendable(leftOutName)]), new Set(), '3.1', true);

  it.each([
    ['a deepObject that sends its property as the name', filterObject, 'filter[dryRun]'],
    ['a deepObject that sends any property as the name', filterObject, 'filter[other]'],
    [
      'a name that a server reads as part of it',
      { name: 'expand[]', in: 'query', schema: { type: 'string' } },
      'expand',
    ],
    [
      'the same name in another letter case',
      { name: 'Expand', in: 'query', schema: { type: 'string' } },
      'expand',
    ],
    [
      'a deepObject whose keys a server reads as part of it',
      { ...filterObject, name: 'expand[x]' },
      'expand',
    ],
  ])('omits the operation when %s', (_name, kept, leftOutName) => {
    expect(withLeftOut(kept, leftOutName)).toStrictEqual({
      unrepresentable: `parameter "${leftOutName}" cannot be left out: the query parameter "${kept.name}" could send it`,
    });
  });

  // PHP turns spaces and dots in a name into `_`, drops leading spaces,
  // turns an unclosed `[` into `_`, and ignores text after the last `]`
  const scalar = (name: string) => ({ name, in: 'query', schema: { type: 'boolean' } });

  it.each([
    ['a dot', scalar('dry.run'), 'dry_run'],
    ['a space', scalar('dry run'), 'dry_run'],
    ['a dot in the left-out name', scalar('dry_run'), 'dry.run'],
    ['a leading space', scalar(' dry_run'), 'dry_run'],
    ['an unclosed bracket', scalar('dry[run'), 'dry_run'],
    ['text after the brackets', scalar('filter[dryRun]suffix'), 'filter[dryRun]'],
    ['text after the brackets of the left-out name', scalar('filter[dryRun]'), 'filter[dryRun]x'],
    ['a dot before the brackets', { ...filterObject, name: 'fil.ter' }, 'fil_ter[dryRun]'],
    ['an append and an index', scalar('ids[]'), 'ids[0]'],
  ])('omits the operation for a PHP alias with %s, in either order', (_name, kept, leftOutName) => {
    const unrepresentable = `parameter "${leftOutName}" cannot be left out: the query parameter "${kept.name}" could send it`;
    const left = unsendable(leftOutName);
    for (const parameters of [
      [kept, left],
      [left, kept],
    ]) {
      expect(paramFields(op(parameters), new Set(), '3.1', true)).toStrictEqual({
        unrepresentable,
      });
    }
  });

  it.each([
    ['a dot inside the brackets', scalar('filter[dry.run]'), 'filter[dry_run]'],
    ['another index', scalar('filter[a]'), 'filter[b]'],
    ['a name deeper than the kept one', scalar('filter'), 'filter[dryRun]'],
  ])('keeps %s next to a left-out parameter', (_name, kept, leftOutName) => {
    const result = fieldsOf(withLeftOut(kept, leftOutName));
    expect(result.leftOut.map((entry) => entry.name)).toStrictEqual([leftOutName]);
  });

  it.each([
    ['a deepObject with another name', filterObject, 'expand'],
    // Request.ts refuses a property with brackets, so `filter[a][b]` is never sent
    ['a deepObject and a nested name below it', filterObject, 'filter[a][b]'],
    [
      'a name that only starts the same',
      { name: 'expanded', in: 'query', schema: { type: 'string' } },
      'expand',
    ],
  ])('keeps %s next to a left-out parameter', (_name, kept, leftOutName) => {
    const result = fieldsOf(withLeftOut(kept, leftOutName));
    expect(result.leftOut.map((entry) => entry.name)).toStrictEqual([leftOutName]);
  });

  it.each([
    ['a scalar', { name: 'q', in: 'query', schema: { type: 'string' } }],
    [
      'an array of scalars',
      { name: 'q', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
    ],
    [
      'a deepObject object',
      {
        name: 'q',
        in: 'query',
        style: 'deepObject',
        explode: true,
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ],
    [
      'a form object with explode: false',
      { name: 'q', in: 'query', explode: false, schema: { type: 'object' } },
    ],
  ])('keeps %s next to a left-out parameter', (_name, parameter) => {
    const result = fieldsOf(paramFields(op([parameter, EXPAND]), new Set(), '3.1', true));
    expect(result.ok.map((field) => field.name)).toStrictEqual(['q']);
    expect(result.leftOut.map((entry) => entry.name)).toStrictEqual(['expand']);
  });

  it('keeps an exploded object when only a header is left out', () => {
    const result = fieldsOf(
      paramFields(
        op([
          { name: 'filter', in: 'query', schema: { type: 'object' } },
          { name: 'x-q', in: 'header', style: 'form', schema: { type: 'string' } },
        ]),
        new Set(),
        '3.1',
        true,
      ),
    );
    expect(result.ok.map((field) => field.name)).toStrictEqual(['filter']);
    expect(result.leftOut.map((entry) => entry.name)).toStrictEqual(['x-q']);
  });
});

describe('a tool built without its left-out parameters', () => {
  const layoutOf = (operation: OperationRecord) => {
    const result = buildLayout(operation, new Set(), '3.1', false, undefined, true);
    if (!('ok' in result)) {
      throw new Error(result.unrepresentable);
    }
    return result.ok;
  };
  const budgets = { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 };

  it('refuses the left-out name as an argument and never sends it', () => {
    const layout = layoutOf(op([limit, EXPAND]));
    expect(layout.leftOut.map((entry) => entry.name)).toStrictEqual(['expand']);
    expect(layout.inputSchema.safeParse({ limit: 2, expand: ['customer'] }).success).toBe(false);
    expect(layout.inputSchema.safeParse({ limit: 2 }).success).toBe(true);
    expect(buildRequest(layout.mapper, 'get', '/items', { limit: 2 }, budgets)).toMatchObject({
      ok: { query: 'limit=2' },
    });
  });

  it('gives the name to another field that a collision would have prefixed', () => {
    // The body's `expand` keeps its own name: the left-out query parameter
    // takes no part in the collision handling
    const operation: OperationRecord = {
      ...op([expand()]),
      method: 'post',
      requestBody: {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { expand: { type: 'string' } } },
          },
        },
      },
    };
    const layout = layoutOf(operation);
    expect(layout.mapper.fields).toStrictEqual({
      expand: { destination: 'body', bodyPath: ['expand'], required: false },
    });
    expect(buildRequest(layout.mapper, 'post', '/items', { expand: 'x' }, budgets)).toMatchObject({
      ok: { query: '' },
    });
  });

  it('gives no next page from a link that needs a left-out parameter', () => {
    const [tool] = buildTools(
      [
        {
          toolName: 'listItems',
          operation: op([{ ...limit, name: 'cursor', schema: { type: 'string' } }, expand()], {
            '200': { description: 'ok', headers: { Link: { schema: { type: 'string' } } } },
          }),
        },
      ],
      {
        reservedHeaders: SYSTEM_HEADERS,
        openapiVersion: '3.1',
        omitUnsupportedParameters: new Set(['listItems']),
      },
    ).tools;
    const plan = tool?.pagination;
    expect(plan).toBeDefined();
    const hint = (target: string) =>
      nextPageHint(plan!, {
        links: [{ target, rels: ['next'] }],
        responseUrl: 'https://api.example.test/items',
        requestUrl: 'https://api.example.test/items',
        args: {},
      }).next;
    expect(hint('https://api.example.test/items?cursor=c2')).toStrictEqual({ cursor: 'c2' });
    // No next page rather than one that drops what the link asked for
    expect(hint('https://api.example.test/items?cursor=c2&expand%5B0%5D=x')).toBeNull();
    expect(hint('https://api.example.test/items?cursor=c2&expand=x')).toBeNull();
  });
});

describe('buildTools with --omit-unsupported-parameters', () => {
  const named = (
    toolName: string,
    parameters: readonly Record<string, unknown>[],
  ): NamedOperation => ({
    toolName,
    operation: { ...op(parameters), summary: 'List items' },
  });
  const build = (optIn: readonly string[], operations: readonly NamedOperation[]) =>
    buildTools(operations, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
      omitUnsupportedParameters: new Set(optIn),
    });

  it('names the parameters an omitted operation would leave out', () => {
    const { tools, omitted } = build([], [named('listItems', [limit, EXPAND])]);
    expect(tools).toStrictEqual([]);
    expect(omitted).toStrictEqual([
      {
        method: 'GET',
        path: '/items',
        reason: EXPAND_REASON,
        toolName: 'listItems',
        omittableParameters: ['expand'],
      },
    ]);
  });

  it('names none when the operation is omitted for another reason too', () => {
    const { omitted } = build(
      [],
      [named('listItems', [expand(), expand({ name: 'x', required: true })])],
    );
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.omittableParameters).toBeUndefined();
  });

  it('builds an opted-in tool without them, and says so in its description', () => {
    const { tools, omitted } = build(['listItems'], [named('listItems', [limit, EXPAND])]);
    expect(omitted).toStrictEqual([]);
    expect(tools[0]?.leftOutParameters).toStrictEqual([
      { name: 'expand', in: 'query', reason: EXPAND_REASON },
    ]);
    expect(tools[0]?.description).toBe('[Parameters not available here: expand.] List items');
    expect(Object.keys(tools[0]?.wireSchema['properties'] ?? {})).toStrictEqual(['limit']);
  });

  it('leaves a tool that is not opted in as it was', () => {
    const { tools, omitted } = build(['other'], [named('listItems', [limit, EXPAND])]);
    expect(tools).toStrictEqual([]);
    expect(omitted).toHaveLength(1);
  });

  it('builds a tool that sends every parameter exactly as before', () => {
    const [plain] = build([], [named('listItems', [limit])]).tools;
    const [optedIn] = build(['listItems'], [named('listItems', [limit])]).tools;
    expect(optedIn?.leftOutParameters).toBeUndefined();
    expect(optedIn?.description).toBe(plain?.description);
    expect(optedIn?.wireSchema).toStrictEqual(plain?.wireSchema);
  });
});

describe('the description note', () => {
  it('names a few parameters, bounded and sanitized', () => {
    const names = Array.from({ length: 10 }, (_, index) => ({ name: `p${String(index)}` }));
    expect(composeDescription(op([]), undefined, names)).toBe(
      '[Parameters not available here: p0, p1, p2, p3, p4, p5, p6, p7 and 2 more.]',
    );
    const hostile = composeDescription(op([]), undefined, [
      { name: `a\u001B[2J${'x'.repeat(200)}` },
    ]);
    expect(hostile).not.toContain('\u001B');
    expect(hostile.length).toBeLessThan(120);
  });
});

describe('selectUnsupportedParameterOptIn', () => {
  const operations: NamedOperation[] = [
    { toolName: 'listItems', operation: { ...op([]), tags: ['items'] } },
    { toolName: 'createItem', operation: { ...op([]), method: 'post' } },
  ];
  const spec = { operations: operations.map((entry) => entry.operation), omitted: [] };

  it('selects the matching exposed operations by tool name, per pattern', () => {
    const optIn = selectUnsupportedParameterOptIn(
      operations,
      parseFilterPatterns(['method:get', 'tag:items']),
      spec,
    );
    expect([...optIn.toolNames]).toStrictEqual(['listItems']);
    expect(optIn.matches).toStrictEqual([
      { raw: 'method:get', toolNames: ['listItems'] },
      { raw: 'tag:items', toolNames: ['listItems'] },
    ]);
    expect(optIn.deadPatterns).toStrictEqual([]);
  });

  it('reports a pattern that names no exposed operation as dead', () => {
    const optIn = selectUnsupportedParameterOptIn(
      operations.slice(0, 1),
      parseFilterPatterns(['method:post', 'operationId:nope']),
      spec,
    );
    expect(optIn.toolNames.size).toBe(0);
    expect(optIn.deadPatterns.map((dead) => [dead.raw, dead.flag, dead.notExposed])).toStrictEqual([
      ['method:post', 'omit-unsupported-parameters', true],
      ['operationId:nope', 'omit-unsupported-parameters', undefined],
    ]);
  });

  it('refuses a method the spec does not know, as the filters do', () => {
    expect(() =>
      selectUnsupportedParameterOptIn(operations, parseFilterPatterns(['method:frobnicate']), spec),
    ).toThrow(/FROBNICATE/u);
  });
});

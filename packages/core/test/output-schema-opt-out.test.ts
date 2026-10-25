import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createDispatcher,
  createMetaExecutor,
  createRedactor,
  mapResponse,
  applyOutputSchemaOptOut,
  parseFilterPattern,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type { GeneratedTool, NamedOperation, ToolCallOutcome } from '../src/index.ts';

// Issue #13: --omit-output-schema declares no output schema for the matching
// generated tools, so an API whose responses do not match its spec returns its
// result as text instead of failing every call.

const encoder = new TextEncoder();

const item = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
};

const op = (
  toolName: string,
  operation: Partial<NamedOperation['operation']> &
    Pick<NamedOperation['operation'], 'method' | 'path'>,
): NamedOperation => ({
  toolName,
  operation: {
    operationId: toolName,
    tags: [],
    deprecated: false,
    parameters: operation.path.includes('{id}')
      ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
      : [],
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: item } } } },
    ...operation,
  },
});

const OPERATIONS: readonly NamedOperation[] = [
  op('getItem', { method: 'get', path: '/items/{id}', tags: ['items'] }),
  op('listItems', { method: 'get', path: '/items', tags: ['items'] }),
  op('getCharge', {
    method: 'get',
    path: '/charges/{id}',
    responses: {
      '200': { description: 'ok', content: { 'application/json': { schema: item } } },
      default: { description: 'error' },
    },
  }),
  op('deleteItem', {
    method: 'delete',
    path: '/items/{id}',
    responses: { '204': { description: 'no content' } },
  }),
  // Toolgen omits it: `not` cannot be represented in an input schema
  op('searchItems', {
    method: 'get',
    path: '/search',
    parameters: [{ name: 'q', in: 'query', schema: { not: {} } }],
  }),
];

const patterns = (...raw: string[]) => raw.map((pattern) => parseFilterPattern(pattern));
// The cookie operation stands for one normalization omitted: only its method
// and path are kept
const spec = {
  operations: OPERATIONS.map(({ operation }) => operation),
  omitted: [
    { method: 'GET', path: '/items/{id}/cookie', reason: 'cookie parameter' },
    { method: 'SEARCH', path: '/items', reason: 'servers override' },
    { method: 'link', path: '/items', reason: 'not upper case' },
  ],
};

const generate = (
  operations: readonly NamedOperation[],
  extra: { nullable?: boolean; defaultIsError?: boolean } = {},
): readonly GeneratedTool[] =>
  buildTools(operations, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    ...(extra.nullable === true ? { nullableResponseFields: 'all' as const } : {}),
    ...(extra.defaultIsError === true ? { defaultResponseIsError: true } : {}),
  }).tools;

const optOut = (omit: readonly string[], tools = generate(OPERATIONS)) =>
  applyOutputSchemaOptOut(tools, patterns(...omit), spec);

const build = (omit: readonly string[], extra: { nullable?: boolean; defaultIsError?: boolean }) =>
  optOut(omit, generate(OPERATIONS, extra)).tools;

const byName = (tools: readonly GeneratedTool[], name: string): GeneratedTool => {
  const found = tools.find((tool) => tool.toolName === name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
};

describe('applyOutputSchemaOptOut — selection', () => {
  it('selects the generated tools any pattern matches, in the --allow grammar', () => {
    const select = (...raw: string[]) =>
      optOut(raw)
        .tools.filter((tool) => tool.outputSchemaOptedOut === true)
        .map((tool) => tool.toolName)
        .toSorted();
    expect(select('operationId:getItem')).toEqual(['getItem']);
    expect(select('route:GET /items/*')).toEqual(['getItem']);
    expect(select('tag:items')).toEqual(['getItem', 'listItems']);
    // A tool without an output schema matches but has nothing to opt out of
    expect(select('operationId:get*', 'route:DELETE /items/{id}')).toEqual(['getItem']);
    expect(select()).toEqual([]);
  });

  it('reports a pattern dead only when it matches no generated tool', () => {
    // Overlapping patterns: the second one matches too, so it is not dead
    expect(optOut(['operationId:get*', 'operationId:getItem']).deadPatterns).toEqual([]);
    expect(optOut(['operationId:getIte']).deadPatterns).toEqual([
      { raw: 'operationId:getIte', flag: 'omit-output-schema', suggestion: 'operationId:getItem' },
    ]);
    // An operation the filters leave out does not count
    const filtered = generate(OPERATIONS.filter(({ toolName }) => toolName !== 'getCharge'));
    expect(optOut(['operationId:getCharge'], filtered).deadPatterns).toMatchObject([
      { raw: 'operationId:getCharge' },
    ]);
  });

  // Review of #13: a closest match would point at an unrelated tool here
  // (getItem for getCharge), while the reason is that it is not exposed
  it('says a dead pattern names an operation that is not exposed, without a suggestion', () => {
    const filtered = generate(OPERATIONS.filter(({ toolName }) => toolName !== 'getItem'));
    expect(optOut(['operationId:getItem'], filtered).deadPatterns).toEqual([
      { raw: 'operationId:getItem', flag: 'omit-output-schema', notExposed: true },
    ]);
    // An operation normalization omitted is known by method and path only
    expect(optOut(['route:GET /items/*/cookie']).deadPatterns).toEqual([
      { raw: 'route:GET /items/*/cookie', flag: 'omit-output-schema', notExposed: true },
    ]);
    // Also for a method only an omitted OpenAPI 3.2 operation declares
    expect(optOut(['route:SEARCH /items']).deadPatterns).toEqual([
      { raw: 'route:SEARCH /items', flag: 'omit-output-schema', notExposed: true },
    ]);
    // A pattern naming nothing in the spec keeps its suggestion
    expect(optOut(['operationId:listItem'], filtered).deadPatterns).toEqual([
      {
        raw: 'operationId:listItem',
        flag: 'omit-output-schema',
        suggestion: 'operationId:listItems',
      },
    ]);
  });

  // Review of #13: such a pattern changes nothing, which should not be silent
  it('reports a pattern that matches only tools without an output schema', () => {
    expect(
      optOut(['operationId:deleteItem', 'operationId:getCharge', 'operationId:getItem'])
        .ineffectivePatterns,
    ).toEqual(['operationId:deleteItem', 'operationId:getCharge']);
    // One matched tool with a schema is enough to make it effective
    expect(optOut(['tag:items', 'operationId:*Item']).ineffectivePatterns).toEqual([]);
  });

  // Review of #13: matching before toolgen counted an operation that never
  // becomes a tool, so --strict-filters let such a pattern through
  it('reports a pattern dead when it matches only an operation toolgen omits', () => {
    expect(generate(OPERATIONS).map((tool) => tool.toolName)).not.toContain('searchItems');
    expect(optOut(['operationId:searchItems']).deadPatterns).toMatchObject([
      { raw: 'operationId:searchItems' },
    ]);
    expect(optOut(['route:GET /search']).deadPatterns).toMatchObject([
      { raw: 'route:GET /search' },
    ]);
  });

  it('rejects a method that is neither standard nor declared by the spec', () => {
    expect(() => optOut(['route:FOO /items'])).toThrow(
      /names FOO, which is not a standard method/u,
    );
    // `link` was omitted as not upper case, so it declares no LINK method
    expect(() => optOut(['route:LINK /items'])).toThrow(
      /names LINK, which is not a standard method/u,
    );
  });

  it('returns the tools unchanged without patterns', () => {
    const tools = generate(OPERATIONS);
    expect(optOut([], tools)).toEqual({
      tools,
      deadPatterns: [],
      ineffectivePatterns: [],
      caseCollisions: [],
    });
  });
});

describe('applyOutputSchemaOptOut — the opted-out tools', () => {
  it('drops the output schema of the matching tool only and marks it', () => {
    const strict = build([], {});
    const optedOut = build(['operationId:getItem'], {});
    const tool = byName(optedOut, 'getItem');
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.outputSchemaOptedOut).toBe(true);
    // The description does not depend on the opt-out
    expect(tool.description).toBe(byName(strict, 'getItem').description);
    // Every other tool is built exactly as without the option
    for (const name of ['listItems', 'getCharge', 'deleteItem']) {
      expect(byName(optedOut, name)).toEqual(byName(strict, name));
    }
  });

  it('does not mark a tool that has no output schema anyway', () => {
    const tools = build(['operationId:deleteItem', 'operationId:getCharge'], {});
    expect(byName(tools, 'deleteItem').outputSchemaOptedOut).toBeUndefined();
    // GetCharge documents `default`, so it has no schema without the flag
    expect(byName(tools, 'getCharge').outputSchemaOptedOut).toBeUndefined();
  });

  it('clears the markers of the schema it drops', () => {
    const widened = build(['operationId:getItem', 'operationId:getCharge'], {
      nullable: true,
      defaultIsError: true,
    });
    for (const name of ['getItem', 'getCharge']) {
      const tool = byName(widened, name);
      expect(tool.outputSchemaOptedOut).toBe(true);
      expect(tool.outputSchemaAdmitsNullFields).toBeUndefined();
      expect(tool.outputSchemaAssumesDefaultIsError).toBeUndefined();
    }
    expect(byName(widened, 'listItems').outputSchemaAdmitsNullFields).toBe(true);
  });
});

describe('mapResponse for an opted-out tool', () => {
  const respond = (tool: GeneratedTool, body: string, secret?: string): ToolCallOutcome =>
    mapResponse({
      outcome: {
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyBytes: encoder.encode(body),
        headers: {},
        url: 'https://api.example.test/items/1',
      },
      outputSchema: tool.outputSchema,
      validator: compileEnvelopeValidator(tool.outputSchema),
      redactor: createRedactor(secret === undefined ? [] : [secret]),
      maxTextBytes: 64,
    });
  const strict = byName(build([], {}), 'getItem');
  const optedOut = byName(build(['operationId:getItem'], {}), 'getItem');

  it('returns a body that does not match the spec as text instead of failing', () => {
    const mismatch = '{"id":"abc-123","name":"thing"}';
    expect(respond(strict, mismatch).isError).toBe(true);
    for (const body of [mismatch, '[1,2]', '"just a string"', '42']) {
      const outcome = respond(optedOut, body);
      expect(outcome).toEqual({ content: [{ type: 'text', text: body }], isError: false });
      expect(outcome.structuredContent).toBeUndefined();
    }
  });

  it('keeps the secret scan and the size cap', () => {
    // The secret appears only escaped in the raw body
    const secret = 'example/token-not-a-secret';
    const withheld = respond(optedOut, '{"id":"example\\/token-not-a-secret"}', secret);
    expect(withheld.isError).toBe(true);
    expect(JSON.stringify(withheld)).not.toContain('token-not-a-secret');
    const long = respond(optedOut, JSON.stringify({ id: 'x'.repeat(200) }));
    expect(long.isError).toBe(false);
    expect(encoder.encode(long.content[0]?.text).byteLength).toBeLessThanOrEqual(64 + 64);
    expect(long.content[0]?.text).not.toContain('x'.repeat(200));
  });
});

// Review of #13: without an output schema, `_fields` must still read a
// sequential body as the array of its items, as the structured path does
describe('_fields on a sequential response without an output schema', () => {
  const idItem = { type: 'object', properties: { id: { type: 'integer' } } };
  const mixed = (version: '3.1' | '3.2'): GeneratedTool => {
    const ndjson = version === '3.2' ? { itemSchema: idItem } : { schema: idItem };
    const [tool] = buildTools(
      [
        op('getMixed', {
          method: 'get',
          path: '/mixed',
          responses: {
            '200': { description: 'ok', content: { 'application/x-ndjson': ndjson } },
            '202': { description: 'ok', content: { 'application/json': { schema: idItem } } },
          },
        }),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: version, projection: true },
    ).tools;
    if (tool?.projection !== true) {
      throw new Error('expected a projectable tool');
    }
    return tool;
  };
  const project = (tool: GeneratedTool, contentType: string, body: string): ToolCallOutcome =>
    mapResponse({
      outcome: {
        kind: 'response',
        status: 200,
        contentType,
        bodyBytes: encoder.encode(body),
        headers: {},
        url: 'https://api.example.test/mixed',
      },
      outputSchema: tool.outputSchema,
      validator: compileEnvelopeValidator(tool.outputSchema),
      redactor: createRedactor([]),
      maxTextBytes: 4096,
      fields: ['/*/id'],
    });
  const textOf = (outcome: ToolCallOutcome): string => outcome.content[0]?.text ?? '';

  it('projects the items of an opted-out 3.2 tool as the structured path does', () => {
    const strict = mixed('3.2');
    const [optedOut] = applyOutputSchemaOptOut([strict], patterns('operationId:getMixed'), {
      operations: [strict.operation],
      omitted: [],
    }).tools;
    expect(optedOut?.outputSchema).toBeUndefined();
    const ndjson = 'application/x-ndjson';
    for (const [body, ids] of [
      ['{"id":1}\n{"id":2}\n', [1, 2]],
      ['{"id":1}\n', [1]],
    ] as const) {
      expect(project(strict, ndjson, body).structuredContent).toMatchObject({
        projection: { '/*/id': ids },
      });
      const outcome = project(optedOut!, ndjson, body);
      expect(outcome.isError).toBe(false);
      expect(JSON.parse(textOf(outcome))).toEqual({ '/*/id': ids });
    }
  });

  // The same path serves a 3.1 tool, which never had an output schema here
  it('projects the items of a 3.1 tool without an output schema', () => {
    const tool = mixed('3.1');
    expect(tool.outputSchema).toBeUndefined();
    const outcome = project(tool, 'application/x-ndjson', '{"id":1}\n');
    expect(JSON.parse(textOf(outcome))).toEqual({ '/*/id': [1] });
  });

  it('fails closed on a malformed sequence, and still projects plain JSON', () => {
    const tool = mixed('3.1');
    const malformed = project(tool, 'application/x-ndjson', '{"id":1}\n{"id":');
    expect(malformed.isError).toBe(true);
    expect(textOf(malformed)).toContain('was not a valid sequence of its media type');
    const json = project(tool, 'application/json', '[{"id":3}]');
    expect(JSON.parse(textOf(json))).toEqual({ '/*/id': [3] });
  });
});

describe('discover mode for an opted-out tool', () => {
  it('describe_operation shows no output schema and no withheld marker', async () => {
    const built = buildTools(OPERATIONS, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(
      { ...built, tools: optOut(['operationId:getItem'], built.tools).tools },
      {
        spec: { title: 't', specVersion: '1', omitted: [] },
        contentHash: 'h',
        displaySource: 's',
        deadPatterns: [],
      },
      { toolMode: 'discover' },
    );
    const dispatcher = createDispatcher({
      snapshot,
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => 0,
      executor: () => Promise.resolve(textOutcome('executor reached', false)),
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([]),
    });
    const { signal } = new AbortController();
    const describeOne = async (name: string) => {
      const result = await dispatcher.call({
        name: 'describe_operation',
        arguments: { name, include_output_schema: true },
        signal,
      });
      return result.kind === 'outcome' ? result.outcome.structuredContent : undefined;
    };
    const optedOut = await describeOne('getItem');
    expect(optedOut).toMatchObject({ name: 'getItem' });
    expect(optedOut).not.toHaveProperty('outputSchema');
    expect(optedOut).not.toHaveProperty('outputSchemaOmitted');
    expect(await describeOne('listItems')).toHaveProperty('outputSchema');
  });
});

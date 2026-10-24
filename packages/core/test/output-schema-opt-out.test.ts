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
const inventory = OPERATIONS.map(({ operation }) => operation);

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
  applyOutputSchemaOptOut(tools, patterns(...omit), inventory);

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
    expect(select('getItem')).toEqual(['getItem']);
    expect(select('GET /items/*')).toEqual(['getItem']);
    expect(select('tag:items')).toEqual(['getItem', 'listItems']);
    // A tool without an output schema matches but has nothing to opt out of
    expect(select('get*', 'DELETE /items/{id}')).toEqual(['getItem']);
    expect(select()).toEqual([]);
  });

  it('reports a pattern dead only when it matches no generated tool', () => {
    // Overlapping patterns: the second one matches too, so it is not dead
    expect(optOut(['get*', 'getItem']).deadPatterns).toEqual([]);
    expect(optOut(['getIte']).deadPatterns).toEqual([
      { raw: 'getIte', flag: 'omit-output-schema', suggestion: 'getItem' },
    ]);
    // An operation the filters leave out does not count
    const filtered = generate(OPERATIONS.filter(({ toolName }) => toolName !== 'getCharge'));
    expect(optOut(['getCharge'], filtered).deadPatterns).toMatchObject([{ raw: 'getCharge' }]);
  });

  // Review of #13: matching before toolgen counted an operation that never
  // becomes a tool, so --strict-filters let such a pattern through
  it('reports a pattern dead when it matches only an operation toolgen omits', () => {
    expect(generate(OPERATIONS).map((tool) => tool.toolName)).not.toContain('searchItems');
    expect(optOut(['searchItems']).deadPatterns).toMatchObject([{ raw: 'searchItems' }]);
    expect(optOut(['GET /search']).deadPatterns).toMatchObject([{ raw: 'GET /search' }]);
  });

  it('rejects a method that is neither standard nor declared by the spec', () => {
    expect(() => optOut(['FOO /items'])).toThrow(/names FOO, which is not a standard method/u);
  });

  it('returns the tools unchanged without patterns', () => {
    const tools = generate(OPERATIONS);
    expect(optOut([], tools)).toEqual({ tools, deadPatterns: [] });
  });
});

describe('applyOutputSchemaOptOut — the opted-out tools', () => {
  it('drops the output schema of the matching tool only and marks it', () => {
    const strict = build([], {});
    const optedOut = build(['getItem'], {});
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
    const tools = build(['deleteItem', 'getCharge'], {});
    expect(byName(tools, 'deleteItem').outputSchemaOptedOut).toBeUndefined();
    // GetCharge documents `default`, so it has no schema without the flag
    expect(byName(tools, 'getCharge').outputSchemaOptedOut).toBeUndefined();
  });

  it('clears the markers of the schema it drops', () => {
    const widened = build(['getItem', 'getCharge'], { nullable: true, defaultIsError: true });
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
  const optedOut = byName(build(['getItem'], {}), 'getItem');

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

describe('discover mode for an opted-out tool', () => {
  it('describe_operation shows no output schema and no withheld marker', async () => {
    const built = buildTools(OPERATIONS, {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(
      { ...built, tools: optOut(['getItem'], built.tools).tools },
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

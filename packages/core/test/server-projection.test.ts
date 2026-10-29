import { describe, expect, it } from 'vitest';
import { Response } from 'undici';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createDispatcher,
  createExecutor,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { ExecutorConfig, NamedOperation, PinnedDeps, ServerSnapshot } from '../src/index.ts';
import {
  project,
  PROJECTION_FIELDS_SCHEMA,
  PROJECTION_HINT_STRUCTURED,
  PROJECTION_HINT_TEXT,
  PROJECTION_TOO_LARGE,
} from '../src/toolgen/projection.ts';

// Per-call response projection (`_fields`) end to end: input schema,
// validate-full -> project -> scan order, outputSchema conformance, the
// no-schema path, and the truncation hint.

const SECRET = 'example-token-not-a-secret-321';

const listItems = (withSchema: boolean): NamedOperation => ({
  toolName: 'listItems',
  operation: {
    method: 'get',
    path: '/items',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: {
      // A `default` response makes the success set unbounded, so no
      // outputSchema is derived: the "no-schema" variant.
      ...(withSchema ? {} : { default: { description: 'anything' } }),
      '200': {
        description: 'ok',
        content: {
          'application/json': withSchema
            ? {
                schema: {
                  type: 'object',
                  properties: {
                    next_cursor: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { id: { type: 'string' }, blob: { type: 'string' } },
                        required: ['id'],
                      },
                    },
                  },
                  required: ['items'],
                },
              }
            : {},
        },
      },
    },
  },
});

const snapshotOf = (
  ops: readonly NamedOperation[],
  toolMode: 'per-operation' | 'discover' = 'per-operation',
): ServerSnapshot =>
  buildSnapshot(
    buildTools(ops, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1', projection: true }),
    {
      spec: { title: 't', specVersion: '1', omitted: [] },
      contentHash: 'h',
      displaySource: 's',
      deadPatterns: [],
    },
    { toolMode },
  );

const wide = (count: number, blob = 'x'.repeat(1024)) => ({
  next_cursor: 'c-2',
  items: Array.from({ length: count }, (_unused, index) => ({ id: `item-${index}`, blob })),
});

const callWith = async (
  op: NamedOperation,
  body: unknown,
  args: Record<string, unknown>,
  // Through kaisers-io/openapi-mcp-archive#144's call_operation instead of a
  // direct call.
  discover = false,
) => {
  const snapshot = snapshotOf([op], discover ? 'discover' : 'per-operation');
  const validators = new Map(
    snapshot.operations.map((tool) => [
      tool.name,
      compileEnvelopeValidator(tool.resolve().wireTool.outputSchema),
    ]),
  );
  const config: ExecutorConfig = {
    baseUrl: 'https://api.example.test',
    baseTrusted: true,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    secretHeaders: [],
    staticHeaders: [],
    reservedHeaderNames: new Set(SYSTEM_HEADERS),
    redactor: createRedactor([SECRET]),
    timeoutMs: 5000,
    maxResponseBytes: 5_000_000,
    outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
    maxConcurrent: 4,
    validators,
  };
  const fetch: PinnedDeps['fetch'] = () =>
    Promise.resolve(
      typeof body === 'string'
        ? new Response(body, { headers: { 'content-type': 'text/plain' } })
        : Response.json(body),
    );
  const executor = createExecutor(config, {
    transport: {
      fetch,
      resolve: () => Promise.reject(new Error('no DNS')),
      timeoutSignal: () => new AbortController().signal,
    },
  });
  const dispatcher = createDispatcher({
    snapshot,
    limiter: { consume: () => true, retryAfterMs: () => 0 },
    now: () => 0,
    executor,
    metaExecutor: createMetaExecutor(),
    redactor: createRedactor([SECRET]),
  });
  const result = await dispatcher.call({
    name: discover ? 'call_operation' : 'listItems',
    arguments: discover ? { name: 'listItems', arguments: args } : args,
    signal: new AbortController().signal,
  });
  if (result.kind !== 'outcome') {
    throw new Error('unexpected unknown-tool');
  }
  const tool = snapshot.operationsByName['listItems']?.resolve();
  const validate = compileEnvelopeValidator(tool?.wireTool.outputSchema);
  return { outcome: result.outcome, tool, validate };
};

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

describe('JSON Pointer projection', () => {
  const data = {
    items: [{ id: 'a', tags: ['x'] }, { id: 'b' }],
    'a/b': 1,
    'm~n': 2,
    '*': 'star',
  };

  it('selects values, maps "*" over arrays, honours ~0/~1 escapes, and yields null for missing paths', () => {
    expect(
      project(
        data,
        ['/items/*/id', '/items/1/id', '/a~1b', '/m~0n', '/*', '/nope', '/items/9'],
        bytesOf(data),
      ),
    ).toEqual({
      '/items/*/id': ['a', 'b'],
      '/items/1/id': 'b',
      '/a~1b': 1,
      '/m~0n': 2,
      '/*': 'star',
      '/nope': null,
      '/items/9': null,
    });
  });

  it('never reads inherited properties (__proto__, constructor, toString)', () => {
    expect(
      project({ a: 1 }, ['/__proto__', '/constructor', '/toString', '/a/__proto__'], 7),
    ).toEqual({
      '/__proto__': null,
      '/constructor': null,
      '/toString': null,
      '/a/__proto__': null,
    });
  });

  it('refuses a selection larger than twice the response, and keeps a large plain one', () => {
    const ids = { ids: Array.from({ length: 1000 }, () => 0) };
    const missing = Array.from({ length: 32 }, (_unused, index) => `/ids/*/k${index}`);
    expect(project(ids, missing, bytesOf(ids))).toBeUndefined();
    // Overlapping pointers repeat one subtree, without any `*`
    let nested: unknown = { leaf: 'x'.repeat(100_000) };
    for (let depth = 0; depth < 32; depth += 1) {
      nested = { a: nested };
    }
    const overlapping = Array.from({ length: 32 }, (_unused, index) => '/a'.repeat(index + 1));
    expect(project(nested, overlapping, bytesOf(nested))).toBeUndefined();
    const large = { ids: Array.from({ length: 500_000 }, () => 0) };
    const repeated = Array.from({ length: 32 }, () => '/ids');
    expect(project(large, repeated, bytesOf(large))).toEqual({ '/ids': large.ids });
  });

  it.each([
    ['an empty list', []],
    ['too many pointers', Array.from({ length: 33 }, (_unused, index) => `/f${index}`)],
    ['a pointer without the leading slash', ['items']],
    ['the empty whole-document pointer', ['']],
    ['a bad escape', ['/a~2b']],
    ['an over-long pointer', [`/${'a'.repeat(256)}`]],
    ['too many segments', [`/${Array.from({ length: 33 }, () => 'a').join('/')}`]],
  ])('rejects %s', (_label, value) => {
    expect(PROJECTION_FIELDS_SCHEMA.safeParse(value).success).toBe(false);
  });
});

describe('_fields on a tool with an outputSchema', () => {
  it('returns only the selected fields (1,000 x 1 KB items -> < 30 KB), and the result validates', async () => {
    const full = await callWith(listItems(true), wide(1000), {});
    const projected = await callWith(listItems(true), wide(1000), {
      _fields: ['/items/*/id', '/next_cursor'],
    });
    expect(projected.outcome.isError).toBe(false);
    const content = projected.outcome.structuredContent as Record<string, unknown>;
    expect(Object.keys(content).toSorted()).toEqual(['contentType', 'projection', 'status']);
    expect((content['projection'] as Record<string, unknown>)['/next_cursor']).toBe('c-2');
    expect(bytesOf(content)).toBeLessThan(30_000);
    expect(bytesOf(full.outcome.structuredContent)).toBeGreaterThan(1_000_000);
    expect(projected.validate?.(content)).toBe(true);
    expect(full.validate?.(full.outcome.structuredContent)).toBe(true);
  });

  it('leaves the output unchanged without _fields', async () => {
    const { outcome } = await callWith(listItems(true), wide(2, 'b'), {});
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: wide(2, 'b'),
    });
  });

  it('still fails upstream data that violates the spec, even when only valid fields are selected', async () => {
    const { outcome } = await callWith(
      listItems(true),
      { next_cursor: 'c', items: [{ blob: 'missing the required id' }] },
      { _fields: ['/next_cursor'] },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/did not match the tool's declared output schema/u);
  });

  it('scans only what is selected: a secret in an unselected field no longer fails the call, a selected one does', async () => {
    const leaky = wide(2, `blob with ${SECRET}`);
    const unfiltered = await callWith(listItems(true), leaky, {});
    expect(unfiltered.outcome.isError).toBe(true);
    const ids = await callWith(listItems(true), leaky, { _fields: ['/items/*/id'] });
    expect(ids.outcome.isError).toBe(false);
    expect(JSON.stringify(ids.outcome)).not.toContain(SECRET);
    const blobs = await callWith(listItems(true), leaky, { _fields: ['/items/*/blob'] });
    expect(blobs.outcome.isError).toBe(true);
    expect(JSON.stringify(blobs.outcome)).not.toContain(SECRET);
  });

  it('refuses a selection larger than twice the response before building it', async () => {
    const { outcome } = await callWith(listItems(true), wide(20_000, 'b'), {
      _fields: Array.from({ length: 32 }, (_unused, index) => `/items/*/k${index}`),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent).toBeUndefined();
    expect(outcome.content[0]?.text).toBe(PROJECTION_TOO_LARGE);
  });

  it('rejects malformed _fields with the usual redacted validation message', async () => {
    const { outcome } = await callWith(listItems(true), wide(1), { _fields: ['no-slash'] });
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/^invalid tool arguments:/u);
    expect(outcome.content[0]?.text).not.toContain('no-slash');
  });
});

describe('_fields on a tool without an outputSchema', () => {
  it('projects a JSON body before the text cap', async () => {
    const { outcome } = await callWith(listItems(false), wide(1000), {
      _fields: ['/next_cursor'],
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.content[0]?.text).toBe('{"/next_cursor":"c-2"}');
  });

  it('refuses to project a non-JSON body', async () => {
    const { outcome } = await callWith(listItems(false), 'plain text', { _fields: ['/a'] });
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toBe(
      'tool execution failed: projection requires a JSON response',
    );
  });

  it('adds a hint to a truncated result, pointing the model at _fields', async () => {
    const { outcome } = await callWith(listItems(false), wide(100), {});
    expect(outcome.content.at(-1)?.text).toBe(PROJECTION_HINT_TEXT);
    const small = await callWith(listItems(false), wide(1, 'b'), {});
    expect(small.outcome.content.map((block) => block.text)).not.toContain(PROJECTION_HINT_TEXT);
  });

  it('never suggests data loss for a structured result: only its text copy is cut', async () => {
    const { outcome } = await callWith(listItems(true), wide(100), {});
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent?.['data']).toBeDefined();
    expect(outcome.content.at(-1)?.text).toBe(PROJECTION_HINT_STRUCTURED);
    expect(PROJECTION_HINT_STRUCTURED).toContain('structuredContent has the complete result');
  });

  // Issue #49: repeating a write to see the rest of its answer could apply it twice
  it('never tells the model to call a write again, and still says what was cut', async () => {
    const createItems = (withSchema: boolean): NamedOperation => {
      const read = listItems(withSchema);
      return { ...read, operation: { ...read.operation, method: 'post' } };
    };
    const text = await callWith(createItems(false), wide(100), {});
    expect(text.outcome.content.at(-1)?.text).toBe(
      '(the response text above was truncated at the size limit)',
    );
    const structured = await callWith(createItems(true), wide(100), {});
    expect(structured.outcome.content.at(-1)?.text).toBe(
      '(only this text copy is truncated; structuredContent has the complete result)',
    );
    for (const { outcome } of [text, structured]) {
      expect(JSON.stringify(outcome.content)).not.toContain('call again');
    }
  });
});

describe('_fields availability', () => {
  it('is offered only on tools with a JSON response, as an optional input', () => {
    const tool = snapshotOf([listItems(true)]).toolsByName['listItems'];
    const schema = tool?.wireTool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties?.['_fields']).toBeDefined();
    expect(schema.required ?? []).not.toContain('_fields');
    const ping: NamedOperation = {
      toolName: 'ping',
      operation: {
        method: 'get',
        path: '/ping',
        tags: [],
        deprecated: false,
        parameters: [],
        responses: { '204': { description: 'none' } },
      },
    };
    const pingSchema = snapshotOf([ping]).toolsByName['ping']?.wireTool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(pingSchema.properties?.['_fields']).toBeUndefined();
  });

  it('is disabled (the operation kept) when the operation has its own _fields parameter', () => {
    const op = listItems(true);
    const colliding: NamedOperation = {
      ...op,
      operation: {
        ...op.operation,
        parameters: [{ name: '_fields', in: 'query', schema: { type: 'string' } }],
      },
    };
    const built = buildTools([colliding], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
      projection: true,
    });
    expect(built.tools).toHaveLength(1);
    expect(built.tools[0]?.projection).toBeUndefined();
    expect(JSON.stringify(built.tools[0]?.outputSchema)).not.toContain('projection');
  });
});

describe('_fields cost', () => {
  it('is off unless the operator enables it: no _fields, no projection branch', () => {
    const built = buildTools([listItems(true)], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    expect(built.tools[0]?.projection).toBeUndefined();
    expect(JSON.stringify(built.tools[0]?.wireSchema)).not.toContain('_fields');
    expect(JSON.stringify(built.tools[0]?.outputSchema)).not.toContain('projection');
  });

  it('adds ONE projection branch per tool, whatever the number of success branches', () => {
    const op = listItems(true);
    const ok = op.operation.responses['200'];
    const twoStatuses: NamedOperation = {
      ...op,
      operation: { ...op.operation, responses: { '200': ok, '206': ok } },
    };
    const built = buildTools([twoStatuses], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
      projection: true,
    });
    const oneOf = built.tools[0]?.outputSchema?.['oneOf'] as Record<string, unknown>[];
    expect(oneOf).toHaveLength(3);
    expect(oneOf.filter((branch) => JSON.stringify(branch).includes('projection'))).toHaveLength(1);
  });
});

describe('_fields through call_operation (discover mode)', () => {
  it('projects the response of an operation called through call_operation', async () => {
    const { outcome, validate } = await callWith(
      listItems(true),
      wide(1000),
      { _fields: ['/next_cursor'] },
      true,
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent?.['projection']).toEqual({ '/next_cursor': 'c-2' });
    expect(validate?.(outcome.structuredContent)).toBe(true);
  });

  it('rejects an invalid pointer in call_operation arguments like a direct call', async () => {
    const { outcome } = await callWith(listItems(true), wide(1), { _fields: ['no-slash'] }, true);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/^invalid tool arguments:/u);
  });
});

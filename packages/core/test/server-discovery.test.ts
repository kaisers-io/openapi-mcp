import { Response } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  applyFilters,
  AUTO_DISCOVER_THRESHOLD,
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createDispatcher,
  createExecutor,
  createMetaExecutor,
  createRedactor,
  discoverApprovalWarning,
  parseFilterPattern,
  resolveToolMode,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type {
  DispatchResult,
  EnvelopeValidator,
  NamedOperation,
  PinnedDeps,
  Redactor,
  ServerSnapshot,
  ToolCallOutcome,
  ToolExecutor,
  ToolMode,
} from '../src/index.ts';

// Discovery tool mode (issue #38). The property these tests pin above all:
// call_operation is not a second way in. It reaches exactly the operations a
// direct per-operation call reaches (the same --allow/--deny/read-only
// result), validates with the same schema and renders the same failure, and
// sends the same upstream request.

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
    parameters: [],
    responses: { '204': { description: 'no content' } },
    ...operation,
  },
});

const OPERATIONS: readonly NamedOperation[] = [
  op('listThings', {
    method: 'get',
    path: '/things',
    summary: 'List things',
    tags: ['things'],
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
      },
    },
  }),
  op('getThing', {
    method: 'get',
    path: '/things/{id}',
    summary: 'Get a thing',
    tags: ['things'],
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  }),
  op('createThingItem', {
    method: 'post',
    path: '/things/{id}/items',
    summary: 'Add an item to a thing',
    tags: ['things'],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'dryRun', in: 'query', schema: { type: 'boolean' } },
      { name: 'X-Request-Tag', in: 'header', schema: { type: 'string' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { name: { type: 'string' }, count: { type: 'integer' } },
            required: ['name'],
          },
        },
      },
    },
  }),
  op('deleteThing', {
    method: 'delete',
    path: '/things/{id}',
    summary: 'Delete a thing',
    tags: ['admin'],
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  }),
];

const PIPELINE = {
  spec: { title: 't', specVersion: '1', omitted: [] },
  contentHash: 'h',
  displaySource: 's',
  deadPatterns: [],
};

// The real filter engine and toolgen, so "excluded by a filter" means what it
// means in `serve`: the operation never becomes a built tool.
const snapshotFor = (
  toolMode: ToolMode | undefined,
  filters: { allow?: string[]; deny?: string[] } = {},
): ServerSnapshot => {
  const { exposed } = applyFilters(
    OPERATIONS,
    (filters.allow ?? []).map((raw) => parseFilterPattern(raw)),
    (filters.deny ?? []).map((raw) => parseFilterPattern(raw)),
  );
  const built = buildTools(exposed, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, PIPELINE, toolMode === undefined ? {} : { toolMode });
};

type TestLimiter = { consume: (nowMs: number) => boolean; retryAfterMs: (nowMs: number) => number };
const permit = (): TestLimiter => ({ consume: () => true, retryAfterMs: () => 0 });
const noSignal = new AbortController().signal;

const dispatcherFor = (
  snapshot: ServerSnapshot,
  overrides: {
    executor?: ToolExecutor;
    limiter?: TestLimiter;
    redactor?: Redactor;
  } = {},
) =>
  createDispatcher({
    snapshot,
    limiter: overrides.limiter ?? permit(),
    now: () => 0,
    executor: overrides.executor ?? (() => Promise.resolve(textOutcome('executor reached', false))),
    metaExecutor: createMetaExecutor(),
    redactor: overrides.redactor ?? createRedactor([]),
  });

const outcomeOf = (result: DispatchResult): ToolCallOutcome => {
  if (result.kind !== 'outcome') {
    throw new Error(`expected an outcome, got ${result.kind}`);
  }
  return result.outcome;
};

const call = (name: string, args: unknown = {}) => ({ name, arguments: args, signal: noSignal });

const textOf = (outcome: ToolCallOutcome): string =>
  outcome.content.map((block) => block.text).join('\n');

describe('resolveToolMode', () => {
  it('passes explicit modes through and switches auto above the documented threshold', () => {
    expect(AUTO_DISCOVER_THRESHOLD).toBe(64);
    expect(resolveToolMode('per-operation', 10_000)).toBe('per-operation');
    expect(resolveToolMode('discover', 1)).toBe('discover');
    expect(resolveToolMode('auto', 64)).toBe('per-operation');
    expect(resolveToolMode('auto', 65)).toBe('discover');
  });
});

describe('discoverApprovalWarning (decision D15)', () => {
  it('says nothing when every exposed operation is read-only, or outside discover', () => {
    const readOnly = snapshotFor('discover');
    expect(discoverApprovalWarning(readOnly.toolMode, readOnly.operations)).toBeUndefined();
    const perOperation = snapshotFor('per-operation', { allow: ['**'] });
    expect(discoverApprovalWarning(perOperation.toolMode, perOperation.operations)).toBeUndefined();
  });

  it('names the non-read-only operations one call_operation approval would cover', () => {
    const widened = snapshotFor('discover', { allow: ['**'] });
    expect(discoverApprovalWarning(widened.toolMode, widened.operations)).toBe(
      '--tool-mode discover exposes 2 non-read-only operation(s) (createThingItem, deleteThing) through the single call_operation tool: a host approval of call_operation covers all of them, writes included. Narrow --allow to read-only operations, or use --tool-mode per-operation to approve each operation separately',
    );
  });
});

describe('buildSnapshot — tool modes', () => {
  it('leaves the per-operation snapshot unchanged: no option and an explicit per-operation produce the same tools/list bytes', () => {
    const implicit = snapshotFor(undefined, { allow: ['**'] });
    const explicit = snapshotFor('per-operation', { allow: ['**'] });
    const wire = (snapshot: ServerSnapshot) =>
      JSON.stringify(snapshot.tools.map((tool) => tool.wireTool));
    expect(wire(explicit)).toBe(wire(implicit));
    // Sorted by name after the meta tool (#77), not in spec order.
    expect(implicit.tools.map((tool) => tool.name)).toEqual([
      'openapi_mcp_status',
      'createThingItem',
      'deleteThing',
      'getThing',
      'listThings',
    ]);
    expect(implicit.toolMode).toBe('per-operation');
    expect(implicit.searchIndex).toBeUndefined();
  });

  it('lists exactly the meta tool and the three discovery tools under discover, keeping every exposed operation behind them', () => {
    const snapshot = snapshotFor('discover', { allow: ['**'] });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      'openapi_mcp_status',
      'search_operations',
      'describe_operation',
      'call_operation',
    ]);
    expect(Object.keys(snapshot.toolsByName).toSorted()).toEqual([
      'call_operation',
      'describe_operation',
      'openapi_mcp_status',
      'search_operations',
    ]);
    expect(snapshot.operations.map((tool) => tool.name)).toEqual([
      'listThings',
      'getThing',
      'createThingItem',
      'deleteThing',
    ]);
    expect(snapshot.meta.toolCount).toBe(4);
    for (const tool of snapshot.tools) {
      expect(tool.wireTool.inputSchema['type']).toBe('object');
    }
    expect(Object.isFrozen(snapshot.searchIndex)).toBe(true);
    expect(Object.isFrozen(snapshot.operationsByName)).toBe(true);
  });

  it('gives call_operation the least safe hints among the exposed operations', () => {
    const annotationsOf = (snapshot: ServerSnapshot) =>
      snapshot.toolsByName['call_operation']?.wireTool.annotations;
    // Read-only default: only GETs are exposed.
    expect(annotationsOf(snapshotFor('discover'))).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
    // A POST (not idempotent) and a DELETE (destructive) are exposed.
    expect(annotationsOf(snapshotFor('discover', { allow: ['**'] }))).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // GETs plus a DELETE only: destructive, but every mutating op is idempotent.
    expect(annotationsOf(snapshotFor('discover', { allow: ['list*', 'get*', 'delete*'] }))).toEqual(
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    );
    for (const name of ['search_operations', 'describe_operation']) {
      expect(snapshotFor('discover').toolsByName[name]?.wireTool.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    }
  });
});

describe('dispatcher — discover mode', () => {
  it('treats an operation name as an unknown TOOL (it is not listed), without spending rate budget', async () => {
    const consume = vi.fn<(nowMs: number) => boolean>(() => true);
    const result = await dispatcherFor(snapshotFor('discover'), {
      limiter: { consume, retryAfterMs: () => 0 },
    }).call(call('listThings'));
    expect(result).toEqual({ kind: 'unknown-tool', name: 'listThings' });
    expect(consume).not.toHaveBeenCalled();
  });

  it('describe_operation returns exactly the wire tool the per-operation mode lists', async () => {
    const perOperation = snapshotFor('per-operation', { allow: ['**'] });
    const dispatcher = dispatcherFor(snapshotFor('discover', { allow: ['**'] }));
    for (const name of ['listThings', 'createThingItem', 'deleteThing']) {
      const outcome = outcomeOf(await dispatcher.call(call('describe_operation', { name })));
      expect(outcome.isError).toBe(false);
      expect(outcome.structuredContent).toEqual(perOperation.toolsByName[name]?.wireTool);
      expect(JSON.parse(textOf(outcome))).toEqual(outcome.structuredContent);
    }
  });

  it('describe_operation reports a name outside the exposed set as an unknown operation', async () => {
    const dispatcher = dispatcherFor(snapshotFor('discover'));
    const outcome = outcomeOf(
      await dispatcher.call(call('describe_operation', { name: 'deleteThing' })),
    );
    expect(outcome.isError).toBe(true);
    expect(textOf(outcome)).toBe(
      'unknown operation "deleteThing" — use search_operations to find an operation name',
    );
  });

  it.each([
    ['a write operation hidden by the read-only default', {}, 'createThingItem'],
    ['an operation excluded by --deny', { allow: ['**'], deny: ['deleteThing'] }, 'deleteThing'],
    ['an operation outside --allow', { allow: ['listThings'] }, 'getThing'],
    ['the meta tool', {}, 'openapi_mcp_status'],
    ['a discovery tool', {}, 'call_operation'],
    ['an inherited property name', {}, '__proto__'],
  ])(
    'call_operation refuses %s as an unknown operation and never reaches the executor',
    async (_label, filters, name) => {
      const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('reached', false)));
      const dispatcher = dispatcherFor(snapshotFor('discover', filters), { executor });
      const outcome = outcomeOf(
        await dispatcher.call(call('call_operation', { name, arguments: {} })),
      );
      expect(outcome.isError).toBe(true);
      expect(textOf(outcome)).toMatch(/^unknown operation "/u);
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a missing required field', { id: 'a1', body: {} }],
    ['a wrong type', { id: 'a1', name: 7 }],
    ['an unknown field', { id: 'a1', name: 'x', extra: true }],
    ['a non-object', 'not-an-object'],
  ])(
    'call_operation with %s returns the same redacted validation outcome as the direct tool',
    async (_label, args) => {
      const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('reached', false)));
      const direct = outcomeOf(
        await dispatcherFor(snapshotFor('per-operation', { allow: ['**'] }), { executor }).call(
          call('createThingItem', args),
        ),
      );
      const viaCall = outcomeOf(
        await dispatcherFor(snapshotFor('discover', { allow: ['**'] }), { executor }).call(
          call('call_operation', { name: 'createThingItem', arguments: args }),
        ),
      );
      expect(direct.isError).toBe(true);
      expect(textOf(direct)).toMatch(/^invalid tool arguments:/u);
      expect(viaCall).toEqual(direct);
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it('call_operation with arguments whose getter throws returns the same generic outcome as the direct tool', async () => {
    // A fresh object per call: the throwing getter is the caller-supplied
    // value that must never be rendered.
    const hostileArgs = (): Record<string, unknown> =>
      Object.defineProperty({ id: 'a' }, 'name', {
        enumerable: true,
        get: (): string => {
          throw new Error('example-token-not-a-secret');
        },
      });
    const directArgs = hostileArgs();
    const viaCallArgs = { name: 'createThingItem', arguments: hostileArgs() };
    const direct = outcomeOf(
      await dispatcherFor(snapshotFor('per-operation', { allow: ['**'] })).call(
        call('createThingItem', directArgs),
      ),
    );
    const viaCall = outcomeOf(
      await dispatcherFor(snapshotFor('discover', { allow: ['**'] })).call(
        call('call_operation', viaCallArgs),
      ),
    );
    expect(direct.isError).toBe(true);
    expect(viaCall).toEqual(direct);
    expect(JSON.stringify(viaCall)).not.toContain('example-token-not-a-secret');
  });

  it('call_operation without `arguments` calls a no-input operation exactly like a direct call with {}', async () => {
    const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('reached', false)));
    await dispatcherFor(snapshotFor('per-operation'), { executor }).call(call('listThings', {}));
    await dispatcherFor(snapshotFor('discover'), { executor }).call(
      call('call_operation', { name: 'listThings' }),
    );
    expect(executor).toHaveBeenCalledTimes(2);
    const [directCall, viaCall] = executor.mock.calls;
    expect(viaCall?.[0].name).toBe(directCall?.[0].name);
    expect(viaCall?.[0].generated?.operation).toEqual(directCall?.[0].generated?.operation);
    expect(viaCall?.[1]).toEqual(directCall?.[1]);
  });

  it('rejects `arguments: null` at the wire schema and at runtime, before the executor', async () => {
    // The advertised contract: arguments is an object, and only omitting it
    // means "no arguments"
    const wire = snapshotFor('discover').toolsByName['call_operation']?.wireTool.inputSchema as {
      properties: Record<string, { type?: unknown }>;
    };
    expect(wire.properties['arguments']?.type).toBe('object');
    const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('reached', false)));
    const outcome = outcomeOf(
      await dispatcherFor(snapshotFor('discover'), { executor }).call(
        call('call_operation', { name: 'listThings', arguments: null }),
      ),
    );
    expect(outcome.isError).toBe(true);
    expect(textOf(outcome)).toBe('invalid tool arguments:\narguments: invalid_type');
    expect(executor).not.toHaveBeenCalled();
  });

  it('charges the rate limiter once per call_operation call, and a refused call never reaches the executor', async () => {
    const consume = vi.fn<(nowMs: number) => boolean>(() => true);
    const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('reached', false)));
    const dispatcher = dispatcherFor(snapshotFor('discover'), {
      limiter: { consume, retryAfterMs: () => 0 },
      executor,
    });
    await dispatcher.call(call('call_operation', { name: 'listThings', arguments: {} }));
    expect(consume).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);

    consume.mockReturnValue(false);
    const refused = outcomeOf(
      await dispatcher.call(call('call_operation', { name: 'listThings', arguments: {} })),
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^rate limit exceeded/u);
    expect(executor).toHaveBeenCalledTimes(1);
    // Search and describe are charged too: they are tool calls like any other.
    await dispatcher.call(call('search_operations', { query: 'thing' }));
    await dispatcher.call(call('describe_operation', { name: 'listThings' }));
    expect(consume).toHaveBeenCalledTimes(4);
  });

  it('applies the dispatch-boundary redaction to a call_operation result', async () => {
    const SECRET = 'example-token-not-a-secret-0123456789';
    const redactor = createRedactor([SECRET]);
    const executor: ToolExecutor = () =>
      Promise.resolve(textOutcome(`upstream echoed ${SECRET}`, false));
    const direct = outcomeOf(
      await dispatcherFor(snapshotFor('per-operation'), { executor, redactor }).call(
        call('listThings', {}),
      ),
    );
    const viaCall = outcomeOf(
      await dispatcherFor(snapshotFor('discover'), { executor, redactor }).call(
        call('call_operation', { name: 'listThings', arguments: {} }),
      ),
    );
    expect(JSON.stringify(viaCall)).not.toContain(SECRET);
    expect(viaCall).toEqual(direct);
  });
});

// The real executor (request building, header assembly, the pinned transport
// wrapper, response mapping) with only `fetch` faked, so the request each
// path hands to the network can be compared byte for byte.
describe('call_operation — captured upstream request', () => {
  type Captured = { url: string; method: unknown; headers: unknown; body: string | undefined };

  const capture = async (
    snapshot: ServerSnapshot,
    request: { name: string; arguments: unknown },
  ): Promise<{ captured: Captured[]; outcome: ToolCallOutcome }> => {
    const captured: Captured[] = [];
    const fetch: PinnedDeps['fetch'] = (input, init) => {
      const options = (init ?? {}) as { method?: string; headers?: unknown; body?: unknown };
      captured.push({
        url: String(input),
        method: options.method,
        headers: options.headers,
        body:
          options.body === undefined || options.body === null
            ? undefined
            : Buffer.from(options.body as Uint8Array | string).toString('utf8'),
      });
      return Promise.resolve(Response.json([{ id: 'a1' }], { status: 200 }));
    };
    const validators = new Map<string, EnvelopeValidator | undefined>(
      snapshot.operations.map((tool) => [
        tool.name,
        compileEnvelopeValidator(tool.wireTool.outputSchema),
      ]),
    );
    const executor = createExecutor(
      {
        baseUrl: 'https://api.example.test/v1',
        baseTrusted: true,
        allowPrivateNetwork: false,
        allowInsecureHttp: false,
        secretHeaders: [
          {
            name: 'Authorization',
            value: 'Bearer example-token-not-a-secret',
            envVar: 'API_TOKEN',
          },
        ],
        staticHeaders: [{ name: 'X-Client', value: 'openapi-mcp' }],
        reservedHeaderNames: new Set(SYSTEM_HEADERS),
        redactor: createRedactor(['Bearer example-token-not-a-secret']),
        timeoutMs: 5000,
        maxResponseBytes: 65_536,
        outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
        maxConcurrent: 4,
        validators,
      },
      {
        transport: {
          fetch,
          resolve: () => Promise.reject(new Error('no DNS in this suite')),
          timeoutSignal: () => new AbortController().signal,
        },
      },
    );
    const outcome = outcomeOf(
      await dispatcherFor(snapshot, {
        executor,
        redactor: createRedactor(['Bearer example-token-not-a-secret']),
      }).call(call(request.name, request.arguments)),
    );
    return { captured, outcome };
  };

  it.each([
    [
      'a POST with path, query, header and JSON body inputs',
      'createThingItem',
      { id: 'a b', dryRun: true, 'X-Request-Tag': 'tag-1', name: 'widget', count: 3 },
    ],
    ['a GET with a query parameter and a structured response', 'listThings', { limit: 5 }],
    ['a DELETE with a path parameter', 'deleteThing', { id: 'z9' }],
  ])(
    'sends the same upstream request and returns the same result for %s',
    async (_label, name, args) => {
      const direct = await capture(snapshotFor('per-operation', { allow: ['**'] }), {
        name,
        arguments: args,
      });
      const viaCall = await capture(snapshotFor('discover', { allow: ['**'] }), {
        name: 'call_operation',
        arguments: { name, arguments: args },
      });
      expect(direct.captured).toHaveLength(1);
      expect(viaCall.captured).toEqual(direct.captured);
      expect(viaCall.outcome).toEqual(direct.outcome);
    },
  );

  it('really did send the inputs (the comparison above is not between two empty requests)', async () => {
    const { captured } = await capture(snapshotFor('discover', { allow: ['**'] }), {
      name: 'call_operation',
      arguments: {
        name: 'createThingItem',
        arguments: { id: 'a1', dryRun: true, 'X-Request-Tag': 'tag-1', name: 'widget', count: 3 },
      },
    });
    expect(captured[0]?.url).toBe('https://api.example.test/v1/things/a1/items?dryRun=true');
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.headers).toMatchObject({
      'x-request-tag': 'tag-1',
      authorization: 'Bearer example-token-not-a-secret',
      'x-client': 'openapi-mcp',
    });
    expect(JSON.parse(captured[0]?.body ?? '')).toEqual({ name: 'widget', count: 3 });
  });
});

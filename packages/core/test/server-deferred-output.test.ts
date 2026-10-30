import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  buildToolsDeferred,
  createDispatcher,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type {
  DeferredTool,
  DeferredToolsResult,
  DispatchResult,
  NamedOperation,
  ServerSnapshot,
  ToolCallOutcome,
} from '../src/index.ts';

// Issue #47: under discover, an operation's output side (output schema,
// description, output flags) is built on its first describe or call.

const customer = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
};

const OPERATIONS: readonly NamedOperation[] = [
  {
    toolName: 'getCustomer',
    operation: {
      method: 'get',
      path: '/customers/{id}',
      operationId: 'getCustomer',
      summary: 'Get a customer',
      description: 'Returns one customer.',
      tags: ['customers'],
      deprecated: false,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: customer } } },
        default: { description: 'error', content: { 'application/json': { schema: customer } } },
      },
    },
  },
  {
    toolName: 'getCode',
    operation: {
      method: 'get',
      path: '/codes',
      summary: 'A code with an unsafe pattern',
      tags: [],
      deprecated: false,
      parameters: [],
      responses: {
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', pattern: '(a+)+$' },
                  // A bidi override withholds the output schema
                  mark: { const: 'a\u202Eb' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    toolName: 'createCustomer',
    operation: {
      method: 'post',
      path: '/customers',
      summary: 'Create a customer',
      tags: ['customers'],
      deprecated: false,
      parameters: [],
      requestBody: { required: true, content: { 'application/json': { schema: customer } } },
      responses: {
        '201': { description: 'created', content: { 'application/json': { schema: customer } } },
      },
    },
  },
];

const PIPELINE = {
  spec: { title: 'Shop', specVersion: '1.0.0', omitted: [] },
  contentHash: 'accepted-hash',
  displaySource: 'https://api.example.test/openapi.json',
  deadPatterns: [],
};

const OPTION_SETS = [
  {},
  { nullableResponseFields: 'all' as const, defaultResponseIsError: true, projection: true },
];

const deferredFor = (options: (typeof OPTION_SETS)[number] = {}): DeferredToolsResult =>
  buildToolsDeferred(OPERATIONS, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    ...options,
  });

// Counts each tool's completions
const counted = (built: DeferredToolsResult) => {
  const calls = new Map<string, number>();
  const withComplete = (tool: DeferredTool, complete: DeferredTool['complete']): DeferredTool => ({
    ...tool,
    complete: () => {
      calls.set(tool.toolName, (calls.get(tool.toolName) ?? 0) + 1);
      return complete();
    },
  });
  return {
    calls,
    with: (
      replace: Partial<Record<string, DeferredTool['complete']>> = {},
    ): DeferredToolsResult => ({
      ...built,
      tools: built.tools.map((tool) =>
        withComplete(tool, replace[tool.toolName] ?? (() => tool.complete())),
      ),
    }),
  };
};

const executorSpy = () =>
  vi.fn<() => Promise<ToolCallOutcome>>(() => Promise.resolve(textOutcome('sent', false)));

const dispatcherFor = (snapshot: ServerSnapshot, executor = executorSpy()) =>
  createDispatcher({
    snapshot,
    limiter: { consume: () => true, retryAfterMs: () => 0 },
    now: () => 0,
    executor,
    metaExecutor: createMetaExecutor(),
    redactor: createRedactor([]),
  });

const outcomeOf = (result: DispatchResult): ToolCallOutcome => {
  if (result.kind !== 'outcome') {
    throw new Error(`expected an outcome, got ${result.kind}`);
  }
  return result.outcome;
};

const call = (name: string, args: unknown) => ({
  name,
  arguments: args,
  signal: new AbortController().signal,
});

describe('deferred output side under discover (#47)', () => {
  it.each(OPTION_SETS)(
    'resolves every operation to the tool an eager build gives (%o)',
    (options) => {
      const eager = buildSnapshot(
        buildTools(OPERATIONS, {
          reservedHeaders: SYSTEM_HEADERS,
          openapiVersion: '3.1',
          ...options,
        }),
        PIPELINE,
        { toolMode: 'discover' },
      );
      const lazy = buildSnapshot(deferredFor(options), PIPELINE, { toolMode: 'discover' });
      expect(lazy.operations.map((entry) => entry.name)).toEqual(
        eager.operations.map((entry) => entry.name),
      );
      for (const entry of lazy.operations) {
        const mine = entry.resolve();
        const theirs = eager.operationsByName[entry.name]?.resolve();
        expect(mine.wireTool).toStrictEqual(theirs?.wireTool);
        expect(JSON.stringify(mine.generated)).toBe(JSON.stringify(theirs?.generated));
      }
      // The fixtures reach the withheld note and, with the option, the
      // default-error flag
      expect(lazy.operationsByName['getCode']?.resolve().wireTool.description).toContain(
        'output schema',
      );
      expect(
        lazy.operationsByName['getCustomer']?.resolve().generated
          ?.outputSchemaAssumesDefaultIsError,
      ).toBe('defaultResponseIsError' in options ? true : undefined);
      expect(lazy.tools).toStrictEqual(eager.tools);
      expect(JSON.stringify(lazy.searchIndex)).toBe(JSON.stringify(eager.searchIndex));
      expect(lazy.meta).toStrictEqual(eager.meta);
    },
  );

  it('builds no output side for listing and search, and each one once on use', async () => {
    const tools = counted(deferredFor());
    const snapshot = buildSnapshot(tools.with(), PIPELINE, { toolMode: 'discover' });
    const dispatcher = dispatcherFor(snapshot);
    await dispatcher.call(call('search_operations', { query: 'customer' }));
    expect(tools.calls.size).toBe(0);
    await dispatcher.call(call('describe_operation', { name: 'getCustomer' }));
    await dispatcher.call(call('describe_operation', { name: 'getCustomer' }));
    await dispatcher.call(call('call_operation', { name: 'getCustomer', arguments: { id: '7' } }));
    expect([...tools.calls]).toEqual([['getCustomer', 1]]);
  });

  it('turns a failed build into a tool error, sends nothing, and repeats it unchanged', async () => {
    const tools = counted(deferredFor());
    const onDeferredError = vi.fn<(toolName: string, error: unknown) => void>();
    const snapshot = buildSnapshot(
      tools.with({
        createCustomer: () => {
          throw new Error('synthetic failure');
        },
      }),
      PIPELINE,
      { toolMode: 'discover', onDeferredError },
    );
    const executor = executorSpy();
    const dispatcher = dispatcherFor(snapshot, executor);
    const args = { name: 'createCustomer', arguments: { body: { id: 1 } } };
    const first = outcomeOf(await dispatcher.call(call('call_operation', args)));
    const second = outcomeOf(await dispatcher.call(call('call_operation', args)));
    const described = outcomeOf(
      await dispatcher.call(call('describe_operation', { name: 'createCustomer' })),
    );
    for (const outcome of [first, second, described]) {
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0]?.text).toBe(
        'operation "createCustomer" is unavailable: its definition could not be built',
      );
      expect(outcome.meta?.['openapi-mcp/effect']).toBe('not_sent');
    }
    expect(executor).not.toHaveBeenCalled();
    expect(tools.calls.get('createCustomer')).toBe(1);
    expect(onDeferredError).toHaveBeenCalledTimes(1);
    expect(onDeferredError).toHaveBeenCalledWith('createCustomer', expect.any(Error));
    // The other operations are unaffected
    const other = outcomeOf(
      await dispatcher.call(call('describe_operation', { name: 'getCustomer' })),
    );
    expect(other.isError).toBe(false);
  });

  it('checks the output schema root on first use', async () => {
    const built = deferredFor();
    const getCode = built.tools.find((tool) => tool.toolName === 'getCode') as DeferredTool;
    const snapshot = buildSnapshot(
      counted(built).with({
        getCode: () => ({ ...getCode.complete(), outputSchema: { type: 'array' } }),
      }),
      PIPELINE,
      { toolMode: 'discover' },
    );
    const outcome = outcomeOf(
      await dispatcherFor(snapshot).call(call('describe_operation', { name: 'getCode' })),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.meta?.['openapi-mcp/effect']).toBe('not_sent');
  });

  it('freezes what a deferred build reads, so a later change by the caller cannot alter it', () => {
    const built = deferredFor();
    buildSnapshot(built, PIPELINE, { toolMode: 'discover' });
    const [first] = built.tools;
    expect(Object.isFrozen(first?.operation.responses)).toBe(true);
    expect(Object.isFrozen(first?.wireSchema)).toBe(true);
  });

  // Review: `complete` hands every caller the same object
  it('keeps a resolved tool unchanged by anyone who completed the same tool', () => {
    const built = deferredFor();
    const snapshot = buildSnapshot(built, PIPELINE, { toolMode: 'discover' });
    const completed = built.tools.find((tool) => tool.toolName === 'createCustomer')?.complete();
    expect(() => {
      Object.assign(completed ?? {}, { outputSchema: undefined, description: 'changed' });
    }).toThrow(TypeError);
    const tool = snapshot.operationsByName['createCustomer']?.resolve();
    expect(tool?.wireTool.outputSchema).toBeDefined();
    expect(tool?.wireTool.description).not.toBe('changed');
  });

  it('builds every tool at once under per-operation', () => {
    const tools = counted(deferredFor());
    buildSnapshot(tools.with(), PIPELINE, { toolMode: 'per-operation' });
    expect([...tools.calls.values()]).toEqual([1, 1, 1]);
  });
});

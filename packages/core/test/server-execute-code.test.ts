import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  buildSnapshot,
  buildTools,
  createDispatcher,
  createMetaExecutor,
  createRedactor,
  BOUNDARY_WITHHELD_READ_TEXT,
  EXECUTE_TOOL_NAME,
  parseFilterPattern,
  structuredOutcome,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import { SCRIPT_LIMITS } from '../src/server/code/run.ts';
import type {
  CallRecord,
  DispatchResult,
  NamedOperation,
  ServerSnapshot,
  ToolCallOutcome,
  ToolExecutor,
  ToolMode,
} from '../src/index.ts';

// The execute_code tool (issue #60) must not be weaker than call_operation: each
// api.call() of a script is a whole call_operation call through the
// dispatcher, so the filters, validation, the rate limit, the final
// redaction and the call log apply to every one; and a script can call
// read-only operations only.

const SECRET = 'example-token-not-a-secret';

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
    responses: { '200': { description: 'ok' } },
    ...operation,
  },
});

const OPERATIONS: readonly NamedOperation[] = [
  op('listThings', { method: 'get', path: '/things' }),
  op('getThing', {
    method: 'get',
    path: '/things/{id}',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  }),
  op('createThing', { method: 'post', path: '/things' }),
  op('deleteThing', {
    method: 'delete',
    path: '/things/{id}',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  }),
];

const snapshotFor = (
  toolMode: ToolMode,
  execute: boolean,
  allow: string[] = [],
  deny: string[] = [],
): ServerSnapshot => {
  const { exposed } = applyFilters(
    OPERATIONS,
    allow.map((raw) => parseFilterPattern(raw)),
    deny.map((raw) => parseFilterPattern(raw)),
  );
  const built = buildTools(exposed, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(
    built,
    {
      spec: { title: 't', specVersion: '1', omitted: [] },
      contentHash: 'h',
      displaySource: 's',
      deadPatterns: [],
    },
    { toolMode, execute },
  );
};

const envelope = (data: unknown): ToolCallOutcome => {
  const value = { status: 200, contentType: 'application/json', data };
  return structuredOutcome(JSON.stringify(value), value);
};

const setup = (
  options: {
    snapshot?: ServerSnapshot;
    executor?: ToolExecutor;
    consume?: () => boolean;
  } = {},
) => {
  const sent: { tool: string; args: unknown }[] = [];
  const records: CallRecord[] = [];
  const dispatcher = createDispatcher({
    snapshot: options.snapshot ?? snapshotFor('discover', true, ['path:/**'], ['method:delete']),
    limiter: { consume: options.consume ?? (() => true), retryAfterMs: () => 1000 },
    now: () => 0,
    executor:
      options.executor ??
      ((tool, args, _signal, _trace, report) => {
        sent.push({ tool: tool.name, args });
        // As the real executor does: the record names the operation that ran
        report?.({ outcome: 'ok' });
        return Promise.resolve(envelope({ tool: tool.name, args }));
      }),
    metaExecutor: createMetaExecutor(),
    redactor: createRedactor([SECRET]),
    onCall: (record) => {
      records.push(record);
    },
  });
  const execute = async (code: string): Promise<ToolCallOutcome> => {
    const result: DispatchResult = await dispatcher.call({
      name: EXECUTE_TOOL_NAME,
      arguments: { code },
      signal: new AbortController().signal,
    });
    if (result.kind !== 'outcome') {
      throw new Error(`expected an outcome, got ${result.kind}`);
    }
    return result.outcome;
  };
  return { execute, sent, records };
};

const textOf = (outcome: ToolCallOutcome): string =>
  outcome.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

describe('execute_code — listing', () => {
  it('is listed only when asked for, under discover or next to the operation tools', () => {
    const names = (snapshot: ServerSnapshot) => snapshot.tools.map((tool) => tool.name);
    expect(names(snapshotFor('discover', false))).not.toContain(EXECUTE_TOOL_NAME);
    expect(names(snapshotFor('per-operation', false))).not.toContain(EXECUTE_TOOL_NAME);
    expect(names(snapshotFor('per-operation', true))).toStrictEqual([
      'openapi_mcp_status',
      'getThing',
      'listThings',
      EXECUTE_TOOL_NAME,
    ]);
    for (const toolMode of ['discover', 'per-operation'] as const) {
      const tool = snapshotFor(toolMode, true).toolsByName[EXECUTE_TOOL_NAME];
      expect(tool?.wireTool.annotations).toStrictEqual({ readOnlyHint: true, openWorldHint: true });
      expect(tool?.wireTool.description).toContain('Only read-only operations can be called');
      expect(tool?.wireTool.inputSchema).toMatchObject({
        type: 'object',
        properties: { code: { type: 'string', maxLength: 20_000 } },
        required: ['code'],
        additionalProperties: false,
      });
    }
    expect(
      snapshotFor('discover', true).toolsByName[EXECUTE_TOOL_NAME]?.wireTool.description,
    ).toContain('the same name and arguments as call_operation');
    expect(
      snapshotFor('per-operation', true).toolsByName[EXECUTE_TOOL_NAME]?.wireTool.description,
    ).toContain("an operation tool's name and the arguments that tool takes");
  });

  it('is not an operation, so neither call_operation nor a script reaches it', async () => {
    const { execute } = setup();
    const outcome = await execute(
      `try { await api.call('${EXECUTE_TOOL_NAME}', { code: 'return 1' }); } catch (error) { return error.message; }`,
    );
    expect(outcome.structuredContent).toMatchObject({
      result: `unknown operation "${EXECUTE_TOOL_NAME}" — use search_operations to find an operation name`,
    });
  });
});

describe('execute_code — nested calls', () => {
  it('runs read-only operations and returns only the script result with the call record', async () => {
    const { execute, sent } = setup();
    const outcome = await execute(`
      const list = await api.call('listThings');
      const one = await api.call('getThing', { id: 'a' });
      return { list: list.data.tool, one: one.data.args, status: one.status };
    `);
    expect(outcome.isError).not.toBe(true);
    expect(outcome.structuredContent).toStrictEqual({
      result: { list: 'listThings', one: { id: 'a' }, status: 200 },
      calls: [
        { name: 'listThings', status: 'ok' },
        { name: 'getThing', status: 'ok' },
      ],
    });
    expect(sent.map((entry) => entry.tool)).toStrictEqual(['listThings', 'getThing']);
  });

  it('refuses an exposed write before anything is sent', async () => {
    const { execute, sent } = setup();
    const outcome = await execute(
      `try { await api.call('createThing', {}); } catch (error) { return error.message; }`,
    );
    expect(outcome.structuredContent).toMatchObject({
      result:
        'createThing is not read-only: execute_code calls read-only operations only; use call_operation for it',
      calls: [{ name: 'createThing', status: 'error' }],
    });
    expect(sent).toStrictEqual([]);
  });

  it('reaches only exposed operations: a filtered one is unknown, as for call_operation', async () => {
    const { execute, sent } = setup();
    const outcome = await execute(
      `try { await api.call('deleteThing', { id: 'a' }); } catch (error) { return error.message; }`,
    );
    expect(outcome.structuredContent).toMatchObject({
      result: 'unknown operation "deleteThing" — use search_operations to find an operation name',
    });
    expect(sent).toStrictEqual([]);
  });

  it('validates arguments with the operation schema before sending', async () => {
    const { execute, sent } = setup();
    const outcome = await execute(
      `try { await api.call('getThing', { id: 1, extra: true }); } catch (error) { return error.message; }`,
    );
    expect(outcome.structuredContent).toMatchObject({ result: expect.stringContaining('id') });
    expect(sent).toStrictEqual([]);
  });

  it('charges the rate limit once per nested call, as for separate calls', async () => {
    let budget = 3;
    const { execute, sent } = setup({ consume: () => budget-- > 0 });
    const outcome = await execute(`
      const results = [];
      for (let i = 0; i < 4; i++) {
        try { await api.call('listThings'); results.push('ok'); } catch (error) { results.push(error.message); }
      }
      return results;
    `);
    // One for execute_code itself, two for nested calls, then none left
    expect(outcome.structuredContent).toMatchObject({
      result: [
        'ok',
        'ok',
        'rate limit exceeded — too many tool calls; retry after 1s',
        'rate limit exceeded — too many tool calls; retry after 1s',
      ],
    });
    expect(sent).toHaveLength(2);
  });

  it('never hands a script a result holding a registered secret', async () => {
    const { execute } = setup({
      executor: () => Promise.resolve(envelope({ token: SECRET })),
    });
    const outcome = await execute(`
      try {
        const leaked = await api.call('listThings');
        return JSON.stringify(leaked).split('').reverse().join('');
      } catch (error) {
        return 'withheld';
      }
    `);
    expect(outcome.structuredContent).toMatchObject({
      result: 'withheld',
      calls: [{ name: 'listThings', status: 'error' }],
    });
    expect(JSON.stringify(outcome)).not.toContain([...SECRET].toReversed().join(''));
  });

  it('withholds a script result that assembles a registered secret', async () => {
    const { execute } = setup();
    const outcome = await execute(`return 'example-token' + '-not-a-secret';`);
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('logs each nested call under the operation that ran', async () => {
    const { execute, records } = setup();
    await execute(
      `await api.call('listThings'); await api.call('getThing', { id: 'a' }); return 1;`,
    );
    expect(records.map((record) => record.tool)).toStrictEqual([
      'listThings',
      'getThing',
      EXECUTE_TOOL_NAME,
    ]);
  });
});

describe('execute_code — an operation with the same name', () => {
  it('keeps an operation named execute_code and lists no program tool next to it', () => {
    const { exposed } = applyFilters([op('execute_code', { method: 'get', path: '/run' })], [], []);
    const built = buildTools(exposed, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
    const pipeline = {
      spec: { title: 't', specVersion: '1', omitted: [] },
      contentHash: 'h',
      displaySource: 's',
      deadPatterns: [],
    };
    const perOperation = buildSnapshot(built, pipeline, {
      toolMode: 'per-operation',
      execute: true,
    });
    expect(perOperation.tools.map((tool) => [tool.name, tool.kind])).toStrictEqual([
      ['openapi_mcp_status', 'meta'],
      [EXECUTE_TOOL_NAME, 'upstream'],
    ]);
    // Under discover the operation is a call_operation name, and both exist
    const discover = buildSnapshot(built, pipeline, { toolMode: 'discover', execute: true });
    expect(discover.toolsByName[EXECUTE_TOOL_NAME]?.kind).toBe('discovery');
    expect(Object.keys(discover.operationsByName)).toStrictEqual([EXECUTE_TOOL_NAME]);
  });
});

describe('execute_code — next to the operation tools', () => {
  it('calls an operation through its own tool, with the same checks', async () => {
    const { execute, sent, records } = setup({
      snapshot: snapshotFor('per-operation', true, ['path:/**'], ['method:delete']),
    });
    const outcome = await execute(`
      const one = await api.call('getThing', { id: 'a' });
      const errors = [];
      for (const name of ['createThing', 'deleteThing', '${EXECUTE_TOOL_NAME}', 'openapi_mcp_status']) {
        try { await api.call(name, {}); } catch (error) { errors.push(error.message); }
      }
      try { await api.call('getThing', { id: 1 }); } catch (error) { errors.push('invalid'); }
      return { one: one.data.args, errors };
    `);
    expect(outcome.structuredContent).toMatchObject({
      result: {
        one: { id: 'a' },
        errors: [
          'createThing is not read-only: execute_code calls read-only operations only; call its tool directly',
          'unknown operation "deleteThing" — use the name of an operation tool',
          `unknown operation "${EXECUTE_TOOL_NAME}" — use the name of an operation tool`,
          'unknown operation "openapi_mcp_status" — use the name of an operation tool',
          'invalid',
        ],
      },
    });
    expect(sent).toStrictEqual([{ tool: 'getThing', args: { id: 'a' } }]);
    expect(records.map((record) => record.tool)).toStrictEqual([
      'getThing',
      'getThing',
      EXECUTE_TOOL_NAME,
    ]);
  });
});

describe('execute_code — results without an output schema', () => {
  it('splits a text result into data, headers and pagination', async () => {
    const { execute } = setup({
      executor: () =>
        Promise.resolve({
          isError: false,
          content: [
            { type: 'text' as const, text: '[{"id":"a"}]' },
            {
              type: 'text' as const,
              text: 'headers:\nlink: <https://api.example.test/things?page=2>; rel="next"\netag: W/"1"',
            },
            { type: 'text' as const, text: 'pagination: {"next":{"page":2}}' },
          ],
        }),
    });
    const outcome = await execute(`return await api.call('listThings');`);
    expect(outcome.structuredContent).toMatchObject({
      result: {
        data: [{ id: 'a' }],
        headers: { link: '<https://api.example.test/things?page=2>; rel="next"', etag: 'W/"1"' },
        pagination: { next: { page: 2 } },
      },
    });
  });

  it('puts a text result into data, parsed when it is JSON', async () => {
    const bodies = ['{"id":"a","n":1}', 'plain words'];
    const { execute } = setup({
      executor: () => Promise.resolve(textOutcome(bodies.shift() ?? '', false)),
    });
    const outcome = await execute(`
      const json = await api.call('listThings');
      const text = await api.call('listThings');
      return [json, text];
    `);
    expect(outcome.structuredContent).toMatchObject({
      result: [{ data: { id: 'a', n: 1 } }, { data: 'plain words' }],
    });
  });
});

describe('execute_code — what a nested call gets', () => {
  it('asks the executor for whole text results, while a direct call keeps the display cap', async () => {
    const limits: (number | undefined)[] = [];
    const { execute } = setup({
      executor: (_tool, _args, _signal, _trace, _report, textBytes) => {
        limits.push(textBytes);
        return Promise.resolve(envelope({}));
      },
    });
    await execute(`await api.call('listThings'); return 1;`);
    expect(limits).toStrictEqual([SCRIPT_LIMITS.receivedBytes]);
  });

  it('fails a call whose result is an image, and skips a header line it cannot read', async () => {
    const results: ToolCallOutcome[] = [
      { isError: false, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      {
        isError: false,
        content: [
          { type: 'text', text: '{"a":1}' },
          { type: 'text', text: 'headers:\netag: W/"1"\nbroken line' },
        ],
      },
    ];
    const { execute } = setup({ executor: () => Promise.resolve(results.shift()!) });
    const outcome = await execute(`
      let image;
      try { await api.call('listThings'); } catch (error) { image = error.message; }
      return { image, text: await api.call('listThings') };
    `);
    expect(outcome.structuredContent).toMatchObject({
      result: {
        image: 'listThings returned an image, which a program cannot read; call it directly',
        text: { data: { a: 1 }, headers: { etag: 'W/"1"' } },
      },
    });
  });

  it('withholds a result with a secret without claiming that anything changed', async () => {
    const { execute } = setup();
    const outcome = await execute(`return 'example-token' + '-not-a-secret';`);
    expect(outcome.content).toStrictEqual([{ type: 'text', text: BOUNDARY_WITHHELD_READ_TEXT }]);
  });
});

describe('execute_code — failures', () => {
  it('returns an error with the calls made before the script failed', async () => {
    const { execute } = setup();
    const outcome = await execute(`await api.call('listThings'); throw new Error('stop');`);
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(textOf(outcome))).toStrictEqual({
      error: 'Error: stop',
      calls: [{ name: 'listThings', status: 'ok' }],
    });
  });

  it('refuses code past the length limit before running anything', async () => {
    const { execute, sent } = setup();
    const outcome = await execute('x'.repeat(20_001));
    expect(outcome.isError).toBe(true);
    expect(sent).toStrictEqual([]);
  });
});

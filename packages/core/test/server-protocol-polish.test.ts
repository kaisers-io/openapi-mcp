import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation, ToolExecutor } from '../src/index.ts';
import { createProtocolSession } from '../src/server/sdk/protocol.ts';
import { traceContextFromMeta } from '../src/server/trace.ts';

// MCP protocol polish, driven through the real SDK client over the SDK's
// in-memory transport: tool titles, a key-order-independent tools/list
// order, tools/list pagination, progress notifications and W3C trace
// context. Each item is in the 2026-07-28 spec (Tool.title; "Servers SHOULD
// return tools in a deterministic order"; the pagination and progress
// utilities; the reserved `traceparent`/`tracestate` _meta keys).

const getOp = (toolName: string, path: string, summary?: string): NamedOperation => ({
  toolName,
  operation: {
    method: 'get',
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    ...(summary === undefined ? {} : { summary }),
    responses: { '200': { description: 'ok' } },
  },
});

const snapshotOf = (
  ops: readonly NamedOperation[],
  contentHash = 'hash-1',
  toolMode: 'per-operation' | 'discover' = 'per-operation',
) =>
  buildSnapshot(
    buildTools(ops, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
    {
      spec: { title: 't', specVersion: '1', omitted: [] },
      contentHash,
      displaySource: 's',
      deadPatterns: [],
    },
    { toolMode },
  );

const connect = async (
  ops: readonly NamedOperation[],
  options: {
    executor?: ToolExecutor;
    progressIntervalMs?: number;
    toolsPageSize?: number;
    discover?: boolean;
  } = {},
) => {
  const server = createProtocolSession({
    name: 'test-server',
    version: '1.0.0',
    snapshot: snapshotOf(ops, 'hash-1', options.discover === true ? 'discover' : 'per-operation'),
    dispatcherDeps: {
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => 0,
      executor:
        options.executor ?? (() => Promise.resolve({ isError: false, content: [] as const })),
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([]),
    },
    ...(options.progressIntervalMs === undefined
      ? {}
      : { progressIntervalMs: options.progressIntervalMs }),
    ...(options.toolsPageSize === undefined ? {} : { toolsPageSize: options.toolsPageSize }),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe('tools/list — titles and order', () => {
  it('exposes a sanitized, capped title from the summary, and none without one', async () => {
    const client = await connect([
      getOp('listZetas', '/z', 'List zetas'),
      getOp('noSummary', '/n'),
      getOp('long', '/l', `Very long ${'x'.repeat(200)}`),
    ]);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName['listZetas']?.title).toBe('List zetas');
    expect(byName['noSummary']?.title).toBeUndefined();
    expect(byName['long']?.title?.length).toBeLessThanOrEqual(80);
    expect(byName['openapi_mcp_status']?.title).toBe('Server status');
  });

  it('orders tools by name after the meta tool, independent of the spec key order', async () => {
    const zeta = getOp('zeta', '/b', 'List zetas');
    const alpha = getOp('alpha', '/a', 'List alphas');
    const first = await connect([zeta, alpha]);
    const second = await connect([alpha, zeta]);
    const names = async (client: Client) => {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name);
    };
    expect(await names(first)).toEqual(['openapi_mcp_status', 'alpha', 'zeta']);
    expect(JSON.stringify(await first.listTools())).toBe(JSON.stringify(await second.listTools()));
  });
});

describe('tools/list — pagination', () => {
  const many = Array.from({ length: 7 }, (_unused, index) =>
    getOp(`tool${String(index)}`, `/t${String(index)}`),
  );

  it('keeps a single page (no nextCursor) when the tools fit', async () => {
    const client = await connect(many);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(8);
    expect(result.nextCursor).toBeUndefined();
  });

  it('does not page by default, even far past 100 tools (hosts that ignore nextCursor)', async () => {
    const lots = Array.from({ length: 150 }, (_unused, index) =>
      getOp(`bulk${String(index)}`, `/b${String(index)}`),
    );
    const client = await connect(lots);
    const first = await client.request({ method: 'tools/list', params: {} });
    expect(first.tools).toHaveLength(151);
    expect(first.nextCursor).toBeUndefined();
  });

  it('pages with an opaque cursor and returns every tool exactly once', async () => {
    const client = await connect(many, { toolsPageSize: 3 });
    // The raw first page (Client.listTools() without a cursor follows
    // every page itself and returns the aggregate).
    const first = await client.request({ method: 'tools/list', params: {} });
    expect(first.tools).toHaveLength(3);
    const seen = first.tools.map((tool) => tool.name);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor !== undefined && pages < 10) {
      const page = await client.listTools({ cursor });
      seen.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    // And the client's own aggregation follows the cursors to the same set.
    const aggregate = await client.listTools();
    expect(aggregate.tools.map((tool) => tool.name).toSorted()).toEqual(seen.toSorted());
  });

  it.each(['garbage', 'aGFzaC0xOjk5OQ', 'b3RoZXItaGFzaDoz', ''])(
    'rejects an invalid cursor %j with InvalidParams',
    async (cursor) => {
      const client = await connect(many, { toolsPageSize: 3 });
      await expect(client.listTools({ cursor })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    },
  );
});

describe('tools/call — progress notifications', () => {
  it('sends increasing progress while a slow call runs, and none after it completes', async () => {
    let release: () => void = () => {};
    const executor: ToolExecutor = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { isError: false, content: [{ type: 'text', text: 'done' }] };
    };
    const client = await connect([getOp('slow', '/s')], { executor, progressIntervalMs: 20 });
    const progress: number[] = [];
    const pending = client.callTool(
      { name: 'slow', arguments: {} },
      {
        onprogress: (update) => {
          progress.push(update.progress);
        },
      },
    );
    await vi.waitFor(() => {
      expect(progress.length).toBeGreaterThanOrEqual(3);
    });
    release();
    await pending;
    const count = progress.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    expect(progress).toHaveLength(count);
    expect(progress).toEqual(progress.toSorted((first, second) => first - second));
    expect(new Set(progress).size).toBe(progress.length);
  });

  it('sends nothing when the client did not ask for progress', async () => {
    const client = await connect([getOp('fast', '/f')], { progressIntervalMs: 5 });
    const onNotification = vi.fn<(notification: unknown) => void>();
    client.fallbackNotificationHandler = (notification) => {
      onNotification(notification);
      return Promise.resolve();
    };
    await client.callTool({ name: 'fast', arguments: {} });
    expect(onNotification).not.toHaveBeenCalled();
  });
});

describe('tools/call — W3C trace context', () => {
  const PARENT = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  it('hands a valid traceparent/tracestate from _meta to the executor', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [] as const }),
    );
    const client = await connect([getOp('traced', '/t')], { executor });
    await client.callTool({
      name: 'traced',
      arguments: {},
      _meta: { traceparent: PARENT, tracestate: 'congo=t61rcWkgMzE, rojo=00f067aa0ba902b7' },
    });
    expect(executor.mock.calls[0]?.[3]).toEqual({
      traceparent: PARENT,
      tracestate: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
    });
  });

  it.each([
    ['the invalid version ff', 'ff-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01'],
    ['version 00 with a trailing field', `${PARENT}-extra`],
    ['a higher version glued to an extra field', `01${PARENT.slice(2)}extra`],
    ['an all-zero trace id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
    ['an all-zero parent id', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'],
    ['upper-case hex', '00-0AF7651916CD43DD8448EB211C80319C-00F067AA0BA902B7-01'],
    ['an injected CRLF', `${PARENT}\r\nx-injected: 1`],
    ['a non-string', 42],
  ])('drops a traceparent with %s', (_label, traceparent) => {
    expect(traceContextFromMeta({ traceparent, tracestate: 'a=b' })).toEqual({});
  });

  it('reads a higher traceparent version by the version-00 layout and forwards it as 00', () => {
    const higher = `01${PARENT.slice(2)}`;
    expect(traceContextFromMeta({ traceparent: higher })).toEqual({ traceparent: PARENT });
    expect(traceContextFromMeta({ traceparent: `${higher}-future-field` })).toEqual({
      traceparent: PARENT,
    });
  });

  it('keeps a valid traceparent but drops a malformed tracestate', () => {
    expect(traceContextFromMeta({ traceparent: PARENT, tracestate: 'no-equals-sign' })).toEqual({
      traceparent: PARENT,
    });
    expect(
      traceContextFromMeta({
        traceparent: PARENT,
        tracestate: Array.from({ length: 33 }, (_unused, index) => `k${index}=v`).join(','),
      }),
    ).toEqual({ traceparent: PARENT });
    expect(traceContextFromMeta({ tracestate: 'a=b' })).toEqual({});
    expect(traceContextFromMeta(null)).toEqual({});
  });
});

// PR kaisers-io/openapi-mcp-archive#144's discover mode routes an upstream call
// through call_operation: the protocol features above must reach the upstream
// executor on that path too.
describe('discover mode (call_operation)', () => {
  const PARENT = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  it('hands the trace context from _meta to the executor through call_operation', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [] as const }),
    );
    const client = await connect([getOp('traced', '/t')], { executor, discover: true });
    await client.callTool({
      name: 'call_operation',
      arguments: { name: 'traced', arguments: {} },
      _meta: { traceparent: PARENT },
    });
    expect(executor.mock.calls[0]?.[0].name).toBe('traced');
    expect(executor.mock.calls[0]?.[3]).toEqual({ traceparent: PARENT });
  });

  it('sends progress for a slow call made through call_operation', async () => {
    let release: () => void = () => {};
    const executor: ToolExecutor = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { isError: false, content: [{ type: 'text', text: 'done' }] };
    };
    const client = await connect([getOp('slow', '/s')], {
      executor,
      progressIntervalMs: 20,
      discover: true,
    });
    const progress: number[] = [];
    const pending = client.callTool(
      { name: 'call_operation', arguments: { name: 'slow', arguments: {} } },
      {
        onprogress: (update) => {
          progress.push(update.progress);
        },
      },
    );
    await vi.waitFor(() => {
      expect(progress.length).toBeGreaterThanOrEqual(2);
    });
    release();
    await expect(pending).resolves.toMatchObject({ isError: false });
  });

  it('pages the discover tool list like any other (opt-in) and lists it whole by default', async () => {
    const ops = [getOp('alpha', '/a'), getOp('beta', '/b')];
    const unpaged = await connect(ops, { discover: true });
    const whole = await unpaged.request({ method: 'tools/list', params: {} });
    const names = whole.tools.map((tool) => tool.name);
    expect(names).toHaveLength(4);
    expect(whole.nextCursor).toBeUndefined();
    const client = await connect(ops, { discover: true, toolsPageSize: 3 });
    const first = await client.request({ method: 'tools/list', params: {} });
    expect(first.tools).toHaveLength(3);
    const second = await client.listTools({ cursor: first.nextCursor });
    expect([...first.tools, ...second.tools].map((tool) => tool.name)).toEqual(names);
    expect(second.nextCursor).toBeUndefined();
  });
});

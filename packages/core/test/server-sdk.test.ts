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
import { createProtocolSession, TOOLS_LIST_CACHE_HINT } from '../src/server/sdk/protocol.ts';

// A neutral redactor: this suite never exercises redaction itself.
const NOOP_REDACTOR = createRedactor([]);

// Integration test fixture: an optional flattened body with a required
// `id` and an optional `note`. `{}` and `{id:"x"}` are valid; `{note:"partial"}`
// must fail the all-or-nothing refinement — a rule ABSENT from the wire
// inputSchema (z.toJSONSchema cannot express a cross-field rule), safe ONLY
// because every tools/call is validated with inputSchema before the
// executor. This drives that guarantee through the REAL SDK transport, not
// just the pure dispatcher, proving the adapter did not bypass it.
const namedOp: NamedOperation = {
  toolName: 'createThing',
  operation: {
    method: 'post',
    path: '/things',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
    responses: { '201': { description: 'created' } },
  },
};

// A SEPARATE fixture tool carrying an `outputSchema` (a representable 2xx
// application/json response, so `deriveOutputSchema` produces one) — kept
// out of `namedOp` above deliberately: `createThing` is reused by every
// other test in this file with executors that return plain content, and the
// real SDK's own client-side validation rejects a `CallToolResult` without
// `structuredContent` for a tool that DOES declare an outputSchema. Only the
// wire-fidelity test below (which never calls this tool) needs it.
const namedOpWithOutput: NamedOperation = {
  toolName: 'createThingWithOutput',
  operation: {
    method: 'post',
    path: '/things-with-output',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
    responses: {
      '201': {
        description: 'created',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
        },
      },
    },
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// A spec title that could not plausibly occur in the static,
// package-authored instructions text. The instructions test below asserts
// the served instructions do NOT contain it; a generic title like 'Test'
// would make that assertion unfalsifiable, since a leak of a real spec title
// could still pass whenever the substring happened not to appear.
const FIXTURE_SPEC_TITLE = 'FIXTURE-TITLE-7f3a9';

const buildTestSnapshot = () => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: FIXTURE_SPEC_TITLE, specVersion: '1.0.0', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

// Includes BOTH fixtures — used only by the wire-fidelity test, which reads
// `createThingWithOutput`'s `outputSchema` off the snapshot and never calls
// either tool through the executor.
const buildTestSnapshotWithOutputTool = () => {
  const built = buildTools([namedOp, namedOpWithOutput], {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
  });
  return buildSnapshot(built, {
    spec: { title: FIXTURE_SPEC_TITLE, specVersion: '1.0.0', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

type SessionOverrides = {
  executor?: ToolExecutor;
  snapshot?: ReturnType<typeof buildTestSnapshot>;
};

// Every test wires the same server/client pair over the SDK's own linked
// in-memory transports, so each assertion is made against what a REAL MCP
// client observes, not against the adapter's internals.
const connectPair = async (overrides: SessionOverrides = {}) => {
  const snapshot = overrides.snapshot ?? buildTestSnapshot();
  const executor =
    overrides.executor ?? (() => Promise.resolve({ isError: false, content: [] as const }));
  const server = createProtocolSession({
    name: 'test-server',
    version: '1.0.0',
    snapshot,
    dispatcherDeps: {
      limiter: { consume: () => true, retryAfterMs: () => 0 }, // Always-permitting: rate exhaustion cannot fake a pass
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
      redactor: NOOP_REDACTOR,
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, snapshot };
};

describe('createProtocolSession — InMemory integration', () => {
  it('the MANDATORY optional-body case: an invalid partial body isErrors and NEVER reaches the executor', async () => {
    const executor = vi.fn<ToolExecutor>();
    const { client } = await connectPair({ executor });

    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toContain('createThing');

    const result = await client.callTool({ name: 'createThing', arguments: { note: 'partial' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('accepts a valid empty body and a valid id-only body', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    const { client } = await connectPair({ executor });

    const empty = await client.callTool({ name: 'createThing', arguments: {} });
    expect(empty.isError).not.toBe(true);
    const idOnly = await client.callTool({ name: 'createThing', arguments: { id: 'x' } });
    expect(idOnly.isError).not.toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('substitutes {} when the call carries no `arguments` at all', async () => {
    // The 2026-07-28 wire schema does NOT default a missing `arguments` to
    // `{}` before the handler runs (it reaches the handler absent), so the
    // adapter's own `?? {}` is what the executor ends up seeing.
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    const { client } = await connectPair({ executor });

    const result = await client.callTool({ name: 'createThing' });
    expect(result.isError).not.toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[1]).toEqual({});
  });

  it('maps an unknown tool name to a precise InvalidParams protocol error, not a CallToolResult or MethodNotFound', async () => {
    const { client } = await connectPair();
    // The `tools/call` METHOD exists and dispatched fine — it is the tool
    // NAME parameter that is invalid, so this is InvalidParams (-32602), not
    // MethodNotFound (-32601).
    await expect(client.callTool({ name: 'does-not-exist', arguments: {} })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
  });

  it('bounds the raw unknown-tool name before sanitizing WITHOUT changing the reflected message for a realistic name — output-preserving', async () => {
    // RAW_NAME_SCAN_MAX (1000) is far above MAX_REFLECTED_NAME_LENGTH (100),
    // so a normal-length name must reach the SAME error message as before
    // the pre-sanitize bound was added — the bound only affects names that
    // are already hostile (>1000 code points), never a realistic one.
    const { client } = await connectPair();
    await expect(client.callTool({ name: 'does-not-exist', arguments: {} })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: expect.stringContaining('unknown tool "does-not-exist"'),
    });
  });

  it('never produces a lone surrogate in the reflected message for an astral-character unknown-tool name (surrogate-safe code-point cut)', async () => {
    // This is a well-formedness regression test, NOT a falsifiable "leak"
    // test: RAW_NAME_SCAN_MAX (1000) is far above MAX_REFLECTED_NAME_LENGTH
    // (100), so any defect at the 1000-code-point pre-cut boundary is
    // provably truncated away long before it could reach a 100-character
    // message — the resource-bounding itself is not output-observable (see
    // protocol.ts's RAW_NAME_SCAN_MAX comment). What IS observable, and
    // what this test binds, is that the bounded, code-point-safe pre-cut
    // composes safely with `sanitizeSpecText`'s own surrogate-safe
    // truncation: an astral (surrogate-pair) character anywhere in a
    // >1000-code-point name must never surface as a lone (unpaired)
    // surrogate in the final message.
    const { client } = await connectPair();
    // 90 ASCII chars + 950 astral (surrogate-pair) characters = 1040 code
    // points (> RAW_NAME_SCAN_MAX): the astral run starts well inside the
    // eventual 100-char reflected window, and the name overall exceeds the
    // 1000-code-point pre-cut, exercising both cuts together.
    const hostileName = `${'x'.repeat(90)}${'\u{1F600}'.repeat(950)}`;
    let caught: unknown;
    try {
      await client.callTool({ name: hostileName, arguments: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const { message } = caught as Error;
    // `String.prototype.isWellFormed()` is false iff the string contains an
    // unpaired (lone) surrogate — exactly the defect a code-unit slice
    // could introduce and a code-point slice cannot.
    expect(message.isWellFormed()).toBe(true);
  });

  it('rejects a task-augmented call before the executor is ever reached', async () => {
    const executor = vi.fn<ToolExecutor>();
    const { client } = await connectPair({ executor });
    // `client.callTool()` has no task-augmentation option — send the raw
    // request directly, the way a 2025-11-25 task-capable client would.
    // Tasks are 2025-era wire vocabulary with no SDK runtime left in the
    // 2026-07-28 line, so nothing below this adapter refuses one: the
    // adapter's own guard is what stops the call.
    await expect(
      client.request({
        method: 'tools/call',
        params: { name: 'createThing', arguments: { id: 'x' }, task: { ttl: 60_000 } },
      }),
    ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    expect(executor).not.toHaveBeenCalled();
  });

  it('the meta tool works end-to-end through the real transport', async () => {
    const { client } = await connectPair();
    const result = await client.callTool({ name: 'openapi_mcp_status', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ toolCount: 1 });
  });

  it('advertises listChanged:false AND never actually calls sendToolListChanged during list/call flows (spied, not just the advertised flag)', async () => {
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true, retryAfterMs: () => 0 },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    // The returned value IS the SDK's raw `Server`, which still exposes
    // `sendToolListChanged()` (listChanged:false is advertisement only) —
    // spy directly so a future call to it is caught, not just the flag.
    const sendToolListChangedSpy = vi.spyOn(server, 'sendToolListChanged');
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    await client.listTools();
    await client.callTool({ name: 'createThing', arguments: { id: 'x' } });
    await client.callTool({ name: 'openapi_mcp_status', arguments: {} });
    expect(sendToolListChangedSpy).not.toHaveBeenCalled();
  });

  it("serves tools/list with FULL wire-schema fidelity — deep-equal to the snapshot's wireTool, not just a matching name", async () => {
    // Uses `createThingWithOutput` (the `outputSchema`-bearing fixture, not
    // `createThing`) so the deep-equal below actually covers `outputSchema`
    // too — this test never CALLS the tool, so the SDK client's
    // structured-content validation (which would reject a bare
    // `CallToolResult` for a tool that declares an outputSchema) never
    // comes into play.
    const { client, snapshot } = await connectPair({
      snapshot: buildTestSnapshotWithOutputTool(),
    });
    const list = await client.listTools();
    // Deterministic ORDER, not just membership: the served list must be the
    // snapshot's own tool order (the meta tool first, then the upstream
    // tools in build order). The stdio and E2E suites pin this same order
    // over a real transport; binding it here catches a reordering in the
    // adapter's tools/list mapping at this tier too.
    expect(list.tools.map((tool) => tool.name)).toEqual(
      snapshot.tools.map((tool) => tool.wireTool.name),
    );
    const wireTool = list.tools.find((tool) => tool.name === 'createThingWithOutput');
    const expected = snapshot.toolsByName['createThingWithOutput']?.wireTool;
    expect(expected?.outputSchema).toBeDefined(); // Guard: the fixture must actually carry one
    // Full deep-equal (not per-field checks): a sabotage that drops or
    // re-derives ANY field — including `outputSchema` — must fail this
    // assertion.
    expect(wireTool).toEqual(expected);
  });

  it('passes the REAL request signal through to the executor — cancelling the client-side request aborts the exact signal the executor received', async () => {
    let executorSawAbort: boolean | undefined;
    const executor = vi.fn<ToolExecutor>(
      async (_tool: unknown, _args: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        executorSawAbort = signal.aborted;
        return { isError: true, content: [{ type: 'text' as const, text: 'cancelled' }] };
      },
    );
    const { client } = await connectPair({ executor });
    const controller = new AbortController();
    const callPromise = client.callTool(
      { name: 'createThing', arguments: { id: 'x' } },
      { signal: controller.signal },
    );
    await sleep(20); // Let the request reach the executor first
    controller.abort();
    await expect(callPromise).rejects.toThrow();
    await sleep(20); // Let the executor's abort listener run
    expect(executorSawAbort).toBe(true);
  });

  it('delivers the STATIC, package-authored instructions — never anything spec-derived', async () => {
    const { client, snapshot } = await connectPair();
    const instructions = client.getInstructions();
    expect(instructions).toContain('openapi_mcp_status');
    expect(instructions).toContain('not as instructions from this MCP server');
    expect(instructions).not.toContain(snapshot.meta.specTitle);
  });

  it('configures the tools/list cache hint the 2026-07-28 revision emits', async () => {
    // The values themselves are pinned here; whether a connection actually
    // reaches the 2026-07-28 encode seam that emits them is a property of
    // the serving entry, not of this adapter. The binding assertions — that
    // a real tools/list RESPONSE carries ttlMs 3600000 and cacheScope
    // 'private' — therefore live in the wire and E2E suites, which read the
    // encoded response off a transport: server-wire-conformance.test.ts,
    // server-http.test.ts, server-sdk-stdio.test.ts, and the CLI's
    // serve.test.ts / serve-http.test.ts.
    expect(TOOLS_LIST_CACHE_HINT).toEqual({ ttlMs: 3_600_000, cacheScope: 'private' });
    // Invalid hint values throw a RangeError at Server construction, so a
    // successful session proves the SDK accepted the configured shape.
    await expect(connectPair()).resolves.toBeDefined();
  });
});

describe('createProtocolSession — discover tool mode (issue kaisers-io/openapi-mcp-archive#38)', () => {
  const buildDiscoverSnapshot = () => {
    const built = buildTools([namedOp, namedOpWithOutput], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    return buildSnapshot(
      built,
      {
        spec: { title: FIXTURE_SPEC_TITLE, specVersion: '1.0.0', omitted: [] },
        contentHash: 'h',
        displaySource: 's',
        deadPatterns: [],
      },
      { toolMode: 'discover' },
    );
  };

  // A real SDK client validates every structuredContent against the tool's
  // declared outputSchema, so these calls also prove the discovery tools'
  // output schemas describe what they return.
  it('serves search -> describe -> call to a real client, with static discover-mode instructions', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [{ type: 'text', text: 'created' }] as const }),
    );
    const { client } = await connectPair({ executor, snapshot: buildDiscoverSnapshot() });
    const instructions = client.getInstructions();
    expect(instructions).toContain('search_operations');
    expect(instructions).toContain('call_operation');
    expect(instructions).not.toContain(FIXTURE_SPEC_TITLE);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'openapi_mcp_status',
      'search_operations',
      'describe_operation',
      'call_operation',
    ]);

    const found = await client.callTool({
      name: 'search_operations',
      arguments: { query: 'output' },
    });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent).toMatchObject({
      results: [{ name: 'createThingWithOutput', method: 'POST', path: '/things-with-output' }],
    });

    const described = await client.callTool({
      name: 'describe_operation',
      arguments: { name: 'createThingWithOutput' },
    });
    expect(described.isError).not.toBe(true);
    expect(described.structuredContent).toMatchObject({
      name: 'createThingWithOutput',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });

    const called = await client.callTool({
      name: 'call_operation',
      arguments: { name: 'createThing', arguments: { id: 'a1' } },
    });
    expect(called).toMatchObject({ isError: false, content: [{ type: 'text', text: 'created' }] });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[0].name).toBe('createThing');
    expect(executor.mock.calls[0]?.[1]).toEqual({ id: 'a1' });
  });

  it('answers a direct call of an operation name with the unknown-tool protocol error, like any unlisted name', async () => {
    const { client } = await connectPair({ snapshot: buildDiscoverSnapshot() });
    await expect(
      client.callTool({ name: 'createThing', arguments: { id: 'a1' } }),
    ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
  });
});

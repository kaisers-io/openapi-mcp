import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompatibilityCallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createProtocolSession,
  createRedactor,
  SYSTEM_HEADERS,
  type NamedOperation,
  type ToolExecutor,
} from '../src/index.ts';

// A neutral redactor: this suite never exercises redaction itself.
const NOOP_REDACTOR = createRedactor([]);

// The mandatory M4 integration test (exact fixture shape): an
// optional flattened body with a required `id` and an optional `note`.
// `{}` and `{id:"x"}` are valid; `{note:"partial"}` must fail the
// all-or-nothing refinement — a rule ABSENT from the wire inputSchema
// (z.toJSONSchema cannot express a cross-field rule), safe ONLY because
// every tools/call is validated with inputSchema before the executor. This
// drives that guarantee through the REAL SDK transport, not just the pure
// dispatcher (Task 4), proving the adapter did not bypass it.
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

const buildTestSnapshot = () => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 'Test', specVersion: '1.0.0', omitted: [] },
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
    spec: { title: 'Test', specVersion: '1.0.0', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

describe('createProtocolSession — InMemory integration', () => {
  it('the MANDATORY optional-body case: an invalid partial body isErrors and NEVER reaches the executor', async () => {
    const executor = vi.fn<ToolExecutor>();
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true }, // Always-permitting: rate exhaustion cannot fake this pass
        now: () => 0,
        executor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toContain('createThing');

    const result = await client.callTool({ name: 'createThing', arguments: { note: 'partial' } });
    expect(result.isError).toBe(true);
    // `Client.callTool()`'s return type resolves `content` to `unknown` here
    // (a pre-existing SDK .d.ts quirk under this repo's strictest tsconfig,
    // unrelated to this adapter); the cast below only satisfies `tsc`.
    expect((result.content as unknown[])[0]).toMatchObject({ type: 'text' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('accepts a valid empty body and a valid id-only body', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const empty = await client.callTool({ name: 'createThing', arguments: {} });
    expect(empty.isError).not.toBe(true);
    const idOnly = await client.callTool({ name: 'createThing', arguments: { id: 'x' } });
    expect(idOnly.isError).not.toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('maps an unknown tool name to a precise InvalidParams protocol error (McpError), not a CallToolResult or MethodNotFound', async () => {
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The `tools/call` METHOD exists and dispatched fine — it is the tool
    // NAME parameter that is invalid, so this is InvalidParams (-32602), not
    // MethodNotFound (-32601).
    await expect(client.callTool({ name: 'does-not-exist', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('bounds the raw unknown-tool name before sanitizing WITHOUT changing the reflected message for a realistic name — output-preserving', async () => {
    // RAW_NAME_SCAN_MAX (1000) is far above MAX_REFLECTED_NAME_LENGTH (100),
    // so a normal-length name must reach the SAME McpError message as before
    // the pre-sanitize bound was added — the bound only affects names that
    // are already hostile (>1000 code points), never a realistic one.
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Match on `code` plus the reflected substring (not the whole `.message`
    // verbatim): the client-side SDK re-wraps the wire error's message
    // through its own `MCP error ${code}: ` prefix on top of the server's
    // own McpError message — an SDK quirk orthogonal to T5 — so asserting
    // the exact, doubly-prefixed string would couple this test to that SDK
    // internal rather than to what T5 actually changed (the CONTENT that
    // gets reflected).
    await expect(client.callTool({ name: 'does-not-exist', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
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
    // (a `for...of` loop over `result.name` that breaks after
    // RAW_NAME_SCAN_MAX code points, reading at most that many without ever
    // materializing the rest of the string) composes safely with
    // `sanitizeSpecText`'s own surrogate-safe truncation: an astral
    // (surrogate-pair) character anywhere in a >1000-code-point name must
    // never surface as a lone (unpaired) surrogate in the final message.
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // 90 ASCII chars + 950 astral (surrogate-pair) characters = 1040 code
    // points (> RAW_NAME_SCAN_MAX): the astral run starts well inside the
    // eventual 100-char reflected window, and the name overall exceeds the
    // 1000-code-point pre-cut, exercising both cuts together.
    const hostileName = `${'x'.repeat(90)}${'\u{1F600}'.repeat(950)}`;
    let caught: unknown;
    try {
      await client.callTool({ name: hostileName, arguments: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const { message } = caught as Error;
    // `String.prototype.isWellFormed()` is false iff the string contains an
    // unpaired (lone) surrogate — exactly the defect a code-unit slice
    // could introduce and a code-point slice cannot.
    expect(message.isWellFormed()).toBe(true);
  });

  it("rejects a task-augmented call before our handler (and so the executor) is ever reached — enforced by the SDK's own Protocol dispatch, since this server declares no `tasks` capability", async () => {
    const executor = vi.fn<ToolExecutor>();
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // `client.callTool()` has no public task-augmentation option — send the
    // raw request directly, like a task-capable client would. Expect
    // InternalError (-32603), NOT InvalidParams: the SDK's OWN
    // `Protocol.assertTaskHandlerCapability` gate rejects this (a plain
    // `Error`) before our `CallToolRequestSchema` handler ever runs — see
    // the Verified Facts and the handler's own comment.
    await expect(
      client.request(
        {
          method: 'tools/call',
          params: { name: 'createThing', arguments: { id: 'x' }, task: { ttl: 60_000 } },
        },
        CompatibilityCallToolResultSchema,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    expect(executor).not.toHaveBeenCalled();
  });

  it('the meta tool works end-to-end through the real transport', async () => {
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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
        limiter: { consume: () => true },
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
    const [, initResult] = await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    // `client.connect` resolves post-handshake; read the cached capabilities.
    void initResult;
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
    const snapshot = buildTestSnapshotWithOutputTool();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] }),
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const list = await client.listTools();
    const wireTool = list.tools.find((tool) => tool.name === 'createThingWithOutput');
    const expected = snapshot.toolsByName['createThingWithOutput']?.wireTool;
    expect(expected?.outputSchema).toBeDefined(); // Guard: the fixture must actually carry one
    // Full deep-equal (not per-field checks): a sabotage that drops or
    // re-derives ANY field — including `outputSchema` — must fail this
    // assertion.
    expect(wireTool).toEqual(expected);
  });

  it('passes the REAL extra.signal through to the executor — cancelling the client-side request aborts the exact signal the executor received', async () => {
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
    const snapshot = buildTestSnapshot();
    const server = createProtocolSession({
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true },
        now: () => 0,
        executor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const controller = new AbortController();
    const callPromise = client.callTool(
      { name: 'createThing', arguments: { id: 'x' } },
      undefined,
      {
        signal: controller.signal,
      },
    );
    await sleep(20); // Let the request reach the executor first
    controller.abort();
    await expect(callPromise).rejects.toThrow();
    await sleep(20); // Let the executor's abort listener run
    expect(executorSawAbort).toBe(true);
  });
});

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createRedactor,
  HTTP_METHODS,
  META_TOOL_NAME,
  parseFilterPattern,
  runSpecPipeline,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type {
  CacheFs,
  NamedOperation,
  RequestGuardOptions,
  ServerSnapshot,
  SnapshotTool,
  SpecPipelineDeps,
  ToolExecutor,
} from '../src/index.ts';
import { createStreamableHttpServer } from '../src/server/sdk/streamable-http.ts';

// TIER: every HTTP assertion below drives the REAL transport factory
// (createStreamableHttpServer) over a loopback socket, not createMcpHandler
// re-wired locally. Re-wiring the handler in the test would restate
// `legacy: 'stateless'`, the per-request factory and the cache-hint
// configuration, so a change to any of those in the transport module could
// not fail these assertions. The socket is also what makes the byte-level
// checks meaningful: they read the RESPONSE BYTES this server actually
// writes. What this suite deliberately does NOT re-test is anything the
// front door owns and server-http.test.ts already pins (the 405 method gate,
// the body cap, Content-Type-before-parse ordering).
//
// What makes these assertions unavailable to the SDK-client suites
// (server-sdk.test.ts): a v2 client re-serializes every decoded result
// through its own spec schemas, so key order — and any wire field the client
// projects away — is gone by the time a client-side assertion sees it.

const NOOP_REDACTOR = createRedactor([]);

const noopExecutor: ToolExecutor = () =>
  Promise.resolve(textOutcome('no upstream executor configured in this test', true));

// One trivial upstream operation, so the served snapshot always carries a
// generated tool alongside the built-in meta tool.
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
      content: { 'application/json': { schema: { type: 'object', properties: {}, required: [] } } },
    },
    responses: { '201': { description: 'created' } },
  },
};

// The byte-fidelity probe. Authored in DELIBERATELY non-canonical key order
// at every level (`required` before `properties`; `pattern` before
// `description` before `type` inside a property; `zeta`/`nested`/`alpha` as
// the property order) and carrying the JSON Schema 2020-12 keywords the
// 2026-07-28 revision admits in a tool's inputSchema. Nothing between here
// and the socket may sort, re-derive or drop a key. The
// `sortedDeep`-difference guard in the test below keeps this ordering
// non-canonical: a future edit that happens to alphabetize it would make the
// byte assertion indistinguishable from a sorting server, and fails there
// instead of silently weakening this suite.
//
// No numeric-looking property names anywhere: JS object key order puts
// integer-like keys first regardless of insertion order, which would make a
// key-order assertion test the language rather than the server.
const PROBE_INPUT_SCHEMA = {
  additionalProperties: false,
  required: ['alpha'],
  properties: {
    zeta: { pattern: '^[a-z]+$', description: 'lowercase only', type: 'string' },
    nested: {
      type: 'object',
      propertyNames: { pattern: '^x-' },
      properties: {
        'x-kind': { enum: ['alpha', 'beta'], description: 'the kind', type: 'string' },
        'x-const': { const: 42, description: 'a fixed value' },
      },
      additionalProperties: false,
      dependentRequired: { 'x-kind': ['x-const'] },
    },
    alpha: { format: 'date-time', type: 'string', description: 'a timestamp' },
  },
  type: 'object',
} as const;

// A key-sorted deep copy — the shape a normalizing/re-serializing layer
// would produce. Used only to prove the probe's own order is distinguishable
// from a canonical one.
const sortedDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sortedDeep(entry));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortedDeep(entry)]));
};

const PROBE_TOOL_NAME = 'wire_probe_tool';

const buildBaseSnapshot = (): ServerSnapshot => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

// Appends the probe tool to a real snapshot rather than mutating one: a
// snapshot is deep-frozen by buildSnapshot, and the probe's wire schema is
// hand-authored on purpose — toolgen derives its own key order from the
// OpenAPI document, which is precisely the ordering this test must NOT
// depend on. The Zod `inputSchema` is a placeholder: the probe tool is only
// ever listed, never called, so the dispatcher never validates against it.
const buildProbeSnapshot = (): ServerSnapshot => {
  const base = buildBaseSnapshot();
  const probe: SnapshotTool = {
    kind: 'upstream',
    name: PROBE_TOOL_NAME,
    wireTool: {
      name: PROBE_TOOL_NAME,
      description: 'byte-fidelity probe',
      inputSchema: PROBE_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    inputSchema: z.object({}),
  };
  return {
    ...base,
    tools: [...base.tools, probe],
    toolsByName: { ...base.toolsByName, [PROBE_TOOL_NAME]: probe },
  };
};

// A port block disjoint from every other suite's (the core HTTP suite uses
// 4630-4646, the CLI E2E suite 3999/4083/4177/4271), because vitest runs
// test FILES concurrently.
const TEST_TOKEN = 'core-wire-conformance-bearer-token';
const ACCEPT_HEADER = 'application/json, text/event-stream';
const MODERN_VERSION = '2026-07-28';

const makeServer = (port: number, snapshot: ServerSnapshot = buildBaseSnapshot()) =>
  createStreamableHttpServer({
    name: 'core-wire-conformance',
    version: '9.9.9',
    snapshot,
    dispatcherDeps: {
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => Date.now(),
      executor: noopExecutor,
      metaExecutor: createMetaExecutor(),
      redactor: NOOP_REDACTOR,
    },
    guard: {
      allowedOrigins: new Set(),
      allowedHost: `127.0.0.1:${String(port)}`,
      bearer: { configuredToken: TEST_TOKEN },
    } satisfies RequestGuardOptions,
    port,
  });

const urlFor = (port: number): string => `http://127.0.0.1:${String(port)}/`;

// The reserved per-request envelope. `io.modelcontextprotocol/protocolVersion`
// and `io.modelcontextprotocol/clientCapabilities` are both REQUIRED by the
// 2026-07-28 envelope schema; the version key is also what classifies the
// request into the modern era at all.
const envelope = (version: string = MODERN_VERSION) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'wire-conformance', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

const modernHeaders = (
  mcpMethod: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  'content-type': 'application/json',
  accept: ACCEPT_HEADER,
  'mcp-protocol-version': MODERN_VERSION,
  'mcp-method': mcpMethod,
  authorization: `Bearer ${TEST_TOKEN}`,
  ...extra,
});

const modernBody = (
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  version: string = MODERN_VERSION,
) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: { ...params, _meta: envelope(version) },
});

type WireEnvelope = {
  error?: { code: number; message: string; data?: { supported?: string[] } };
  result?: Record<string, unknown> & {
    resultType?: string;
    ttlMs?: number;
    cacheScope?: string;
    _meta?: Record<string, unknown>;
    tools?: { name: string; inputSchema?: unknown }[];
    supportedVersions?: string[];
  };
};

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

// One modern POST, answered with its RAW response text — no client, no
// re-serialization, so key order and every wire field survive to the
// assertion.
const post = async (
  port: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string; envelope: WireEnvelope }> => {
  const res = await fetch(urlFor(port), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, envelope: JSON.parse(text) as WireEnvelope };
};

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const rejectingCacheFs: CacheFs = {
  mkdirSecure: () => Promise.reject(new Error('no cache filesystem in this test')),
  writeFileAtomic: () => Promise.reject(new Error('no cache filesystem in this test')),
  readFileTextCapped: () => Promise.reject(new Error('no cache filesystem in this test')),
  readDirNames: () => Promise.reject(new Error('no cache filesystem in this test')),
  removeDir: () => Promise.reject(new Error('no cache filesystem in this test')),
  pathExists: () => Promise.reject(new Error('no cache filesystem in this test')),
  createExclusive: () => Promise.reject(new Error('no cache filesystem in this test')),
  removeFile: () => Promise.reject(new Error('no cache filesystem in this test')),
};

const fileDeps = {
  readFileText: (path: string) => readFile(path, 'utf8'),
  fileSizeBytes: async (path: string) => {
    const stats = await stat(path);
    return stats.size;
  },
  fetcher: (() =>
    Promise.reject(new Error('no network in this test'))) as unknown as SpecPipelineDeps['fetcher'],
  lookup: (): Promise<readonly string[]> => Promise.reject(new Error('no dns in this test')),
  cacheFs: rejectingCacheFs,
};

// Every exposable operation, so the generated corpus below is the FULL
// fixture inventory rather than the read-only default subset.
const pipelineOpts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`)),
  deny: [],
  ttlMs: 3_600_000,
  trustSpecUpdates: false,
  cacheRoot: undefined,
  nowMs: 0,
};

const snapshotFromFixture = async (name: string): Promise<ServerSnapshot> => {
  const result = await runSpecPipeline(fixture(name), pipelineOpts, fileDeps);
  const built = buildTools(result.namedOperations, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: result.spec.openapiVersion,
  });
  return buildSnapshot(built, result);
};

describe('2026-07-28 wire conformance — schema byte fidelity', () => {
  it('serves a tool inputSchema byte-identically, key order included — no re-serialization anywhere between the snapshot and the socket', async () => {
    const port = 4660;
    const server = makeServer(port, buildProbeSnapshot());
    await server.listen();
    try {
      const {
        status,
        text,
        envelope: payload,
      } = await post(port, modernHeaders('tools/list'), modernBody(1, 'tools/list'));
      expect(status).toBe(200);
      // Fixture guard: the probe's key order must differ from the canonical
      // (sorted) one, or the byte assertion below could not tell a
      // faithful server from a sorting one.
      expect(JSON.stringify(PROBE_INPUT_SCHEMA)).not.toBe(
        JSON.stringify(sortedDeep(PROBE_INPUT_SCHEMA)),
      );
      // The BYTE assertion: the exact serialization of the source object —
      // key order and all — must appear verbatim in the response body. A
      // layer that rebuilt the schema through a Zod object schema (which
      // emits keys in SCHEMA declaration order) or through any sorting
      // normalizer would still deep-equal the source and still fail here.
      expect(text).toContain(JSON.stringify(PROBE_INPUT_SCHEMA));
      // The same claim stated order-sensitively on the parsed value:
      // JSON.parse preserves insertion order for non-integer-like keys, so
      // re-stringifying the decoded schema reproduces the wire order.
      const served = payload.result?.tools?.find((tool) => tool.name === PROBE_TOOL_NAME);
      expect(served).toBeDefined();
      expect(JSON.stringify(served?.inputSchema)).toBe(JSON.stringify(PROBE_INPUT_SCHEMA));
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('2026-07-28 wire conformance — result stamping', () => {
  it('stamps resultType, ttlMs, cacheScope and the serverInfo _meta onto tools/list', async () => {
    const port = 4661;
    const server = makeServer(port);
    await server.listen();
    try {
      const { status, envelope: payload } = await post(
        port,
        modernHeaders('tools/list'),
        modernBody(1, 'tools/list'),
      );
      expect(status).toBe(200);
      expect(payload.result?.resultType).toBe('complete');
      // The configured hint (TOOLS_LIST_CACHE_HINT), not the SDK's
      // conservative default of ttlMs 0.
      expect(payload.result?.ttlMs).toBe(3_600_000);
      expect(payload.result?.cacheScope).toBe('private');
      // The serverInfo stamp is invisible to an SDK client (it projects
      // `_meta` away from the decoded result), so this is a raw-wire-only
      // assertion. It must carry THIS server's identity, not a placeholder.
      expect(payload.result?.['_meta']?.[SERVER_INFO_META_KEY]).toEqual({
        name: 'core-wire-conformance',
        version: '9.9.9',
      });
    } finally {
      await server.close();
    }
  }, 15_000);

  it('stamps the same result fields onto server/discover — the SDK-installed modern-only method, reachable only because the entry marks the instance modern', async () => {
    const port = 4662;
    const server = makeServer(port);
    await server.listen();
    try {
      const { status, envelope: payload } = await post(
        port,
        modernHeaders('server/discover'),
        modernBody(1, 'server/discover'),
      );
      expect(status).toBe(200);
      expect(payload.result?.supportedVersions).toContain(MODERN_VERSION);
      expect(payload.result?.resultType).toBe('complete');
      // The discover result is a cacheable one, but this server configures
      // a cache hint for tools/list only — so discover carries the SDK's own
      // defaults. Both fields must still be PRESENT: the revision requires
      // them on every cacheable result.
      expect(payload.result?.ttlMs).toBe(0);
      expect(payload.result?.cacheScope).toBe('private');
      expect(payload.result?.['_meta']?.[SERVER_INFO_META_KEY]).toEqual({
        name: 'core-wire-conformance',
        version: '9.9.9',
      });
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('2026-07-28 wire conformance — request validation ladder', () => {
  it('rejects a modern-header request whose _meta envelope omits the protocol-version key with 400 / -32602, naming the missing key', async () => {
    const port = 4663;
    const server = makeServer(port);
    await server.listen();
    try {
      // The envelope is PRESENT but carries no protocol-version key, so the
      // body raises no era claim at all; the modern MCP-Protocol-Version
      // header is what makes this an error instead of legacy traffic.
      const { status, envelope: payload } = await post(port, modernHeaders('tools/list'), {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
      });
      expect(status).toBe(400);
      expect(payload.error?.code).toBe(-32_602);
      expect(payload.error?.message).toContain('io.modelcontextprotocol/protocolVersion');
    } finally {
      await server.close();
    }
  }, 15_000);

  it('rejects an Mcp-Method header that disagrees with the body method with 400 / -32020', async () => {
    const port = 4664;
    const server = makeServer(port);
    await server.listen();
    try {
      const { status, envelope: payload } = await post(
        port,
        // Header names tools/call, body names tools/list.
        modernHeaders('tools/call', { 'mcp-name': META_TOOL_NAME }),
        modernBody(1, 'tools/list'),
      );
      expect(status).toBe(400);
      expect(payload.error?.code).toBe(-32_020);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('rejects a tools/call that omits the required Mcp-Name header with 400 / -32020', async () => {
    const port = 4665;
    const server = makeServer(port);
    await server.listen();
    try {
      const { status, envelope: payload } = await post(
        port,
        modernHeaders('tools/call'),
        modernBody(1, 'tools/call', { name: META_TOOL_NAME, arguments: {} }),
      );
      expect(status).toBe(400);
      expect(payload.error?.code).toBe(-32_020);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('answers an unsupported protocol revision with 400 / -32022 and the supported list', async () => {
    const port = 4666;
    const server = makeServer(port);
    await server.listen();
    try {
      // Header AND envelope name the same unknown-but-modern-looking
      // revision: a disagreement between the two would be answered by the
      // earlier -32020 cross-check rung instead, and would never reach the
      // supported-revision gate this pins.
      const { status, envelope: payload } = await post(
        port,
        modernHeaders('tools/list', { 'mcp-protocol-version': '2099-01-01' }),
        modernBody(1, 'tools/list', {}, '2099-01-01'),
      );
      expect(status).toBe(400);
      expect(payload.error?.code).toBe(-32_022);
      // The supported list is what lets a future client renegotiate rather
      // than guess.
      expect(payload.error?.data?.supported).toContain(MODERN_VERSION);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('answers `ping` — removed from the 2026-07-28 method registry — with -32601', async () => {
    const port = 4667;
    const server = makeServer(port);
    await server.listen();
    try {
      const { status, envelope: payload } = await post(
        port,
        modernHeaders('ping'),
        modernBody(1, 'ping'),
      );
      expect(payload.error?.code).toBe(-32_601);
      // Method-not-found is a LADDER error, so it carries an HTTP status
      // (404) rather than riding in-band on a 200 the way a handler-produced
      // error does.
      expect(status).toBe(404);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('2026-07-28 wire conformance — subscriptions/listen', () => {
  it('acknowledges first with an EMPTY honored filter (listChanged:false is advertised), then closes with an empty result at teardown', async () => {
    const port = 4668;
    const server = makeServer(port);
    await server.listen();
    const controller = new AbortController();
    try {
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('subscriptions/listen'),
        body: JSON.stringify(
          modernBody(7, 'subscriptions/listen', { notifications: { toolsListChanged: true } }),
        ),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      // A stream, not a one-shot JSON body: the listen leg is the only
      // response this endpoint frames as SSE.
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = (res.body ?? new ReadableStream<Uint8Array>()).getReader();
      const decoder = new TextDecoder();
      const messages: Record<string, unknown>[] = [];
      let buffered = '';
      // Drains complete `event: message` frames out of the buffer, ignoring
      // keep-alive comment frames.
      const drain = (): void => {
        let separator = buffered.indexOf('\n\n');
        while (separator !== -1) {
          const frame = buffered.slice(0, separator);
          buffered = buffered.slice(separator + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine !== undefined) {
            messages.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
          }
          separator = buffered.indexOf('\n\n');
        }
      };
      while (messages.length === 0) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffered += decoder.decode(chunk.value, { stream: true });
        drain();
      }
      // FIRST frame: the acknowledgement, before any change notification.
      const ack = messages[0] as
        | { method?: string; params?: { notifications?: Record<string, unknown> } }
        | undefined;
      expect(ack?.method).toBe('notifications/subscriptions/acknowledged');
      // The honored filter is EMPTY: the client asked for tools-list-changed,
      // and this server advertises `tools.listChanged: false`, so the ack
      // narrows the request down to nothing rather than promising a
      // notification it will never send.
      expect(ack?.params?.notifications).toEqual({});

      // Teardown: closing the transport tears the entry down, which
      // gracefully closes every open subscription stream.
      const closing = server.close();
      // Everything the stream emits before it ends.
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffered += decoder.decode(chunk.value, { stream: true });
        drain();
      }
      await closing;

      const teardown = messages.at(-1) as
        | { id?: number; result?: Record<string, unknown> }
        | undefined;
      expect(teardown?.id).toBe(7);
      // An EMPTY result: the discriminator and `_meta` only — no payload
      // fields, which is the spec's graceful-close signal for a listen
      // stream.
      expect(teardown?.result?.['resultType']).toBe('complete');
      expect(Object.keys(teardown?.result ?? {}).toSorted()).toEqual(['_meta', 'resultType']);
    } finally {
      controller.abort();
      await server.close();
    }
  }, 20_000);
});

describe('2026-07-28 wire conformance — tool-name header safety', () => {
  // TIER: no transport. This is an invariant of the generated corpus itself,
  // and a tool name reaches the wire in a HEADER (`Mcp-Name` on every
  // tools/call), where a space, a comma or a non-ASCII byte would be a
  // header-injection or encoding hazard rather than a mere naming wart. The
  // corpus is built through the REAL pipeline from the checked-in fixture
  // specs, so this asserts what toolgen actually produces, not a
  // hand-written sample.
  const HEADER_SAFE_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

  it('every generated tool name — and the meta tool name — is header-safe', async () => {
    const snapshots = await Promise.all([
      snapshotFromFixture('petstore-3.0.json'),
      snapshotFromFixture('petstore-3.1.yaml'),
    ]);
    const names = snapshots.flatMap((snapshot) => snapshot.tools.map((tool) => tool.name));
    // Guard: an empty or trivial corpus would make the loop below vacuous.
    expect(names.length).toBeGreaterThan(4);
    for (const name of names) {
      expect(name).toMatch(HEADER_SAFE_TOOL_NAME);
    }
    // The meta tool is package-authored rather than toolgen-derived, so it
    // is asserted explicitly instead of relying on it being in the corpus.
    expect(names).toContain(META_TOOL_NAME);
    expect(META_TOOL_NAME).toMatch(HEADER_SAFE_TOOL_NAME);
  }, 30_000);
});

describe('2026-07-28 wire conformance — discover tool mode (issue kaisers-io/openapi-mcp-archive#38)', () => {
  // The generator from issue kaisers-io/openapi-mcp-archive#38: N trivial GET
  // operations, each with one query parameter and a small JSON response (so
  // each per-operation tool also carries an outputSchema).
  const generatedSnapshot = (count: number, toolMode: 'per-operation' | 'discover') => {
    const named: NamedOperation[] = Array.from({ length: count }, (_unused, index) => ({
      toolName: `list_r${String(index)}`,
      operation: {
        method: 'get',
        path: `/r${String(index)}`,
        operationId: `list_r${String(index)}`,
        summary: `List r${String(index)}`,
        tags: [`group${String(index % 20)}`],
        deprecated: false,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          },
        },
      },
    }));
    const built = buildTools(named, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
    return buildSnapshot(
      built,
      {
        spec: { title: 't', specVersion: '1', omitted: [] },
        contentHash: 'h',
        displaySource: 's',
        deadPatterns: [],
      },
      { toolMode },
    );
  };

  const listOver = async (port: number, snapshot: ServerSnapshot) => {
    const server = makeServer(port, snapshot);
    await server.listen();
    try {
      return await post(port, modernHeaders('tools/list'), modernBody(1, 'tools/list'));
    } finally {
      await server.close();
    }
  };

  it('keeps the tools/list response of a 400-operation API under 5 KB, against ~270 KB with one tool per operation', async () => {
    const perOperation = await listOver(4669, generatedSnapshot(400, 'per-operation'));
    const discover = await listOver(4670, generatedSnapshot(400, 'discover'));
    expect(perOperation.envelope.result?.tools).toHaveLength(401);
    expect(discover.envelope.result?.tools?.map((tool) => tool.name)).toEqual([
      META_TOOL_NAME,
      'search_operations',
      'describe_operation',
      'call_operation',
    ]);
    const perOperationBytes = Buffer.byteLength(perOperation.text, 'utf8');
    const discoverBytes = Buffer.byteLength(discover.text, 'utf8');
    expect(discoverBytes).toBeLessThan(5 * 1024);
    // Measured: 273,824 vs 4,349 bytes (about 68k vs 1.1k tokens at 4 bytes
    // per token). The bound below leaves room for wording changes.
    expect(perOperationBytes).toBeGreaterThan(50 * discoverBytes);
    // Every listed tool is object-rooted on the wire (MCP requires it).
    for (const tool of discover.envelope.result?.tools ?? []) {
      expect((tool.inputSchema as { type?: unknown }).type).toBe('object');
    }
    // The cost no longer grows with the operation count.
    const larger = await listOver(4671, generatedSnapshot(1000, 'discover'));
    expect(Buffer.byteLength(larger.text, 'utf8')).toBe(discoverBytes);
  }, 30_000);

  it('serves call_operation over the socket with the same result as the direct tool call', async () => {
    const callOver = async (
      port: number,
      snapshot: ServerSnapshot,
      name: string,
      args: unknown,
    ) => {
      const server = makeServer(port, snapshot);
      await server.listen();
      try {
        return await post(
          port,
          modernHeaders('tools/call', { 'mcp-name': name }),
          modernBody(1, 'tools/call', { name, arguments: args }),
        );
      } finally {
        await server.close();
      }
    };
    const direct = await callOver(4672, generatedSnapshot(3, 'per-operation'), 'list_r1', {
      limit: 'not-a-number',
    });
    const viaCall = await callOver(4673, generatedSnapshot(3, 'discover'), 'call_operation', {
      name: 'list_r1',
      arguments: { limit: 'not-a-number' },
    });
    expect(direct.status).toBe(200);
    expect(direct.envelope.result?.['isError']).toBe(true);
    expect(viaCall.envelope.result?.['content']).toEqual(direct.envelope.result?.['content']);
    expect(viaCall.envelope.result?.['isError']).toBe(true);
  }, 30_000);

  it('the discovery tool names are header-safe', () => {
    for (const tool of generatedSnapshot(1, 'discover').tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/u);
    }
  });
});

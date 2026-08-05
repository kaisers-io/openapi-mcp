import { createServer } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createRedactor,
  META_TOOL_NAME,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type {
  MetaExecutor,
  NamedOperation,
  RequestGuardOptions,
  ToolCallOutcome,
  ToolExecutor,
} from '../src/index.ts';
import { createStreamableHttpServer } from '../src/server/sdk/streamable-http.ts';

// Local fakes standing in for the upstream executor (this suite tests the HTTP
// front door and its composition with the SDK handler, not execution) + a
// neutral redactor.
const noopExecutor: ToolExecutor = () =>
  Promise.resolve(textOutcome('no upstream executor configured in this test', true));
const NOOP_REDACTOR = createRedactor([]);

// The timeout-hardening coverage (near the bottom of this file) needs to
// inspect the ACTUAL http.Server instance createStreamableHttpServer builds
// internally — a value its public StreamableHttpServerHandle deliberately does
// not expose (there is no reason for a caller to ever reach the raw
// http.Server; the timeout hardening only tightens two Node-internal timeout
// properties on it). Rather than widen that public API for a single property
// assertion, this WRAPS (never replaces) node:http's own createServer to
// capture the instance it returns — every call still delegates straight
// through to the REAL implementation, so this is pure instrumentation: every
// other test in this file gets a genuine, fully-functional http.Server exactly
// as before.
vi.mock(import('node:http'), async (importOriginal) => {
  const actual = await importOriginal();
  // `createServer` is overloaded (per-argument-shape return types); `Mock<T>`
  // cannot structurally satisfy an overloaded signature set on its own, so
  // the wrapped mock is cast back to the real, overloaded type after
  // construction — the runtime behavior (delegate-through, single-argument
  // call shape) is exactly what production code here actually uses.
  const createServerMock = vi.fn<typeof actual.createServer>(actual.createServer);
  return { ...actual, createServer: createServerMock as unknown as typeof actual.createServer };
});

// A minimal fixture: one trivial, argument-free upstream operation, plus the
// built-in read-only meta tool every snapshot carries. The abort and
// in-flight-shutdown tests below drive the META tool deliberately — its name
// is a stable exported constant (META_TOOL_NAME), whereas an upstream tool's
// wire name is derived by the naming pass and would couple these tests to it.
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
const buildHttpTestSnapshot = () => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

// A DISTINCT port per test (rather than one shared port reused across tests,
// each with its own server instance) avoids Node's own fetch() connection pool
// trying to reuse a keep-alive socket left over from a PRIOR test's
// already-closed server on the same port, which otherwise surfaces as a
// spurious ECONNRESET on the next test's first request. This block (4630+) is
// disjoint from both the session suite's ports (4610-4621) and the CLI E2E
// suite's CANDIDATE_PORTS (3999/4083/4177/4271).
const TEST_TOKEN = 'core-http-test-bearer-token';
const ACCEPT_HEADER = 'application/json, text/event-stream';
// The reserved per-request `_meta` envelope that CLAIMS the 2026-07-28
// revision. Its presence — not the MCP-Protocol-Version header — is what
// routes a request to the modern path; a claim-less POST is classified
// 2025-era instead.
const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'core-http-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

type ServerOverrides = {
  executor?: ToolExecutor;
  metaExecutor?: MetaExecutor;
  onError?: (error: Error) => void;
};

const makeServer = (port: number, overrides: ServerOverrides = {}) =>
  createStreamableHttpServer({
    name: 'core-http-test',
    version: '1.0.0',
    snapshot: buildHttpTestSnapshot(),
    dispatcherDeps: {
      limiter: { consume: () => true },
      now: () => Date.now(),
      executor: overrides.executor ?? noopExecutor,
      metaExecutor: overrides.metaExecutor ?? createMetaExecutor(),
      redactor: NOOP_REDACTOR,
    },
    guard: {
      allowedOrigins: new Set(),
      allowedHost: `127.0.0.1:${String(port)}`,
      bearer: { configuredToken: TEST_TOKEN },
    } satisfies RequestGuardOptions,
    port,
    // Spread, not a plain assignment: `onError` is an OPTIONAL property under
    // exactOptionalPropertyTypes, so an explicit `undefined` is not the same
    // as an absent key — the default-server tests must exercise the genuinely
    // unset option, which is what proves the sink is optional.
    ...(overrides.onError === undefined ? {} : { onError: overrides.onError }),
  });

const urlFor = (port: number): string => `http://127.0.0.1:${String(port)}/`;

const modernHeaders = (
  mcpMethod: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  'content-type': 'application/json',
  accept: ACCEPT_HEADER,
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': mcpMethod,
  authorization: `Bearer ${TEST_TOKEN}`,
  ...extra,
});

const modernBody = (id: number, method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: { ...params, _meta: MODERN_ENVELOPE },
});

type JsonRpcEnvelope = {
  error?: { code: number; message: string };
  result?: {
    resultType?: string;
    ttlMs?: number;
    cacheScope?: string;
    tools?: { name: string }[];
    content?: { text: string }[];
    isError?: boolean;
  };
};

// Raw sockets, because `fetch()` cannot send a DUPLICATED header (its Headers
// object dedupes on write): a plain node:net write is the only way to put two
// header lines with the same name on the wire, which is what the fail-closed
// duplicate-header assertions need.
const rawRequest = (
  port: number,
  rawHeaderLines: string,
  body = '',
  method = 'POST',
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} / HTTP/1.1\r\n${rawHeaderLines}Content-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    let raw = '';
    socket.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const statusLine = raw.split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.1 (?<status>\d+)/u.exec(statusLine);
      const statusText = match?.groups?.['status'];
      const separatorIndex = raw.indexOf('\r\n\r\n');
      resolve({
        status: statusText === undefined ? 0 : Number(statusText),
        body: separatorIndex === -1 ? '' : raw.slice(separatorIndex + 4),
      });
    });
    socket.on('error', reject);
  });

// Streams a body far larger than the 4 MB cap at the server over a raw socket,
// in small chunks that each yield to the event loop, and records how many bytes
// had been handed to the socket by the time the response's status line came
// back. That count is the discriminating measurement: a front door that lets
// the body be read before answering can only answer after the LAST byte
// (measured: exactly `declaredBytes`), whereas one that answers from the
// request line alone answers while the client is still sending.
const streamOversizedRequest = (
  port: number,
  method: string,
  declaredBytes: number,
): Promise<{ status: number; headers: string; bytesSentWhenAnswered: number }> =>
  new Promise((resolve, reject) => {
    const chunk = Buffer.alloc(256 * 1024, 0x78);
    let sent = 0;
    let answered = false;
    let raw = '';
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
          `Authorization: Bearer ${TEST_TOKEN}\r\nContent-Type: application/json\r\n` +
          `Accept: ${ACCEPT_HEADER}\r\nMcp-Method: tools/list\r\n` +
          `Content-Length: ${String(declaredBytes)}\r\n\r\n`,
      );
      const pump = (): void => {
        if (answered || sent >= declaredBytes) {
          return;
        }
        socket.write(chunk);
        sent += chunk.length;
        // Scheduling each chunk with setImmediate rather than looping
        // synchronously hands the event loop back, so an inbound response can
        // actually be observed BETWEEN chunks — a tight write loop would race
        // its own socket reads and overstate how much was in flight when the
        // answer arrived.
        setImmediate(pump);
      };
      pump();
    });
    socket.on('data', (received: Buffer) => {
      raw += received.toString('utf8');
      if (!answered) {
        answered = true;
        const statusLine = raw.split('\r\n')[0] ?? '';
        const match = /^HTTP\/1\.1 (?<status>\d+)/u.exec(statusLine);
        const statusText = match?.groups?.['status'];
        socket.destroy();
        resolve({
          status: statusText === undefined ? 0 : Number(statusText),
          headers: raw,
          bytesSentWhenAnswered: sent,
        });
      }
    });
    socket.on('error', (err) => {
      if (!answered) {
        reject(err);
      }
    });
  });

// Reads the JSON-RPC envelope out of a response that may be framed either as a
// bare JSON body (the modern leg) or as a one-event SSE stream (the legacy
// stateless leg frames its answers as `event: message` / `data: {...}`).
const envelopeFrom = (text: string): JsonRpcEnvelope => {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine === undefined ? text : dataLine.slice(6)) as JsonRpcEnvelope;
};

// Settles a pending response into a describable string either way — a request
// the server tears down mid-flight may answer with a status OR have its
// connection dropped, and this assertion only cares that it did not hang.
const describeOutcome = async (pending: Promise<Response>): Promise<string> => {
  try {
    const res = await pending;
    return `status ${String(res.status)}`;
  } catch (error) {
    return `rejected ${String(error)}`;
  }
};

// Polls a condition that becomes true on another turn of the event loop (an
// abort propagating from a destroyed socket into the dispatcher's signal),
// rather than sleeping a fixed amount and hoping.
const waitUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return predicate();
};

describe('createStreamableHttpServer — request guard front door', () => {
  it('denies a mismatched Host (403) and a disallowed Origin (403) with an EMPTY body — our guard answers, before the SDK handler is ever reached', async () => {
    const port = 4630;
    const server = makeServer(port);
    await server.listen();
    try {
      // `localhost:<port>` reaches the same listener but sends a Host header
      // that is not the exact allowedHost (`127.0.0.1:<port>`).
      const badHost = await fetch(`http://localhost:${String(port)}/`, {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(badHost.status).toBe(403);
      // A bodiless denial is what distinguishes OUR guard from any SDK-side
      // rejection: every SDK answer on this endpoint carries a JSON-RPC body.
      expect(await badHost.text()).toBe('');

      const badOrigin = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { origin: 'https://evil.example' }),
        body: JSON.stringify(modernBody(2, 'tools/list')),
      });
      expect(badOrigin.status).toBe(403);
      expect(await badOrigin.text()).toBe('');
    } finally {
      await server.close();
    }
  }, 15_000);

  it('denies a missing bearer and a wrong bearer with 401 — on POST, GET and DELETE alike', async () => {
    const port = 4631;
    const server = makeServer(port);
    await server.listen();
    try {
      const { authorization: _dropped, ...noAuthHeaders } = modernHeaders('tools/list');
      const noAuth = await fetch(urlFor(port), {
        method: 'POST',
        headers: noAuthHeaders,
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(noAuth.status).toBe(401);

      const wrongAuth = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { authorization: 'Bearer not-the-token' }),
        body: JSON.stringify(modernBody(2, 'tools/list')),
      });
      expect(wrongAuth.status).toBe(401);

      // GET and DELETE are answered 405 by the SDK once they pass the guard —
      // so a 401 here proves the guard runs on EVERY method, not just POST.
      const getNoAuth = await fetch(urlFor(port), { method: 'GET' });
      expect(getNoAuth.status).toBe(401);
      const deleteNoAuth = await fetch(urlFor(port), { method: 'DELETE' });
      expect(deleteNoAuth.status).toBe(401);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('fails CLOSED on a duplicated Host, Origin, or Authorization header — proves the guard reads req.headersDistinct, not the collapsing req.headers', async () => {
    const port = 4632;
    const server = makeServer(port);
    await server.listen();
    const body = JSON.stringify(modernBody(1, 'tools/list'));
    const modernRawHeaders =
      `Accept: ${ACCEPT_HEADER}\r\nContent-Type: application/json\r\n` +
      `MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/list\r\n`;
    try {
      // Using req.headers.host would silently keep ONLY the first (allowed)
      // value, wrongly passing the Host check; req.headersDistinct.host sees
      // BOTH values and fails closed.
      const duplicateHost = await rawRequest(
        port,
        `Host: 127.0.0.1:${String(port)}\r\nHost: evil.example:${String(port)}\r\n` +
          `Authorization: Bearer ${TEST_TOKEN}\r\n${modernRawHeaders}`,
        body,
      );
      expect(duplicateHost.status).toBe(403);

      // A duplicated Origin: `req.headers.origin` would comma-JOIN the two
      // values into one string; headersDistinct keeps them separate so the
      // guard sees a present-but-unresolvable Origin and 403s.
      const duplicateOrigin = await rawRequest(
        port,
        `Host: 127.0.0.1:${String(port)}\r\nOrigin: http://a.example\r\nOrigin: http://b.example\r\n` +
          `Authorization: Bearer ${TEST_TOKEN}\r\n${modernRawHeaders}`,
        body,
      );
      expect(duplicateOrigin.status).toBe(403);

      // Two Authorization headers where the FIRST is the real token: a
      // first-value read would authorize this request.
      const duplicateAuth = await rawRequest(
        port,
        `Host: 127.0.0.1:${String(port)}\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
          `Authorization: Bearer ${TEST_TOKEN}\r\n${modernRawHeaders}`,
        body,
      );
      expect(duplicateAuth.status).toBe(401);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — body cap and parse errors', () => {
  it('rejects an oversized body with 400/-32600, invalid JSON with 400/-32700, and invalid UTF-8 with 400/-32700', async () => {
    const port = 4633;
    const server = makeServer(port);
    await server.listen();
    try {
      const oversized = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: 'x'.repeat(4 * 1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(400);
      expect(((await oversized.json()) as JsonRpcEnvelope).error?.code).toBe(-32_600);

      const badJson = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: '{not json',
      });
      expect(badJson.status).toBe(400);
      expect(((await badJson.json()) as JsonRpcEnvelope).error?.code).toBe(-32_700);

      // An invalid UTF-8 byte (0xFF, built at runtime, never pasted — never
      // valid anywhere in a UTF-8 byte sequence) EMBEDDED inside an otherwise
      // well-formed JSON string literal: `{"a":"<0xFF>"}`. This shape is
      // deliberate, not incidental — it is what makes the assertion BINDING
      // rather than vacuous. A body of ONLY invalid bytes would already 400
      // either way, since lenient-decoding it to U+FFFD replacement characters
      // does not, by itself, produce valid JSON SYNTAX — so that case would
      // pass even without the fatal decode, proving nothing. Here, lenient
      // decoding instead yields `{"a":"<U+FFFD>"}` — syntactically VALID JSON —
      // which a non-fatal `toString('utf8')` would let straight through.
      const badUtf8 = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      });
      expect(badUtf8.status).toBe(400);
      expect(((await badUtf8.json()) as JsonRpcEnvelope).error?.code).toBe(-32_700);

      // An EMPTY body never reaches this module's own parse-error path: it
      // parses to `undefined` and is handed to the adapter as "nothing
      // pre-parsed", so the handler classifies and answers it. Both layers use
      // code -32700 here, which is why the assertion is on the MESSAGE — the
      // handler's own wording, not this module's.
      const empty = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: '',
      });
      expect(empty.status).toBe(400);
      const emptyBody = (await empty.json()) as JsonRpcEnvelope;
      expect(emptyBody.error?.message).not.toBe('Parse error: request body is not valid JSON');
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — Content-Type before parse', () => {
  it("answers a non-JSON Content-Type with the handler's 415 — even when the body is ALSO malformed, where this module's own parse error would otherwise pre-empt it", async () => {
    const port = 4647;
    const server = makeServer(port);
    await server.listen();
    try {
      // The discriminating case: text/plain AND unparseable. Parsing before
      // checking the media type answers 400/-32700 (this module's own
      // message) — the wrong status, from the wrong layer. The handler
      // settles the media type before it looks at any body, so 415 is the
      // contract-correct answer and -32700 the falsifier.
      const wrongTypeBadBody = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { 'content-type': 'text/plain' }),
        body: '{not json',
      });
      expect(wrongTypeBadBody.status).toBe(415);
      const rejected = (await wrongTypeBadBody.json()) as JsonRpcEnvelope;
      expect(rejected.error?.code).toBe(-32_000);
      expect(rejected.error?.message).toMatch(/Unsupported Media Type/u);

      // A well-formed body with the same wrong type: 415 too. Together with
      // the case above this pins that the media type — not the body — is what
      // decides, and that handing the handler the consumed-stream sentinel
      // does not derail its classification either way.
      const wrongTypeGoodBody = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { 'content-type': 'text/plain' }),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(wrongTypeGoodBody.status).toBe(415);
      expect(((await wrongTypeGoodBody.json()) as JsonRpcEnvelope).error?.code).toBe(-32_000);

      // NO Content-Type at all is not JSON-typed either — same 415.
      const { 'content-type': _dropped, ...headersWithoutType } = modernHeaders('tools/list');
      const noType = await fetch(urlFor(port), {
        method: 'POST',
        headers: headersWithoutType,
        body: JSON.stringify(modernBody(2, 'tools/list')),
      });
      expect(noType.status).toBe(415);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('serves application/json with a charset parameter normally — the media type is parsed, never substring-matched, so a parameterized spelling is not mis-bucketed into the 415 path', async () => {
    const port = 4648;
    const server = makeServer(port);
    await server.listen();
    try {
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { 'content-type': 'application/json; charset=utf-8' }),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as JsonRpcEnvelope).result?.resultType).toBe('complete');

      // And the parse error still belongs to this module when the type IS
      // json: the gate above must not have swallowed the -32700 path.
      const badJson = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { 'content-type': 'application/json; charset=utf-8' }),
        body: '{not json',
      });
      expect(badJson.status).toBe(400);
      const parseError = (await badJson.json()) as JsonRpcEnvelope;
      expect(parseError.error?.code).toBe(-32_700);
      expect(parseError.error?.message).toBe('Parse error: request body is not valid JSON');
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — out-of-band error sink', () => {
  it("reports what has no JSON-RPC reply to ride on: the handler's own rejection reason, and a body read that dies with its client", async () => {
    const port = 4649;
    const errors: Error[] = [];
    const server = makeServer(port, { onError: (error) => errors.push(error) });
    await server.listen();
    try {
      // Source 1 — the handler leg. The wire answer carries only the code and
      // a fixed message; the SPECIFIC reason exists nowhere else, which is
      // what the sink is for.
      const { 'mcp-method': _dropped, ...headersWithoutMethod } = modernHeaders('tools/list');
      const rejected = await fetch(urlFor(port), {
        method: 'POST',
        headers: headersWithoutMethod,
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(rejected.status).toBe(400);
      expect(errors.map((error) => error.message)).toContainEqual(
        expect.stringContaining('Rejected inbound request'),
      );

      // Source 2 — the pre-hand-off leg (this module's own request-level
      // catch), reached by a client that vanishes mid-body: the only wire
      // answer there is a BODYLESS 500, so without the sink the reason is
      // gone entirely.
      const beforeAbort = errors.length;
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
              `Mcp-Method: tools/list\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nshort`,
          );
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
        socket.on('error', reject);
      });
      expect(await waitUntil(() => errors.length > beforeAbort)).toBe(true);
      // Every entry is a genuine Error — the sink's signature promises one,
      // and the request-level catch is handed an `unknown` rejection value.
      expect(errors.every((error) => error instanceof Error)).toBe(true);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('stays silent when no sink is configured — an unservable request is still answered, and nothing throws for the missing callback', async () => {
    const port = 4650;
    const server = makeServer(port);
    await server.listen();
    try {
      const { 'mcp-method': _dropped, ...headersWithoutMethod } = modernHeaders('tools/list');
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: headersWithoutMethod,
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as JsonRpcEnvelope).error?.code).toBe(-32_020);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — 2026-07-28 request handling', () => {
  it('answers a modern tools/list with the configured cache hint (ttlMs 3600000, cacheScope private) and resultType complete', async () => {
    const port = 4634;
    const server = makeServer(port);
    await server.listen();
    try {
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as JsonRpcEnvelope;
      // No session header is minted on any response — the transport is
      // stateless by construction.
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(payload.result?.resultType).toBe('complete');
      // Falsification: dropping `cacheHints` from createProtocolSession's
      // ServerOptions leaves the SDK's own conservative defaults (ttlMs 0),
      // so this exact equality fails.
      expect(payload.result?.ttlMs).toBe(3_600_000);
      expect(payload.result?.cacheScope).toBe('private');
      expect(payload.result?.tools?.map((tool) => tool.name)).toContain(META_TOOL_NAME);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('dispatches a modern tools/call end to end', async () => {
    const port = 4635;
    const server = makeServer(port);
    await server.listen();
    try {
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/call', { 'mcp-name': META_TOOL_NAME }),
        body: JSON.stringify(modernBody(1, 'tools/call', { name: META_TOOL_NAME, arguments: {} })),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as JsonRpcEnvelope;
      expect(payload.result?.isError).toBe(false);
      expect(payload.result?.resultType).toBe('complete');
    } finally {
      await server.close();
    }
  }, 15_000);

  it('surfaces the SDK header/body validation ladder unswallowed: a missing Mcp-Method header 400s with -32020', async () => {
    const port = 4636;
    const server = makeServer(port);
    await server.listen();
    try {
      const { 'mcp-method': _dropped, ...headersWithoutMethod } = modernHeaders('tools/list');
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: headersWithoutMethod,
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      // Our front reads and re-parses the body before handing off; this pins
      // that it neither answers this itself nor loses the SDK's own answer.
      expect(res.status).toBe(400);
      expect(((await res.json()) as JsonRpcEnvelope).error?.code).toBe(-32_020);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('answers GET and DELETE with 405 + Allow: POST — the 2025-era session operations have no stateless equivalent, and this endpoint serves exactly one method', async () => {
    const port = 4637;
    const server = makeServer(port);
    await server.listen();
    try {
      const get = await fetch(urlFor(port), {
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect(((await get.json()) as JsonRpcEnvelope).error?.code).toBe(-32_000);

      const del = await fetch(urlFor(port), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(del.status).toBe(405);
      expect(del.headers.get('allow')).toBe('POST');
      expect(((await del.json()) as JsonRpcEnvelope).error?.code).toBe(-32_000);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('answers a HUGE non-POST body with 405 WHILE the client is still sending it — no method can make this process buffer an unbounded body', async () => {
    const port = 4645;
    const server = makeServer(port);
    await server.listen();
    const declaredBytes = 16 * 1024 * 1024; // 4x the 4 MB cap
    try {
      // Falsification (measured, not hypothetical): handing a non-POST to the
      // SDK adapter instead makes its request conversion read the WHOLE stream
      // into one string before the handler ever looks at the method — the 405
      // then arrives only after the last byte (bytesSentWhenAnswered ===
      // declaredBytes) and the process grows by more than the body. Both
      // assertions below fail in that arrangement; a 405-status-only assertion
      // would pass in BOTH, which is why the byte count is asserted too.
      const deleteResult = await streamOversizedRequest(port, 'DELETE', declaredBytes);
      expect(deleteResult.status).toBe(405);
      expect(deleteResult.headers).toMatch(/allow: POST/iu);
      expect(deleteResult.bytesSentWhenAnswered).toBeLessThan(4 * 1024 * 1024);

      // PUT, too: the gate keys on "not POST", not on a list of known methods,
      // so an unheard-of method cannot slip past it into the adapter.
      const putResult = await streamOversizedRequest(port, 'PUT', declaredBytes);
      expect(putResult.status).toBe(405);
      expect(putResult.bytesSentWhenAnswered).toBeLessThan(4 * 1024 * 1024);

      // The listener is unharmed by either — the connections were torn down
      // mid-body, exactly as an abandoned upload would be.
      const stillAlive = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(stillAlive.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('still serves a claim-less 2025-era POST (no initialize, no _meta claim) — legacy: stateless is set explicitly, so an old client keeps working against this same endpoint', async () => {
    const port = 4646;
    const server = makeServer(port);
    await server.listen();
    try {
      // No `Mcp-Method` header and no `_meta` envelope: nothing claims the
      // modern revision, so this is classified 2025-era. Auth still applies —
      // the bearer below is what gets it past the guard at all.
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: ACCEPT_HEADER,
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      // Falsification: switching the option to `legacy: 'reject'` answers this
      // with an unsupported-protocol-version error instead of the inventory.
      const payload = envelopeFrom(await res.text());
      expect(payload.result?.tools?.map((tool) => tool.name)).toContain(META_TOOL_NAME);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('ignores a stray Mcp-Session-Id header on a modern POST — the request still succeeds', async () => {
    const port = 4638;
    const server = makeServer(port);
    await server.listen();
    try {
      const res = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list', { 'mcp-session-id': 'left-over-from-a-2025-client' }),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(((await res.json()) as JsonRpcEnvelope).result?.resultType).toBe('complete');
    } finally {
      await server.close();
    }
  }, 15_000);

  it("a client that aborts a POST mid tools/call fires the dispatcher's AbortSignal — the 2026-era cancellation signal is the closed request stream, not a notifications/cancelled POST", async () => {
    const port = 4639;
    let abortObserved = false;
    const started = Promise.withResolvers<void>();
    const metaExecutor: MetaExecutor = (_snapshot, signal) => {
      const outcome = Promise.withResolvers<ToolCallOutcome>();
      const timer = setTimeout(() => outcome.resolve(textOutcome('never aborted', true)), 10_000);
      signal.addEventListener('abort', () => {
        abortObserved = true;
        clearTimeout(timer);
        outcome.resolve(textOutcome('aborted', true));
      });
      started.resolve();
      return outcome.promise;
    };
    const server = makeServer(port, { metaExecutor });
    await server.listen();
    const controller = new AbortController();
    try {
      const pending = fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/call', { 'mcp-name': META_TOOL_NAME }),
        body: JSON.stringify(modernBody(1, 'tools/call', { name: META_TOOL_NAME, arguments: {} })),
        signal: controller.signal,
      });
      // The handler must genuinely be inside the dispatcher before the abort —
      // aborting earlier would test the request never arriving, not
      // cancellation reaching a running call.
      await started.promise;
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(await waitUntil(() => abortObserved)).toBe(true);
    } finally {
      await server.close();
    }
  }, 20_000);
});

describe('createStreamableHttpServer — listener lifetime', () => {
  it('a second listen() on an already-bound port rejects instead of hanging (EADDRINUSE surfaces via the error listener)', async () => {
    const port = 4640;
    const first = makeServer(port);
    await first.listen();
    const second = makeServer(port);
    try {
      await expect(second.listen()).rejects.toThrow();
    } finally {
      await first.close();
      await second.close();
    }
  }, 15_000);

  it('a client that aborts mid-body (destroys the socket before sending Content-Length bytes) is handled cleanly — no crash, and the server keeps serving later requests', async () => {
    const port = 4641;
    const server = makeServer(port);
    await server.listen();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
              `Mcp-Method: tools/list\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nshort body`,
          );
          // Destroys the underlying TCP connection before the declared
          // Content-Length is fully sent — this makes the server's own `req`
          // stream emit 'error' (ECONNRESET/aborted), exercising
          // readBodyCapped's error-propagation path and, since nothing else
          // catches it, the request handler's own defensive `.catch()` — a
          // genuine, non-simulated client abort, not a mock.
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
        socket.on('error', reject);
      });

      const stillAlive = await fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify(modernBody(1, 'tools/list')),
      });
      expect(stillAlive.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — bounded graceful shutdown', () => {
  it('close() resolves promptly with an in-flight slow tools/call open — the SDK handler aborts its own exchange rather than pinning the listener', async () => {
    const port = 4642;
    const started = Promise.withResolvers<void>();
    const metaExecutor: MetaExecutor = (_snapshot, signal) => {
      const outcome = Promise.withResolvers<ToolCallOutcome>();
      const timer = setTimeout(() => outcome.resolve(textOutcome('never aborted', true)), 30_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        outcome.resolve(textOutcome('aborted', true));
      });
      started.resolve();
      return outcome.promise;
    };
    const server = makeServer(port, { metaExecutor });
    await server.listen();
    const callBody = JSON.stringify(
      modernBody(1, 'tools/call', { name: META_TOOL_NAME, arguments: {} }),
    );
    const inFlight = describeOutcome(
      fetch(urlFor(port), {
        method: 'POST',
        headers: modernHeaders('tools/call', { 'mcp-name': META_TOOL_NAME }),
        body: callBody,
      }),
    );
    await started.promise;
    const start = Date.now();
    await server.close();
    // Well BELOW SHUTDOWN_FORCE_MS (5000): the handler close aborts the
    // exchange so the response completes and the connection ends on its own.
    // A `< 10_000` bound would pass even on the forced-close fallback path,
    // leaving the handler-close step unfalsified.
    expect(Date.now() - start).toBeLessThan(4000);
    expect(await inFlight).toMatch(/^status /u);
  }, 20_000);

  it('a request stuck mid-body forces close() to fall back to closeAllConnections() at ~SHUTDOWN_FORCE_MS rather than hang forever', async () => {
    const port = 4643;
    const server = makeServer(port);
    await server.listen();
    const socket = connect(port, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          // A POST with a Content-Length far larger than what is ever actually
          // sent, and the socket is never destroyed — a genuinely ACTIVE
          // in-flight request from Node's own perspective (readBodyCapped is
          // still awaiting more 'data'), not merely an idle connection. The
          // SDK handler never sees it, so only the LISTENER phase of close()
          // is exercised here, forcing its bounded closeAllConnections()
          // fallback.
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
              `Mcp-Method: tools/list\r\nContent-Length: 1000000\r\n\r\nstuck`,
          );
          // A short delay so the write is actually received and the request is
          // registered as in-flight on the SERVER side before close() is
          // called — calling close() in the very same tick risks racing the
          // server's own connection/request bookkeeping.
          setTimeout(resolve, 200);
        });
        socket.once('error', reject);
      });
      const start = Date.now();
      await server.close();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(9000);
    } finally {
      socket.destroy();
    }
  }, 15_000);
});

describe('createStreamableHttpServer — HTTP request/header timeout hardening', () => {
  it("sets requestTimeout=30000 and headersTimeout=10000 on the underlying http.Server — both tightened below Node's own 300000/60000 defaults", async () => {
    const port = 4644;
    const createServerMock = vi.mocked(createServer);
    const callsBefore = createServerMock.mock.results.length;
    const server = makeServer(port);
    await server.listen();
    try {
      // The createServer call happens exactly once, synchronously, inside
      // createStreamableHttpServer itself (well before listen() is ever
      // called) — capturing the result at the call index recorded just above
      // (rather than always `.at(-1)`) keeps this binding to THIS server even
      // if another test's createServer call interleaves.
      const result = createServerMock.mock.results[callsBefore];
      if (result === undefined || result.type !== 'return') {
        throw new Error('node:http createServer was not called as expected');
      }
      const httpServerInstance = result.value;
      // Falsification: removing the two assignments leaves Node's own defaults
      // (300000/60000) — both these exact equalities AND the
      // below-Node's-defaults assertions would fail. Both values stay safely
      // ABOVE SHUTDOWN_FORCE_MS (5000) so neither can interfere with the
      // bounded graceful-shutdown path above.
      expect(httpServerInstance.requestTimeout).toBe(30_000);
      expect(httpServerInstance.headersTimeout).toBe(10_000);
      expect(httpServerInstance.requestTimeout).toBeLessThan(300_000);
      expect(httpServerInstance.headersTimeout).toBeLessThan(60_000);
    } finally {
      await server.close();
    }
  }, 15_000);
});

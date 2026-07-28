import { createServer } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createRedactor,
  createSessionStore,
  createStreamableHttpServer,
  SYSTEM_HEADERS,
  textOutcome,
  type NamedOperation,
  type RequestGuardOptions,
} from '../src/index.ts';

// A local fake standing in for the upstream executor (this suite tests HTTP
// session lifecycle, not execution) + a neutral redactor.
const noopExecutor = () =>
  Promise.resolve(textOutcome('no upstream executor configured in this test', true));
const NOOP_REDACTOR = createRedactor([]);

// The timeout-hardening coverage (near the bottom of this file) needs to inspect the ACTUAL
// http.Server instance createStreamableHttpServer builds internally — a
// value its public StreamableHttpServerHandle deliberately does not expose
// (there is no reason for a caller to ever reach the raw http.Server; the timeout hardening
// only tightens two Node-internal timeout properties on it). Rather than
// widen that public API for a single property assertion, this WRAPS (never
// replaces) node:http's own createServer to capture the instance it
// returns — every call still delegates straight through to the REAL
// implementation, so this is pure instrumentation: every other test in this
// file gets a genuine, fully-functional http.Server exactly as before.
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

describe('createSessionStore', () => {
  it('creates and retrieves a session', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 8, idleMs: 1000 });
    expect(store.create('s1', { value: 'a' }, 0)).toEqual({ ok: true });
    expect(store.get('s1', 0)).toEqual({ value: 'a' });
  });

  it('rejects creation beyond maxSessions', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 1, idleMs: 1000 });
    expect(store.create('s1', { value: 'a' }, 0)).toEqual({ ok: true });
    expect(store.create('s2', { value: 'b' }, 0)).toEqual({ ok: false, reason: 'capacity' });
  });

  it('treats a session idle past idleMs as absent (get returns undefined) — the 404 case', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 8, idleMs: 1000 });
    store.create('s1', { value: 'a' }, 0);
    expect(store.get('s1', 999)).toEqual({ value: 'a' });
    expect(store.get('s1', 1001)).toBeUndefined();
  });

  it('touch resets the idle clock', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 8, idleMs: 1000 });
    store.create('s1', { value: 'a' }, 0);
    store.touch('s1', 900);
    expect(store.get('s1', 1500)).toEqual({ value: 'a' }); // 1500 - 900 = 600 < 1000
  });

  it('remove frees capacity immediately', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 1, idleMs: 1000 });
    store.create('s1', { value: 'a' }, 0);
    store.remove('s1');
    expect(store.create('s2', { value: 'b' }, 0)).toEqual({ ok: true });
  });

  it('sweepExpired evicts every idle-expired session and returns their VALUES (not just ids), freeing capacity', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 1, idleMs: 1000 });
    store.create('s1', { value: 'a' }, 0);
    // Returns the VALUE, not the id — a caller (e.g. the HTTP transport
    // wiring) needs the actual session resource (a transport) to release
    // it, not merely a name to log.
    expect(store.sweepExpired(2000)).toEqual([{ value: 'a' }]);
    expect(store.size()).toBe(0);
    expect(store.create('s2', { value: 'b' }, 2000)).toEqual({ ok: true });
  });

  it('values() returns every currently-stored value WITHOUT evicting anything — used for a graceful-shutdown drain', () => {
    const store = createSessionStore<{ value: string }>({ maxSessions: 8, idleMs: 1000 });
    store.create('s1', { value: 'a' }, 0);
    store.create('s2', { value: 'b' }, 0);
    expect(store.values()).toEqual(expect.arrayContaining([{ value: 'a' }, { value: 'b' }]));
    expect(store.values()).toHaveLength(2);
    // Confirms it did NOT evict: both sessions are still retrievable even
    // past idleMs, since values() is a pure read, not a sweep.
    expect(store.size()).toBe(2);
  });
});

// A minimal fixture — this suite only ever sends `initialize`, never
// `tools/call`, so one trivial, argument-free operation is sufficient
// (mirrors the InMemory test's own fixture shape).
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
const buildWiringTestSnapshot = () => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

// A fixed port distinct from the CLI E2E suite's CANDIDATE_PORTS
// (serve-http.test.ts, 3999/4083/4177/4271) — a different test file and
// process, with no shared state, so a single fixed port (rather than that
// suite's own retry-across-candidates dance, which exists to survive a
// spawned SUBPROCESS's own startup race) is sufficient here.
const WIRING_TEST_PORT = 4610;
// The guard's bearer check (`isAuthorized`/`constantTimeEquals`) does not
// itself enforce the CLI's `isValidBearerToken` grammar (that gate runs
// only at CLI startup, in `serve.ts`) — any string works here since this
// test calls `createStreamableHttpServer` directly, bypassing the CLI.
const WIRING_TEST_TOKEN = 'wiring-test-bearer-token';
const ACCEPT_HEADER = 'application/json, text/event-stream';

describe('createStreamableHttpServer wiring — idle-expiry sweep bound to the HTTP request path (regression guard)', () => {
  it('after all 8 slots go idle-expired, a NEW initialize actually succeeds — proves capacity was truly freed, not merely masked at read time', async () => {
    let currentNow = 0;
    const now = (): number => currentNow;
    const guard: RequestGuardOptions = {
      allowedOrigins: new Set(),
      allowedHost: `127.0.0.1:${String(WIRING_TEST_PORT)}`,
      bearer: { configuredToken: WIRING_TEST_TOKEN },
    };
    const server = createStreamableHttpServer({
      name: 'wiring-test',
      version: '1.0.0',
      snapshot: buildWiringTestSnapshot(),
      dispatcherDeps: {
        limiter: { consume: () => true },
        now,
        executor: noopExecutor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
      guard,
      port: WIRING_TEST_PORT,
      now,
    });
    await server.listen();
    try {
      const initAt = (id: number): Promise<Response> =>
        fetch(`http://127.0.0.1:${String(WIRING_TEST_PORT)}/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: ACCEPT_HEADER,
            authorization: `Bearer ${WIRING_TEST_TOKEN}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'w', version: '1' },
            },
          }),
        });

      // Fill all 8 slots at t=0.
      for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- must land sequentially within the same 8-slot capacity
        const res = await initAt(index);
        expect(res.status).toBe(200);
      }

      // A 9th at t=0 correctly 503s — confirms the setup (capacity really
      // is exhausted right now), not yet testing eviction.
      const tooEarly = await initAt(8);
      expect(tooEarly.status).toBe(503);

      // Advance the injected clock past IDLE_MS (30 minutes) — every one
      // of the 8 sessions is now idle-expired. Nothing has touched
      // sessions.get()/sweepExpired() yet at this point; only the NEXT
      // request's own wiring call can reclaim the slots.
      currentNow = 30 * 60 * 1000 + 1;

      // A 10th initialize: if `evictExpiredSessions(nowMs)` is (still)
      // wired into the HTTP request path, it sweeps all 8 expired entries
      // out of the SessionStore's Map before THIS request's own capacity
      // check runs — freeing every slot, so this succeeds. If that wiring
      // call were removed (the original bug), the Map would still hold all
      // 8 entries — `sessions.get()`'s own per-read expiry check makes an
      // individual session LOOK gone on read, but never deletes it from the
      // Map or shrinks its size — so `sessions.create()` would still see
      // `size() >= maxSessions` and this would still 503.
      const reclaimed = await initAt(9);
      expect(reclaimed.status).toBe(200);
      expect(reclaimed.headers.get('mcp-session-id')).not.toBeNull();
    } finally {
      await server.close();
    }
  }, 20000);
});

// A block of distinct ports, one PER TEST, disjoint from both
// WIRING_TEST_PORT (4610) and the CLI E2E suite's CANDIDATE_PORTS — this
// describe block exercises every remaining request-routing branch of
// streamable-http.ts directly, in-process (guard denial, malformed/oversized
// bodies, an unknown session, GET/DELETE, the malformed-initialize rollback
// path, and an EADDRINUSE listen() failure). The CLI subprocess E2E suite
// (serve-http.test.ts) already proves these behaviors end-to-end through the
// real bin, but a spawned subprocess's own code never counts toward this
// package's v8 coverage — these in-process calls close that gap. A
// DISTINCT port per test (rather than one shared port reused across tests,
// each with its own server instance) avoids Node's own fetch() connection
// pool trying to reuse a keep-alive socket left over from a PRIOR test's
// already-closed server on the same port, which otherwise surfaces as a
// spurious ECONNRESET on the next test's first request.
describe('createStreamableHttpServer — direct in-process coverage of every request-routing branch', () => {
  const COVERAGE_TEST_TOKEN = 'coverage-test-bearer-token';
  const now = (): number => Date.now();

  const makeServer = (port: number) =>
    createStreamableHttpServer({
      name: 'coverage-test',
      version: '1.0.0',
      snapshot: buildWiringTestSnapshot(),
      dispatcherDeps: {
        limiter: { consume: () => true },
        now,
        executor: noopExecutor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
      guard: {
        allowedOrigins: new Set(),
        allowedHost: `127.0.0.1:${String(port)}`,
        bearer: { configuredToken: COVERAGE_TEST_TOKEN },
      },
      port,
      now,
    });

  const urlFor = (port: number): string => `http://127.0.0.1:${String(port)}/`;
  const authHeaders = (sessionId?: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept: ACCEPT_HEADER,
    authorization: `Bearer ${COVERAGE_TEST_TOKEN}`,
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
  });
  const initBody = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  });

  it('denies a request with no bearer (401) and a disallowed Origin (403) — the guard runs before any session/body logic', async () => {
    const port = 4611;
    const server = makeServer(port);
    await server.listen();
    try {
      const noAuth = await fetch(urlFor(port), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: ACCEPT_HEADER },
        body: JSON.stringify(initBody(1)),
      });
      expect(noAuth.status).toBe(401);

      const badOrigin = await fetch(urlFor(port), {
        method: 'POST',
        headers: { ...authHeaders(), origin: 'https://evil.example' },
        body: JSON.stringify(initBody(2)),
      });
      expect(badOrigin.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 15000);

  it('rejects a fresh-initialize POST with an oversized body (400/-32600) and invalid JSON (400/-32700), and a non-initialize POST with no session id (400/-32000)', async () => {
    const port = 4612;
    const server = makeServer(port);
    await server.listen();
    try {
      const oversized = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: 'x'.repeat(4 * 1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(400);
      const oversizedBody = (await oversized.json()) as { error?: { code: number } };
      expect(oversizedBody.error?.code).toBe(-32600);

      const badJson = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: '{not json',
      });
      expect(badJson.status).toBe(400);
      const badJsonBody = (await badJson.json()) as { error?: { code: number } };
      expect(badJsonBody.error?.code).toBe(-32700);

      // An invalid UTF-8 byte (0xFF, built at runtime, never pasted — never
      // valid anywhere in a UTF-8 byte sequence) EMBEDDED inside an
      // otherwise well-formed JSON string literal: `{"a":"<0xFF>"}`. This
      // shape is deliberate, not incidental — it is what makes the assertion
      // BINDING rather than vacuous. A body of ONLY invalid bytes (e.g. bare
      // 0xFF/0xFE) would already 400 either way, since `Buffer#toString('utf8')`
      // lenient-decoding it to U+FFFD replacement characters does not, by
      // itself, produce valid JSON SYNTAX — so that case would pass even
      // without the fix, proving nothing. Here, lenient decoding instead
      // yields `{"a":"�"}` — syntactically VALID JSON — which a
      // non-fatal `toString('utf8')` would let straight through to a 200.
      // `parseJsonBody`'s fatal `TextDecoder` throws on the invalid byte
      // BEFORE `JSON.parse` ever runs, so this reaches the same deliberate
      // 400/-32700 parse-error path as malformed JSON syntax.
      const badUtf8 = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      });
      expect(badUtf8.status).toBe(400);
      const badUtf8Body = (await badUtf8.json()) as { error?: { code: number } };
      expect(badUtf8Body.error?.code).toBe(-32700);

      const notInit = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      expect(notInit.status).toBe(400);
      const notInitBody = (await notInit.json()) as { error?: { code: number } };
      expect(notInitBody.error?.code).toBe(-32000);
    } finally {
      await server.close();
    }
  }, 15000);

  it('a malformed initialize (missing Accept header) 406s WITHOUT ever registering a session (session-slot rollback, direct)', async () => {
    const port = 4613;
    const server = makeServer(port);
    await server.listen();
    try {
      const malformed = await fetch(urlFor(port), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${COVERAGE_TEST_TOKEN}`,
        },
        body: JSON.stringify(initBody(4)),
      });
      expect(malformed.status).toBe(406);
      expect(malformed.headers.get('mcp-session-id')).toBeNull();

      // A real initialize right afterward still succeeds — the rollback
      // actually freed the slot the malformed attempt reserved.
      const real = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(initBody(5)),
      });
      expect(real.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 15000);

  it('an unknown session id 404s on POST, GET, and DELETE alike', async () => {
    const port = 4614;
    const server = makeServer(port);
    await server.listen();
    try {
      const post = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders('does-not-exist'),
        body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
      });
      expect(post.status).toBe(404);

      const get = await fetch(urlFor(port), {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${COVERAGE_TEST_TOKEN}`,
          'mcp-session-id': 'does-not-exist',
        },
      });
      expect(get.status).toBe(404);

      const del = await fetch(urlFor(port), {
        method: 'DELETE',
        headers: authHeaders('does-not-exist'),
      });
      expect(del.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 15000);

  // `fetch()` cannot send a DUPLICATED header (its Headers object dedupes on
  // write), so this drives a raw `node:net` socket instead — the same
  // pattern the mid-body/shutdown-fence tests below use — to put TWO
  // separate `Mcp-Session-Id` header lines on the wire. This is the only
  // in-process route to `strictSingleHeader`'s `length !== 1` branch and to
  // the `rawSessionIdHeader !== undefined` vs `sessionId === undefined`
  // divergence in streamable-http.ts's fresh-initialize gate: both are
  // otherwise exercised ONLY by serve-http.test.ts's spawned-subprocess E2E
  // suite, which vitest's v8 coverage never instruments.
  it('a POST with a DUPLICATED mcp-session-id header 404s instead of silently resolving to a session (T1 regression, in-process)', async () => {
    const port = 4621;
    const server = makeServer(port);
    await server.listen();
    const body = Buffer.from(JSON.stringify(initBody(20)), 'utf8');
    const socket = connect(port, '127.0.0.1');
    try {
      const response = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
        let raw = '';
        socket.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        socket.on('error', reject);
        socket.once('connect', () => {
          // Even though the body is a well-formed `initialize` request, the
          // DUPLICATED session-id header must take priority: the
          // fresh-initialize branch keys on `rawSessionIdHeader ===
          // undefined`, which is false here (the raw header IS present,
          // just invalid), so this never reaches `handleFreshInitialize`.
          // `strictSingleHeader` then returns undefined for a 2-length
          // array, so `sessionId` is also undefined — falling through to
          // the unknown-or-expired-session 404 gate, exactly like a
          // missing session id would, never like either duplicated value.
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${COVERAGE_TEST_TOKEN}\r\n` +
              `Mcp-Session-Id: dup-session-a\r\nMcp-Session-Id: dup-session-b\r\n` +
              `Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body.toString('utf8')}`,
          );
        });
        socket.on('end', () => {
          const statusLine = raw.split('\r\n')[0] ?? '';
          const match = /^HTTP\/1\.1 (?<status>\d+)/u.exec(statusLine);
          const statusText = match?.groups?.['status'];
          resolve({ status: statusText === undefined ? 0 : Number(statusText), raw });
        });
      });
      expect(response.status).toBe(404);
      // No `mcp-session-id` response header — this must never be mistaken
      // for a freshly-created session.
      expect(response.raw.toLowerCase()).not.toContain('mcp-session-id:');
    } finally {
      socket.destroy();
      await server.close();
    }
  }, 15000);

  it('a live session handles tools/list (POST), an SSE stream (GET), body-cap/parse-error POSTs, and DELETE termination', async () => {
    const port = 4615;
    const server = makeServer(port);
    await server.listen();
    try {
      const init = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(initBody(7)),
      });
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id');
      if (sessionId === null) {
        throw new Error('no session id returned');
      }

      const list = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
      });
      expect(list.status).toBe(200);

      const oversized = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(sessionId),
        body: 'x'.repeat(4 * 1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(400);

      const badJson = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(sessionId),
        body: '{not json',
      });
      expect(badJson.status).toBe(400);

      const sseController = new AbortController();
      const sse = await fetch(urlFor(port), {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${COVERAGE_TEST_TOKEN}`,
          'mcp-session-id': sessionId,
        },
        signal: sseController.signal,
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/u);
      sseController.abort();

      const del = await fetch(urlFor(port), { method: 'DELETE', headers: authHeaders(sessionId) });
      expect(del.status).not.toBe(404);

      const afterDelete = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      expect(afterDelete.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 15000);

  it('a second listen() on an already-bound port rejects instead of hanging (EADDRINUSE surfaces via the error listener)', async () => {
    const port = 4616;
    const first = makeServer(port);
    await first.listen();
    const second = makeServer(port);
    try {
      await expect(second.listen()).rejects.toThrow();
    } finally {
      await first.close();
    }
  }, 15000);

  it('a client that aborts mid-body (destroys the socket before sending Content-Length bytes) is handled cleanly — no crash, and the server keeps serving later requests', async () => {
    const port = 4617;
    const server = makeServer(port);
    await server.listen();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${COVERAGE_TEST_TOKEN}\r\n` +
              `Content-Length: 1000\r\nConnection: close\r\n\r\nshort body`,
          );
          // Destroys the underlying TCP connection before the declared
          // Content-Length is fully sent — this makes the server's own
          // `req` stream emit 'error' (ECONNRESET/aborted), exercising
          // readBodyCapped's error-propagation path (and, since nothing
          // else catches it, the outer request-handler's own defensive
          // `.catch()` in createStreamableHttpServer) — a genuine,
          // non-simulated client-abort, not a mock.
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
        socket.on('error', reject);
      });

      // The server is still alive and correctly serving a NEW request —
      // proves the aborted connection above did not crash the process or
      // leave the listener wedged.
      const stillAlive = await fetch(urlFor(port), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(initBody(10)),
      });
      expect(stillAlive.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 15000);

  it('a request stuck mid-body (no session yet, so the session-drain phase never touches it) forces close() to fall back to closeAllConnections() at ~SHUTDOWN_FORCE_MS, rather than hang forever', async () => {
    const port = 4618;
    const server = makeServer(port);
    await server.listen();
    const socket = connect(port, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          // A POST with a Content-Length far larger than what is ever
          // actually sent, and the socket is never destroyed — a
          // genuinely ACTIVE in-flight request from Node's own
          // perspective (readBodyCapped is still awaiting more 'data'),
          // not merely an idle connection. Since no session id is
          // attached and the body never finishes arriving,
          // `handleFreshInitialize` is never reached and no session is
          // ever created — so `close()`'s FIRST phase (draining every
          // KNOWN session's server) has nothing to do with this
          // connection at all; only the SECOND phase
          // (`httpServer.close()`, which waits for every existing
          // connection) is what this exercises, forcing its own bounded
          // `closeAllConnections()` fallback at ~SHUTDOWN_FORCE_MS.
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${COVERAGE_TEST_TOKEN}\r\n` +
              `Content-Length: 1000000\r\n\r\nstuck`,
          );
          // A short delay so the write is actually received and the
          // request is registered as in-flight on the SERVER side before
          // close() is called — calling close() in the very same tick as
          // the write risks racing the server's own 'connection'/request
          // bookkeeping (confirmed empirically: without this delay,
          // close() can return near-instantly instead of waiting on this
          // connection at all).
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
  }, 12000);

  it('a fresh initialize whose body only finishes arriving AFTER shutdown has begun is rejected with 503, never admitted (shutdown admission fence)', async () => {
    const port = 4619;
    const server = makeServer(port);
    await server.listen();
    const fullBody = Buffer.from(JSON.stringify(initBody(11)), 'utf8');
    // Held back: the LAST byte of the body, so the request is genuinely
    // in-flight (readBodyCapped still awaiting more 'data') until the write
    // below deliberately completes it.
    const splitAt = fullBody.length - 1;
    const head = fullBody.subarray(0, splitAt);
    const tail = fullBody.subarray(splitAt);
    let closePromise: Promise<void> | undefined;
    const socket = connect(port, '127.0.0.1');
    try {
      const status = await new Promise<number>((resolve, reject) => {
        let raw = '';
        socket.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        socket.on('error', reject);
        socket.once('connect', () => {
          socket.write(
            `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
              `Content-Type: application/json\r\nAuthorization: Bearer ${COVERAGE_TEST_TOKEN}\r\n` +
              `Content-Length: ${String(fullBody.length)}\r\nConnection: close\r\n\r\n${head.toString('utf8')}`,
          );
          // Same margin as the "stuck mid-body" test above: gives the
          // server time to actually register the connection and begin
          // reading before shutdown starts.
          setTimeout(() => {
            // Begin shutdown NOW. `closing` flips to true SYNCHRONOUSLY —
            // the very first statement in close(), before its own first
            // await — so by the time this call returns control here,
            // admission is already fenced off, even though close() itself
            // is still pending (draining zero sessions, since none exist
            // yet, then waiting on THIS very connection to finish before
            // its own httpServer.close() phase can resolve).
            closePromise = server.close();
            // NOW complete the body. The request can only reach
            // handleFreshInitialize's `closing` check once the FULL body
            // has arrived — which is after this write — so the check
            // deterministically observes closing === true, not a race.
            socket.write(tail);
          }, 200);
        });
        socket.on('end', () => {
          const statusLine = raw.split('\r\n')[0] ?? '';
          const match = /^HTTP\/1\.1 (?<status>\d+)/u.exec(statusLine);
          const statusText = match?.groups?.['status'];
          resolve(statusText === undefined ? 0 : Number(statusText));
        });
      });
      // 503, not 200: removing the `closing` check would let this
      // late-completing body still finish initialization normally (200 + a
      // session id) even though close()'s own session-drain snapshot
      // (sessions.values(), taken before this request ever created one)
      // would never have included it — leaving it permanently undrained.
      expect(status).toBe(503);
    } finally {
      socket.destroy();
      await (closePromise ?? server.close());
    }
  }, 15000);
});

describe('createStreamableHttpServer — HTTP request/header timeout hardening', () => {
  const now = (): number => Date.now();

  it("sets requestTimeout=30000 and headersTimeout=10000 on the underlying http.Server — both tightened below Node's own 300000/60000 defaults", async () => {
    const port = 4620;
    const token = 'h4-test-bearer-token';
    const createServerMock = vi.mocked(createServer);
    const callsBefore = createServerMock.mock.results.length;
    const server = createStreamableHttpServer({
      name: 'h4-test',
      version: '1.0.0',
      snapshot: buildWiringTestSnapshot(),
      dispatcherDeps: {
        limiter: { consume: () => true },
        now,
        executor: noopExecutor,
        metaExecutor: createMetaExecutor(),
        redactor: NOOP_REDACTOR,
      },
      guard: {
        allowedOrigins: new Set(),
        allowedHost: `127.0.0.1:${String(port)}`,
        bearer: { configuredToken: token },
      },
      port,
      now,
    });
    await server.listen();
    try {
      // The createServer call happens exactly once, synchronously, inside
      // createStreamableHttpServer itself (well before listen() is ever
      // called) — capturing the result at the call index recorded just
      // above (rather than always `.at(-1)`) keeps this binding to THIS
      // server even if another test's createServer call interleaves.
      const result = createServerMock.mock.results[callsBefore];
      if (result === undefined || result.type !== 'return') {
        throw new Error('node:http createServer was not called as expected');
      }
      const httpServerInstance = result.value;
      // Falsification: removing the two assignments in streamable-http.ts
      // leaves Node's own defaults (300000/60000) — both these exact
      // equalities AND the below-Node's-defaults assertions would fail.
      expect(httpServerInstance.requestTimeout).toBe(30_000);
      expect(httpServerInstance.headersTimeout).toBe(10_000);
      expect(httpServerInstance.requestTimeout).toBeLessThan(300_000);
      expect(httpServerInstance.headersTimeout).toBeLessThan(60_000);
    } finally {
      await server.close();
    }
  }, 15000);
});

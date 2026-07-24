import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));
const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
// A real 43-char unpadded Base64URL token decoding to exactly 32 bytes (256
// bits) — the grammar `isValidBearerToken` (Task 7, corrected) actually
// requires; a bare ">=32 chars" string like the old `'A'.repeat(32)` fixture
// would now be REJECTED at CLI startup.
const TOKEN = 'A'.repeat(43);
// Candidate ports tried in order (LOW fix): rather than a single fixed port
// that can flake under a concurrent CI run/leftover process, retry against a
// small pool and skip a candidate whose bind fails — the CLI's own
// 'error'-listener fix (Step 3) makes an EADDRINUSE failure exit promptly
// with a nonzero code instead of hanging, which is what makes retrying here
// safe/bounded.
const CANDIDATE_PORTS = [3999, 4083, 4177, 4271];
const ACCEPT_HEADER = 'application/json, text/event-stream'; // POST requires BOTH (v1.29 transport requirement — see Verified Facts)

const url = (port: number): string => `http://127.0.0.1:${String(port)}/`;

const authHeaders = (sessionId?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: ACCEPT_HEADER,
  authorization: `Bearer ${TOKEN}`,
  ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
});

const postJsonRpc = (
  port: number,
  sessionId: string | undefined,
  body: unknown,
  headerOverrides: Record<string, string> = {},
): Promise<Response> =>
  fetch(url(port), {
    method: 'POST',
    headers: { ...authHeaders(sessionId), ...headerOverrides },
    body: JSON.stringify(body),
  });

// Races an exit-signal promise against a bounded poll loop, rather than a
// mutable `exited` flag checked at the top of the loop: the loop's own
// condition (elapsed time vs. timeoutMs) is what changes each iteration, so
// there is no loop condition that a linter can (correctly or not) flag as
// never mutated.
const waitForPortOrExit = (
  proc: ReturnType<typeof spawn>,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> => {
  const exited = new Promise<false>((resolve) => {
    proc.once('exit', () => resolve(false));
  });
  const poll = async (): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      try {
        await fetch(url(port), { method: 'POST', headers: authHeaders(), body: '{}' });
        return true;
      } catch {
        // eslint-disable-next-line no-await-in-loop -- a bounded liveness poll must sleep between attempts, sequentially, by design
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    return false;
  };
  return Promise.race([exited, poll()]);
};

// Spawns `serve --http`, retrying across CANDIDATE_PORTS if a bind fails
// (EADDRINUSE) — returns the process AND the port it actually landed on.
const spawnServeHttp = async (
  extraArgs: readonly string[] = [],
): Promise<{ proc: ReturnType<typeof spawn>; port: number }> => {
  for (const port of CANDIDATE_PORTS) {
    const proc = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--http',
        '--port',
        String(port),
        '--http-token-env',
        'MCP_TOKEN',
        ...extraArgs,
      ],
      { cwd: fixturesDir, env: { ...process.env, MCP_TOKEN: TOKEN } },
    );
    // eslint-disable-next-line no-await-in-loop -- sequential candidate probing is intentional here
    const up = await waitForPortOrExit(proc, port);
    if (up) {
      return { proc, port };
    }
    proc.kill('SIGKILL');
  }
  throw new Error('serve --http never came up on any candidate port');
};

// Decodes an HTTP/1.1 chunked-transfer body (size-in-hex\r\n<bytes>\r\n,
// repeated, terminated by a 0-size chunk) back to plain text. Needed
// because the two competing code paths the T1 test below distinguishes
// respond with DIFFERENT framing for the exact same raw request — this
// module's own jsonRpcError() ends up chunked, while the MCP SDK
// transport's own rejection path sets a plain Content-Length — so the raw
// response text must be decoded uniformly to compare their JSON bodies.
const decodeChunkedBody = (raw: string): string => {
  let decoded = '';
  let rest = raw;
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    const chunkStart = lineEnd + 2;
    decoded += rest.slice(chunkStart, chunkStart + size);
    rest = rest.slice(chunkStart + size + 2); // Skip the chunk's own trailing CRLF
  }
  return decoded;
};

// Sends a raw HTTP/1.1 request over a plain TCP socket — used for the
// duplicate-Host test and the duplicate-session-id test below, since
// fetch() cannot send two headers with the same name in one request (the
// very thing that would otherwise make either case untestable at the E2E
// tier). `method` defaults to 'POST' to preserve every existing call site.
// Returns the decoded response BODY alongside the status: the duplicate
// session-id test needs to inspect the JSON-RPC error message, not just the
// HTTP status, to actually discriminate the T1 regression (see that test's
// own comment for why the status code alone is not enough).
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
      const headerBlock = separatorIndex === -1 ? '' : raw.slice(0, separatorIndex);
      const rawBody = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 4);
      const isChunked = /transfer-encoding:\s*chunked/iu.test(headerBlock);
      resolve({
        status: statusText === undefined ? 0 : Number(statusText),
        body: isChunked ? decodeChunkedBody(rawBody) : rawBody,
      });
    });
    socket.on('error', reject);
  });

// A monotonically increasing JSON-RPC id generator, returned as a `const`
// closure rather than a bare `let` counter directly inside the describe
// block below: the mutable state lives inside this factory's own closure,
// not as a reassigned describe-scope variable.
const makeIdGenerator = (): (() => number) => {
  let current = 1;
  return () => current++;
};

describe('serve --http — Streamable HTTP E2E', () => {
  let child: ReturnType<typeof spawn> | undefined;
  const nextId = makeIdGenerator();
  const initializeBody = () => ({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  });
  const initSession = async (port: number): Promise<string> => {
    const res = await postJsonRpc(port, undefined, initializeBody());
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId === null) {
      throw new Error('serve --http did not return a session id on initialize');
    }
    return sessionId;
  };

  afterEach(() => {
    child?.kill('SIGKILL');
    child = undefined;
  });

  it('initializes, returns a session header, rejects a stale session with 404, requires the bearer on every method, and 403s a bad Origin', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const sessionId = await initSession(port);

    const staleDelete = await fetch(url(port), {
      method: 'DELETE',
      headers: authHeaders('does-not-exist'),
    });
    expect(staleDelete.status).toBe(404);

    const noAuth = await fetch(url(port), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT_HEADER,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' }),
    });
    expect(noAuth.status).toBe(401);

    const badOrigin = await fetch(url(port), {
      method: 'POST',
      headers: { ...authHeaders(sessionId), origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' }),
    });
    expect(badOrigin.status).toBe(403);

    child.kill('SIGTERM');
  }, 15000);

  it('rejects --http without --http-token-env at startup (usage error)', async () => {
    child = spawn(process.execPath, [bin, 'serve', '--spec', 'petstore.json', '--http'], {
      cwd: fixturesDir,
    });
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2);
  });

  it('validates HTTP-specific options (a bad --port) BEFORE any spec/cache/network processing — the error is about the port, never about the (nonexistent) spec file', async () => {
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'does-not-exist.json',
        '--http',
        '--port',
        '999999',
        '--http-token-env',
        'MCP_TOKEN',
      ],
      { cwd: fixturesDir, env: { ...process.env, MCP_TOKEN: TOKEN } },
    );
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2); // EXIT.USAGE — a bad --port, never touched runSpecPipeline
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    expect(stderrText).toMatch(/port/iu);
    // If option validation happened AFTER the spec pipeline (the ordering
    // bug this fixes), the error would instead be about the missing spec
    // file — asserting its ABSENCE here is what proves the ordering, not
    // just that SOME error occurred.
    expect(stderrText).not.toMatch(/does-not-exist|ENOENT|no such file/iu);
  });

  it('an authenticated request reuses the REAL registered session — deleting it makes the SAME id 404 on the next request (not silently accepted forever)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionId = await initSession(port);

    const list = await postJsonRpc(port, sessionId, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(list.status).toBe(200);

    const del = await fetch(url(port), { method: 'DELETE', headers: authHeaders(sessionId) });
    expect(del.status).not.toBe(404); // A live session accepts termination

    const reuseAfterDelete = await postJsonRpc(port, sessionId, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(reuseAfterDelete.status).toBe(404); // The SAME id no longer resolves to a session
  }, 15000);

  it('supports a SECOND, independent concurrent session — each gets its own id and both work', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionA = await initSession(port);
    const sessionB = await initSession(port);
    expect(sessionA).not.toBe(sessionB);

    const callA = await postJsonRpc(port, sessionA, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    const callB = await postJsonRpc(port, sessionB, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(callA.status).toBe(200);
    expect(callB.status).toBe(200);
  }, 15000);

  it('SESSION ISOLATION: terminating session A does not disturb session B', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionA = await initSession(port);
    const sessionB = await initSession(port);

    await fetch(url(port), { method: 'DELETE', headers: authHeaders(sessionA) });
    const stillA = await postJsonRpc(port, sessionA, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(stillA.status).toBe(404); // A is really gone

    const stillB = await postJsonRpc(port, sessionB, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(stillB.status).toBe(200); // B is entirely unaffected
  }, 15000);

  it('rejects an UNAUTHENTICATED GET and DELETE (401) — auth is required on every HTTP method, not just POST', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionId = await initSession(port);

    const getNoAuth = await fetch(url(port), {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
    });
    expect(getNoAuth.status).toBe(401);

    const deleteNoAuth = await fetch(url(port), {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    expect(deleteNoAuth.status).toBe(401);
  }, 15000);

  it('enforces the max-8-concurrent-session cap — the 9th initialize is rejected cleanly and no dangling session id 404s later', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- sessions must be created sequentially to land within the same 8-slot capacity
      sessionIds.push(await initSession(port));
    }
    const ninth = await postJsonRpc(port, undefined, initializeBody());
    expect(ninth.status).toBe(503);
    expect(ninth.headers.get('mcp-session-id')).toBeNull(); // No dangling session id was ever handed out

    // Every one of the original 8 still works — capacity was not corrupted
    // by the rejected 9th attempt.
    const stillWorks = await postJsonRpc(port, sessionIds[0], {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    expect(stillWorks.status).toBe(200);
  }, 20000);

  it('a BURST of 9 concurrent initialize requests still admits at most 8 sessions with 8 DISTINCT ids and no dangling session — a genuine concurrency race, not a sequential approximation of one', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    // All 9 fired together via Promise.all (not awaited one-by-one) — this
    // is what actually exercises the synchronous-reservation fix (Step 3):
    // a callback-based ("check capacity, then await, then register")
    // design could let more than 8 of these all pass their own capacity
    // check before any of them finishes registering.
    const responses = await Promise.all(
      Array.from({ length: 9 }, () => postJsonRpc(port, undefined, initializeBody())),
    );
    const succeeded = responses.filter((res) => res.status === 200);
    const rejected = responses.filter((res) => res.status === 503);
    expect(succeeded).toHaveLength(8);
    expect(rejected).toHaveLength(1);
    const sessionIds = succeeded.map((res) => res.headers.get('mcp-session-id'));
    expect(new Set(sessionIds).size).toBe(8); // Every admitted session got a DISTINCT id — none collided or was double-counted
  }, 20000);

  it('a malformed initialize (missing Accept header) never consumes a session-capacity slot — 8 of them in a row still leave room for a 9th REAL initialize (C4-rollback regression guard)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    for (let index = 0; index < 8; index += 1) {
      // Shaped exactly like an initialize request but missing the Accept
      // header entirely — the SDK's handlePostRequest validates Accept
      // BEFORE ever reaching the isInitializeRequest branch that assigns a
      // sessionId and fires onsessioninitialized (verified against the
      // v1.29.0 source, webStandardStreamableHttp.js — see Verified Facts
      // above), so this must 406 WITHOUT ever touching session capacity.
      // Without the C4-rollback fix (Step 3's `handleFreshInitialize`), the
      // slot reserved synchronously BEFORE the transport is even
      // constructed would never be released, and 8 of these would
      // permanently exhaust the 8-session cap.
      // eslint-disable-next-line no-await-in-loop -- sequential so each malformed attempt's (non-)effect on capacity is observed before the next
      const malformed = await fetch(url(port), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, // No Accept header
        body: JSON.stringify(initializeBody()),
      });
      expect(malformed.status).toBe(406);
      expect(malformed.headers.get('mcp-session-id')).toBeNull();
    }
    const ninth = await initSession(port); // A real, well-formed initialize — asserts status 200 and a session id internally
    expect(typeof ninth).toBe('string');
  }, 20000);

  it('a duplicate Host header (one allowed value + one evil value) is rejected — proves the guard reads req.headersDistinct, not the collapsing req.headers', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const duplicateHostHeaders =
      `Host: 127.0.0.1:${String(port)}\r\n` +
      `Host: evil.example:${String(port)}\r\n` +
      `Accept: ${ACCEPT_HEADER}\r\n` +
      `Content-Type: application/json\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n`;
    const result = await rawRequest(port, duplicateHostHeaders, JSON.stringify(initializeBody()));
    // Using req.headers.host would silently keep ONLY the first (allowed) value,
    // wrongly passing the Host guard and letting the request through;
    // req.headersDistinct.host sees BOTH values and fails closed (403).
    expect(result.status).toBe(403);
  }, 15000);

  it('a duplicated mcp-session-id header (the SAME valid session id sent twice) is rejected by THIS module own 404 gate, not merely by the SDK transport downstream (T1 regression guard)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionId = await initSession(port);

    // DELETE, not POST: a POST with an unresolved session id is, by design,
    // routed to the fresh-initialize path (it is the only way a client ever
    // ACQUIRES a session id in the first place), so it cannot discriminate
    // this case on its own. DELETE has no such special-casing — an
    // unresolved session id there goes straight to this module's own 404
    // gate, exactly the code path the strict helper protects. A single
    // 'mcp-session-id' header with this same id is already proven to
    // succeed (not 404) by the earlier "reuses the REAL registered session"
    // test above, so sending it twice is what makes this otherwise-working
    // request fail.
    const duplicateSessionHeaders =
      `Host: 127.0.0.1:${String(port)}\r\n` +
      `Accept: ${ACCEPT_HEADER}\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n` +
      `Mcp-Session-Id: ${sessionId}\r\n` +
      `Mcp-Session-Id: ${sessionId}\r\n`;
    const result = await rawRequest(port, duplicateSessionHeaders, '', 'DELETE');
    expect(result.status).toBe(404);
    // The status code ALONE does not discriminate the T1 regression: the
    // MCP SDK transport's OWN session check (webStandardStreamableHttp.js's
    // validateSession) ALSO independently 404s on ANY duplicated
    // mcp-session-id — its header read goes through the Web-standard
    // Headers.get(), which comma-joins repeated headers into one string
    // that can never equal a real (UUID) session id — so a bare
    // `expect(status).toBe(404)` would pass EVEN with the loose
    // `value[0]`-style helper reinstated (verified empirically while
    // building this test: the loose helper still 404s here, just via a
    // DIFFERENT layer). What the strict helper actually changes is WHICH
    // layer answers: this module's OWN 404 gate now fires — with the
    // message below — strictly BEFORE the request ever reaches
    // transport.handleRequest, whereas the loose helper would resolve the
    // duplicate to its real, matching session id, sail past this gate, and
    // rely ENTIRELY on the SDK's own downstream rejection (message
    // 'Session not found', not this one) to save it. Asserting the exact
    // message text is what makes this test bind to the actual T1 change.
    const parsedBody = JSON.parse(result.body) as { error?: { code: number; message: string } };
    expect(parsedBody.error?.message).toBe('unknown or expired session');
  }, 15000);

  it('a POST carrying a DUPLICATED mcp-session-id header plus a valid initialize body is 404d, never fresh-initialized (T1 regression: fresh-init must key on the RAW header being ABSENT, not on the strict helper resolving to undefined)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    // Two DIFFERENT values, sent as two separate header lines: the strict
    // helper (`strictSingleHeader`) resolves ANY duplicated header —
    // matching or not — to `undefined`, same as a genuinely absent header.
    // Before the fix, `handleRequest` gated the fresh-initialize branch on
    // that same `sessionId === undefined` value, so a POST + initialize
    // body with a duplicated header would be MISREAD as "no session id
    // yet" and fresh-initialize a NEW session (200 + a new
    // `mcp-session-id`) instead of 404ing. The fix reads the RAW header
    // (`req.headersDistinct['mcp-session-id']`) for the fresh-init gate
    // instead: it is PRESENT (length 2) here, so the branch is skipped and
    // the request falls through to the existing 404 gate below, exactly
    // like the DELETE case above.
    const duplicateSessionInitHeaders =
      `Host: 127.0.0.1:${String(port)}\r\n` +
      `Accept: ${ACCEPT_HEADER}\r\n` +
      `Content-Type: application/json\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n` +
      `Mcp-Session-Id: id1\r\n` +
      `Mcp-Session-Id: id2\r\n`;
    const result = await rawRequest(
      port,
      duplicateSessionInitHeaders,
      JSON.stringify(initializeBody()),
    );
    // Falsification: on the PRE-FIX `sessionId === undefined` gate, this
    // exact request fresh-initializes — status 200, a new `mcp-session-id`
    // header, and no JSON-RPC error. Confirmed by re-running this test
    // against the pre-fix code, where it failed with `expected 200 to be
    // 404`. On the POST-FIX `rawSessionIdHeader === undefined` gate, it
    // 404s with this module's own "unknown or expired session" gate — the
    // same message the DELETE-based test above asserts — proving the fix
    // routes the duplicate to the 404 gate rather than the SDK's own
    // downstream rejection.
    expect(result.status).toBe(404);
    const parsedBody = JSON.parse(result.body) as { error?: { code: number; message: string } };
    expect(parsedBody.error?.message).toBe('unknown or expired session');
  }, 15000);

  it('enforces the 4 MB inbound body cap with a DELIBERATE 400 (not a socket reset/500) — and rejects invalid JSON with a 400 JSON-RPC parse error, not a 500', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionId = await initSession(port);

    const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
    const tooBig = await fetch(url(port), {
      method: 'POST',
      headers: authHeaders(sessionId),
      body: oversized,
    });
    expect(tooBig.status).toBe(400);
    const tooBigJson = (await tooBig.json()) as { error?: { code: number } };
    expect(tooBigJson.error?.code).toBe(-32600);

    const badJson = await fetch(url(port), {
      method: 'POST',
      headers: authHeaders(sessionId),
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as { error?: { code: number } };
    expect(badJsonBody.error?.code).toBe(-32700);
  }, 15000);

  it('GLOBAL rate exhaustion is SHARED across sessions (proves the limiter is process-shared, not per-session)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionA = await initSession(port);
    const sessionB = await initSession(port);
    // DEFAULT_RATE_LIMIT is 120 tools/call invocations / 60s, process-wide.
    // `tools/list` itself is a protocol-level method the low-level Server
    // answers directly (Task 5) and NEVER reaches the Task 3/4 rate
    // limiter — only `tools/call` does — so every call here targets
    // `tools/call` on the read-only `openapi_mcp_status` meta tool.
    // Alternate between the two sessions so no single session's own
    // traffic could explain an eventual rejection — only a SHARED budget
    // does. The rate-exhausted signal is a dispatcher-level `isError`
    // result INSIDE a 200 JSON-RPC envelope, never an HTTP status code —
    // asserting on the HTTP status here would pass vacuously.
    const toolsCallBody = () => ({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name: 'openapi_mcp_status', arguments: {} },
    });
    let lastBody: { result?: { isError?: boolean; content?: { text: string }[] } } | undefined;
    for (let index = 0; index < 121; index += 1) {
      const session = index % 2 === 0 ? sessionA : sessionB;
      // eslint-disable-next-line no-await-in-loop -- exhausting a shared rate limit requires strictly sequential calls
      const res = await postJsonRpc(port, session, toolsCallBody());
      // eslint-disable-next-line no-await-in-loop -- reading each response body sequentially, matching the request above
      lastBody = (await res.json()) as typeof lastBody;
    }
    expect(lastBody?.result?.isError).toBe(true);
    expect(lastBody?.result?.content?.[0]?.text).toBe(
      'rate limit exceeded — too many tool calls; retry later',
    );
  }, 30000);

  it('graceful SIGINT/SIGTERM exits 0 and completes within the shutdown bound, EVEN WITH an active, long-lived SSE (GET) connection deliberately left open', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const sessionId = await initSession(port);

    // Open a GET (SSE) stream and deliberately never consume/close its body
    // from our side — this is the concrete scenario that would keep
    // http.Server#close() pending indefinitely without the
    // transport/session-draining fix (Step 3's `close()`): an ordinary POST
    // connection closes itself once its response is sent, so it would NOT
    // actually exercise this bug.
    //
    // AWAIT the fetch itself — per the Fetch spec, the returned promise
    // resolves as soon as the RESPONSE HEADERS arrive (the body stays an
    // unconsumed ReadableStream, which is exactly what we want: open, but
    // never read). This makes the SSE connection DETERMINISTICALLY open
    // before SIGTERM fires below. An earlier version of this test fired
    // `child.kill('SIGTERM')` immediately after issuing the GET, without
    // awaiting anything first — racing the connection's actual
    // establishment (a TCP connect + the server accepting it + routing to
    // the SSE handler, none of which is instantaneous) against the signal.
    // Under that race, SIGTERM could arrive before the connection existed
    // at all, silently degrading this test to the same "ordinary POST that
    // closes itself" case the comment above says is NOT what this test is
    // for — passing for the wrong reason on a slow CI box, or flaking on a
    // fast one.
    const sseController = new AbortController();
    const sseResponse = await fetch(url(port), {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        authorization: `Bearer ${TOKEN}`,
      },
      signal: sseController.signal,
    });
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toMatch(/text\/event-stream/u);

    const start = Date.now();
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
    // H3 (round-3 fix): the bound MUST be BELOW SHUTDOWN_FORCE_MS (5000ms), not
    // above it. A graceful session drain closes the open SSE transport
    // immediately, so `httpServer.close()`'s callback fires and the child exits
    // in well under a second (the sub-4s figure is almost all fixed
    // process-teardown overhead, not shutdown work). If the drain is BROKEN, the
    // open SSE keeps `httpServer.close()` pending until the bounded
    // `closeAllConnections()` fallback forcibly destroys it at ~5000ms — so the
    // process would only exit at ~SHUTDOWN_FORCE_MS. A `< 10_000` bound would
    // pass in BOTH cases (5s < 10s), leaving the drain unfalsified; `< 4000`
    // passes ONLY on a real graceful drain and fails on the 5s forced-close
    // fallback path.
    expect(Date.now() - start).toBeLessThan(4000);
    sseController.abort();
  }, 15000);
});

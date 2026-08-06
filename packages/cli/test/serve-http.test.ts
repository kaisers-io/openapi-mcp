import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));
const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
// A real 43-char unpadded Base64URL token decoding to exactly 32 bytes (256
// bits) — the shape `isValidBearerToken` requires; a bare ">=32 chars"
// string such as 'A'.repeat(32) does not decode to 32 bytes and is REJECTED
// at CLI startup.
const TOKEN = 'A'.repeat(43);
// Candidate ports tried in order rather than a single fixed port that can
// flake under a concurrent CI run/leftover process: retry against a small
// pool and skip a candidate whose bind fails — the CLI's own
// 'error'-listener handling makes an EADDRINUSE failure exit promptly with a
// nonzero code instead of hanging, which is what makes retrying here
// safe/bounded.
const CANDIDATE_PORTS = [3999, 4083, 4177, 4271];
const ACCEPT_HEADER = 'application/json, text/event-stream';
// The name of the read-only meta tool every snapshot carries. Used for every
// tools/call below: the fixture spec's own operations would dial the
// deliberately-dead --base-url, whereas this one answers from the snapshot.
const META_TOOL = 'openapi_mcp_status';
// The reserved per-request `_meta` envelope claiming the 2026-07-28 revision.
// Its presence is what routes a request to the modern path — there is no
// initialize handshake and no session id anywhere in this flow.
const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const url = (port: number): string => `http://127.0.0.1:${String(port)}/`;

// The SEP-2243 standard headers the 2026-07-28 revision requires alongside the
// enveloped body: `Mcp-Method` on every request, plus `Mcp-Name` whenever the
// body carries a `params.name`. The handler rejects a header/body disagreement
// with -32020 (asserted below).
const modernHeaders = (
  mcpMethod: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  'content-type': 'application/json',
  accept: ACCEPT_HEADER,
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': mcpMethod,
  authorization: `Bearer ${TOKEN}`,
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
    supportedVersions?: string[];
    tools?: { name: string }[];
    isError?: boolean;
    content?: { text: string }[];
  };
};

const postModern = (
  port: number,
  mcpMethod: string,
  body: unknown,
  headerOverrides: Record<string, string> = {},
): Promise<Response> =>
  fetch(url(port), {
    method: 'POST',
    headers: { ...modernHeaders(mcpMethod), ...headerOverrides },
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
        // Any answered request proves the listener is up; this one is a
        // well-formed modern tools/list.
        await postModern(port, 'tools/list', modernBody(0, 'tools/list'));
        return true;
      } catch {
        // Sequential on purpose: a bounded liveness poll must sleep between attempts by design.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    return false;
  };
  return Promise.race([exited, poll()]);
};

// Every child spawned via spawnServeHttp (or ad hoc further below) gets an
// ISOLATED temp HOME — never the real ~/.kaisers-io/openapi-mcp/cache —
// matching cache-concurrency.test.ts's fixture.home pattern, so this suite
// never races another vitest worker's children over the real user cache's
// namespace refresh lock. Tracked at module scope (spawnServeHttp lives
// outside the describe block below) and drained by the describe's own
// afterEach.
const activeTempHomes: string[] = [];

// Spawns `serve --http`, retrying across CANDIDATE_PORTS if a bind fails
// (EADDRINUSE) — returns the process AND the port it actually landed on.
const spawnServeHttp = async (
  extraArgs: readonly string[] = [],
): Promise<{ proc: ReturnType<typeof spawn>; port: number }> => {
  for (const port of CANDIDATE_PORTS) {
    // Sequential on purpose: a fresh temp home per candidate is intentional — reusing one across candidates risks a stale lock from a killed prior candidate.
    const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-http-'));
    activeTempHomes.push(home);
    const proc = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        // Petstore.json has no `servers` entry (a file spec with no absolute
        // server needs an explicit --base-url) — this fixture never
        // actually calls an upstream tool, so any
        // syntactically valid, non-listening address is fine unless a test
        // overrides it via extraArgs.
        '--base-url',
        'http://127.0.0.1:1',
        '--http',
        '--port',
        String(port),
        '--http-token-env',
        'MCP_TOKEN',
        ...extraArgs,
      ],
      {
        cwd: fixturesDir,
        env: { ...process.env, HOME: home, USERPROFILE: home, MCP_TOKEN: TOKEN },
      },
    );
    // Sequential on purpose: candidate probing is intentional here, one at a time.
    const up = await waitForPortOrExit(proc, port);
    if (up) {
      return { proc, port };
    }
    // A candidate that lost the bind (EADDRINUSE) usually ALREADY exited —
    // waitForPortOrExit consumed its one 'exit' event, so a listener attached
    // now would never fire and hang the retry loop. Await only a still-live
    // child, with the listener registered BEFORE the kill.
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        proc.once('exit', () => {
          resolve();
        });
      });
      proc.kill('SIGKILL');
      // Sequential on purpose: the failed candidate must be fully gone before the next iteration reuses the port pool.
      await exited;
    }
  }
  throw new Error('serve --http never came up on any candidate port');
};

// Sends a raw HTTP/1.1 request over a plain TCP socket — used for the
// duplicate-header cases below, since fetch() cannot send two headers with the
// same name in one request (the very thing that would otherwise make them
// untestable at the E2E tier). `method` defaults to 'POST' to match every call
// site.
const rawRequest = (
  port: number,
  rawHeaderLines: string,
  body = '',
  method = 'POST',
): Promise<number> =>
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
      resolve(statusText === undefined ? 0 : Number(statusText));
    });
    socket.on('error', reject);
  });

// Polls a condition that becomes true on another turn of the event loop (a
// child's stderr pipe delivering a line it wrote after answering a request),
// rather than sleeping a fixed amount and hoping. Returns the condition's
// final value so the caller asserts on CONTENT and fails on the deadline.
const waitUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return true;
    }
    // Sequential on purpose: a bounded poll must sleep between attempts.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return predicate();
};

// A monotonically increasing JSON-RPC id generator, returned as a `const`
// closure rather than a bare `let` counter directly inside the describe
// block below: the mutable state lives inside this factory's own closure,
// not as a reassigned describe-scope variable.
const makeIdGenerator = (): (() => number) => {
  let current = 1;
  return () => current++;
};

describe('serve --http — stateless Streamable HTTP E2E', () => {
  let child: ReturnType<typeof spawn> | undefined;
  const nextId = makeIdGenerator();

  afterEach(async () => {
    if (child !== undefined) {
      const proc = child;
      child = undefined;
      // A process that already exited on its own (e.g. a usage-error test
      // whose child exits before this hook ever runs) has already fired its
      // ONE 'exit' event — attaching a fresh listener now would wait
      // forever, so only await exit for a proc that is still alive.
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((resolve) => {
          proc.once('exit', () => {
            resolve();
          });
        });
        proc.kill('SIGKILL');
        await exited;
      } else {
        proc.kill('SIGKILL');
      }
    }
    const homes = activeTempHomes.splice(0);
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  });

  it('serves the 2026-07-28 flow end to end — server/discover, tools/list with its advertised cache hint, then tools/call — and mints no session id anywhere', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const discover = await postModern(
      port,
      'server/discover',
      modernBody(nextId(), 'server/discover'),
    );
    expect(discover.status).toBe(200);
    // A stateless endpoint never hands one out — on ANY response, not just
    // this one (the two below are checked the same way).
    expect(discover.headers.get('mcp-session-id')).toBeNull();
    const discovered = (await discover.json()) as JsonRpcEnvelope;
    expect(discovered.result?.supportedVersions).toContain('2026-07-28');

    const list = await postModern(port, 'tools/list', modernBody(nextId(), 'tools/list'));
    expect(list.status).toBe(200);
    expect(list.headers.get('mcp-session-id')).toBeNull();
    const listed = (await list.json()) as JsonRpcEnvelope;
    expect(listed.result?.resultType).toBe('complete');
    // Falsification: without the cacheHints wiring, the SDK emits its own
    // conservative default (ttlMs 0), so this exact equality fails.
    expect(listed.result?.ttlMs).toBe(3_600_000);
    expect(listed.result?.cacheScope).toBe('private');
    const toolNames = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain(META_TOOL);
    expect(toolNames.length).toBeGreaterThan(1); // The petstore fixture's own operations, too

    const call = await postModern(
      port,
      'tools/call',
      modernBody(nextId(), 'tools/call', { name: META_TOOL, arguments: {} }),
      { 'mcp-name': META_TOOL },
    );
    expect(call.status).toBe(200);
    expect(call.headers.get('mcp-session-id')).toBeNull();
    const called = (await call.json()) as JsonRpcEnvelope;
    expect(called.result?.isError).toBe(false);
    expect(called.result?.resultType).toBe('complete');

    child.kill('SIGTERM');
  }, 20_000);

  it('requires the bearer on every request (401) and 403s a present, non-allowlisted Origin', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const { authorization: _dropped, ...noAuthHeaders } = modernHeaders('tools/list');
    const listBody = JSON.stringify(modernBody(nextId(), 'tools/list'));
    const noAuth = await fetch(url(port), {
      method: 'POST',
      headers: noAuthHeaders,
      body: listBody,
    });
    expect(noAuth.status).toBe(401);

    const badOrigin = await postModern(port, 'tools/list', modernBody(nextId(), 'tools/list'), {
      origin: 'https://evil.example',
    });
    expect(badOrigin.status).toBe(403);

    child.kill('SIGTERM');
  }, 15_000);

  it('answers GET and DELETE with 405 once authenticated, and 401 without the bearer — the guard runs on every HTTP method, and the 2025 session operations have no stateless equivalent', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const getNoAuth = await fetch(url(port), {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(getNoAuth.status).toBe(401);
    const deleteNoAuth = await fetch(url(port), { method: 'DELETE' });
    expect(deleteNoAuth.status).toBe(401);

    const get = await fetch(url(port), {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    // The 405 is answered by the transport's own method gate, before any body
    // handling — `Allow` names the single method this endpoint serves and is
    // what distinguishes that answer from a delegated one.
    expect(get.headers.get('allow')).toBe('POST');
    const del = await fetch(url(port), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('POST');
  }, 15_000);

  it('serves a claim-less 2025-era POST (no initialize, no _meta claim, bearer still required) — legacy stateless serving stays on', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const noBearer = await fetch(url(port), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT_HEADER },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' }),
    });
    expect(noBearer.status).toBe(401);

    const legacy = await fetch(url(port), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT_HEADER,
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' }),
    });
    expect(legacy.status).toBe(200);
    // The legacy leg frames its answer as a one-event SSE stream; the modern
    // leg answers with a bare JSON body. Reading either shape keeps this test
    // about WHETHER a 2025 client is still served, not about its framing.
    const text = await legacy.text();
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    const payload = JSON.parse(
      dataLine === undefined ? text : dataLine.slice(6),
    ) as JsonRpcEnvelope;
    expect(payload.result?.tools?.map((tool) => tool.name)).toContain(META_TOOL);

    child.kill('SIGTERM');
  }, 15_000);

  it('ignores a stray Mcp-Session-Id header — single or duplicated, the request still succeeds and no session id comes back', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const stray = await postModern(port, 'tools/list', modernBody(nextId(), 'tools/list'), {
      'mcp-session-id': 'left-over-from-a-2025-client',
    });
    expect(stray.status).toBe(200);
    expect(stray.headers.get('mcp-session-id')).toBeNull();
    expect(((await stray.json()) as JsonRpcEnvelope).result?.resultType).toBe('complete');

    // Two session-id header lines on the wire: nothing in this transport reads
    // the header at all, so neither value can steer the request anywhere.
    const duplicatedBody = JSON.stringify(modernBody(nextId(), 'tools/list'));
    const duplicated = await rawRequest(
      port,
      `Host: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
        `Content-Type: application/json\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/list\r\n` +
        `Mcp-Session-Id: id1\r\nMcp-Session-Id: id2\r\n`,
      duplicatedBody,
    );
    expect(duplicated).toBe(200);
  }, 15_000);

  it('surfaces the header/body agreement ladder unswallowed: a missing Mcp-Method header 400s with -32020, and its REASON reaches sanitized stderr while stdout stays empty', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    // Attached after spawn on purpose: a piped child's output is buffered
    // until it is read, so nothing emitted during startup is lost by
    // subscribing here.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const { 'mcp-method': _dropped, ...headersWithoutMethod } = modernHeaders('tools/list');
    const listBody = JSON.stringify(modernBody(nextId(), 'tools/list'));
    const res = await fetch(url(port), {
      method: 'POST',
      headers: headersWithoutMethod,
      body: listBody,
    });
    // The front reads and re-parses the body before handing off; this pins
    // that it neither answers this itself nor loses the handler's own answer.
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonRpcEnvelope).error?.code).toBe(-32_020);

    // The wire answer carries the code and a fixed message; the REASON only
    // exists in the transport's error sink. Polled rather than slept on: the
    // child writes its warning after answering, and a fixed sleep would be
    // both a flake (a slow machine) and a delay (a fast one).
    const sawWarning = await waitUntil(() =>
      // Framed and sanitized through the same warning path the startup
      // diagnostics use — never raw, since the text can echo client input.
      /openapi-mcp: warning: http transport:/u.test(Buffer.concat(stderrChunks).toString('utf8')),
    );
    expect(sawWarning).toBe(true);
    // Nothing on stdout, ever: in HTTP mode the process writes no MCP JSON
    // there, and an error sink that logged to stdout would be the classic way
    // to corrupt a stdio client's stream.
    expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe('');
  }, 15_000);

  it('a duplicate Host header (one allowed value + one evil value) is rejected — proves the guard reads req.headersDistinct, not the collapsing req.headers', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    const duplicateHostHeaders =
      `Host: 127.0.0.1:${String(port)}\r\n` +
      `Host: evil.example:${String(port)}\r\n` +
      `Accept: ${ACCEPT_HEADER}\r\n` +
      `Content-Type: application/json\r\n` +
      `MCP-Protocol-Version: 2026-07-28\r\n` +
      `Mcp-Method: tools/list\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n`;
    const listBody = JSON.stringify(modernBody(nextId(), 'tools/list'));
    const status = await rawRequest(port, duplicateHostHeaders, listBody);
    // Using req.headers.host would silently keep ONLY the first (allowed) value,
    // wrongly passing the Host guard and letting the request through;
    // req.headersDistinct.host sees BOTH values and fails closed (403).
    expect(status).toBe(403);
  }, 15_000);

  it('enforces the 4 MB inbound body cap with a DELIBERATE 400 (not a socket reset/500) — and rejects invalid JSON with a 400 JSON-RPC parse error, not a 500', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
    const tooBig = await fetch(url(port), {
      method: 'POST',
      headers: modernHeaders('tools/list'),
      body: oversized,
    });
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as JsonRpcEnvelope).error?.code).toBe(-32_600);

    const badJson = await fetch(url(port), {
      method: 'POST',
      headers: modernHeaders('tools/list'),
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as JsonRpcEnvelope).error?.code).toBe(-32_700);
  }, 15_000);

  it('GLOBAL rate exhaustion is SHARED across requests (proves the limiter stayed process-wide even though every request is served by a FRESH server instance)', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;
    // DEFAULT_RATE_LIMIT is 120 tools/call invocations / 60s, process-wide.
    // `tools/list` itself is a protocol-level method the low-level Server
    // answers directly and NEVER reaches the rate limiter — only `tools/call`
    // does — so every call here targets `tools/call` on the read-only
    // openapi_mcp_status meta tool. Each of these requests is served by its
    // OWN freshly-constructed server instance: if the limiter were built
    // per-instance instead of being passed in as one shared reference, every
    // request would start with a full budget and this could never exhaust. The
    // rate-exhausted signal is a dispatcher-level `isError` result INSIDE a 200
    // JSON-RPC envelope, never an HTTP status code — asserting on the HTTP
    // status here would pass vacuously.
    let lastBody: JsonRpcEnvelope | undefined;
    for (let index = 0; index < 121; index += 1) {
      // Sequential on purpose: exhausting a shared rate limit requires strictly ordered calls.
      const res = await postModern(
        port,
        'tools/call',
        modernBody(nextId(), 'tools/call', { name: META_TOOL, arguments: {} }),
        { 'mcp-name': META_TOOL },
      );
      // Sequential on purpose: reading each response body in order, matching the request above.
      lastBody = (await res.json()) as JsonRpcEnvelope;
    }
    expect(lastBody?.result?.isError).toBe(true);
    expect(lastBody?.result?.content?.[0]?.text).toBe(
      'rate limit exceeded — too many tool calls; retry later',
    );
  }, 40_000);

  it('graceful SIGINT/SIGTERM exits 0 and completes within the shutdown bound, with a live connection still open from a prior request', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    // A completed request leaves its keep-alive connection open in the global
    // fetch agent's pool, so the listener is holding a real client connection
    // when the signal arrives — the concrete scenario that would keep
    // http.Server#close() pending without the shutdown handling.
    const warmup = await postModern(port, 'tools/list', modernBody(nextId(), 'tools/list'));
    expect(warmup.status).toBe(200);

    const start = Date.now();
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
    // The bound MUST be BELOW SHUTDOWN_FORCE_MS (5000ms), not above it: a
    // graceful shutdown finishes in well under a second (the sub-4s figure is
    // almost all fixed process-teardown overhead, not shutdown work), whereas
    // a shutdown that fell through to the bounded closeAllConnections()
    // fallback would only exit at ~5000ms. A `< 10_000` bound would pass in
    // BOTH cases, leaving the graceful path unfalsified.
    expect(Date.now() - start).toBeLessThan(4000);
  }, 15_000);

  it('a client that aborts a request mid-flight does not wedge the listener — the next request is served normally', async () => {
    const spawned = await spawnServeHttp();
    child = spawned.proc;
    const { port } = spawned;

    // A POST that declares far more body than it ever sends, then vanishes.
    // The 2026-era cancellation signal IS the closed request stream (there is
    // no notifications/cancelled), so this is the shape a cancelled call takes
    // on the wire; that the signal reaches the dispatcher is asserted
    // in-process by the core suite, which can observe it directly.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: ${ACCEPT_HEADER}\r\n` +
            `Content-Type: application/json\r\nAuthorization: Bearer ${TOKEN}\r\n` +
            `MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/list\r\n` +
            `Content-Length: 100000\r\nConnection: close\r\n\r\n{"partial"`,
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 100);
      });
      socket.on('error', reject);
    });

    const stillAlive = await postModern(port, 'tools/list', modernBody(nextId(), 'tools/list'));
    expect(stillAlive.status).toBe(200);
  }, 15_000);

  it('rejects --http without --http-token-env at startup (usage error)', async () => {
    child = spawn(process.execPath, [bin, 'serve', '--spec', 'petstore.json', '--http'], {
      cwd: fixturesDir,
    });
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2);
  });

  it('rejects --http-token-env without --http at startup (usage error)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-http-'));
    activeTempHomes.push(home);
    child = spawn(
      process.execPath,
      [bin, 'serve', '--spec', 'petstore.json', '--http-token-env', 'MCP_TOKEN'],
      {
        cwd: fixturesDir,
        env: { ...process.env, HOME: home, USERPROFILE: home, MCP_TOKEN: TOKEN },
      },
    );
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2);
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    expect(stderrText).toMatch(/--http/u);
  });

  it('rejects a non-default --port without --http at startup (usage error)', async () => {
    child = spawn(process.execPath, [bin, 'serve', '--spec', 'petstore.json', '--port', '4000'], {
      cwd: fixturesDir,
    });
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2);
  });

  it('rejects an EXPLICIT --port matching the default (3044) without --http — proves getOptionValueSource provenance, not a value comparison against the default', async () => {
    child = spawn(process.execPath, [bin, 'serve', '--spec', 'petstore.json', '--port', '3044'], {
      cwd: fixturesDir,
    });
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2);
  });

  it('validates HTTP-specific options (a bad --port) BEFORE any spec/cache/network processing — the error is about the port, never about the (nonexistent) spec file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-http-'));
    activeTempHomes.push(home);
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
      {
        cwd: fixturesDir,
        env: { ...process.env, HOME: home, USERPROFILE: home, MCP_TOKEN: TOKEN },
      },
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
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// A real, local upstream (127.0.0.1, ephemeral port) that the executor
// actually calls through — this test asserts a genuine upstream response,
// not a stub placeholder. GET /pets -> a real JSON array (a structuredContent envelope);
// anything else -> 404. Records the LAST Authorization header it saw so a
// secret --header-env can be proven to have reached the upstream without
// ever asserting on the outcome (which must never contain it).
const startUpstream = (): Promise<{
  server: Server;
  port: number;
  lastAuthHeader: () => string | undefined;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    let lastAuth: string | undefined;
    const server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      if (req.url === '/pets' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        port,
        lastAuthHeader: () => lastAuth,
        close: () =>
          new Promise<void>((_resolve) => {
            server.close(() => _resolve());
          }),
      });
    });
  });

const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));
const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

// The stdio binding frames JSON-RPC messages one-per-line (verified against
// the SDK's own ReadBuffer/serializeMessage in @modelcontextprotocol/server/stdio).
const send = (proc: ReturnType<typeof spawn>, message: JsonRpcMessage): void => {
  proc.stdin?.write(`${JSON.stringify(message)}\n`);
};

const MODERN_PROTOCOL_VERSION = '2026-07-28';

// The per-request envelope every 2026-07-28 request carries. stdio has no
// header layer, so this claim in `params._meta` is the ONLY signal that
// selects the modern era for the connection — and the modern seam revalidates
// it on every request, not just the opening one.
const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const sendModern = (
  proc: ReturnType<typeof spawn>,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): void => {
  send(proc, { jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_ENVELOPE } });
};

// The tools/list order is fixed by the snapshot, not by the wire: the meta tool is
// always first, then the spec's operations in document order (`legacyList` is
// omitted upstream — it carries a cookie parameter). Pinning the exact array
// (not a containment check) is what makes a reordering of the derived list a
// test failure rather than an invisible change for every cached client.
const EXPECTED_TOOL_ORDER = ['openapi_mcp_status', 'listPets', 'createPet'];

type Collected = {
  stdoutLines: string[];
  stderrLines: string[];
  // The RAW, un-split accumulation — used for the airtight end-of-process
  // purity check below, which must see every byte exactly as written,
  // including a possible unterminated trailing fragment `stdoutLines`
  // (incremental, newline-delimited) would silently drop.
  rawStdout: () => string;
};

const collectLines = (proc: ReturnType<typeof spawn>): Collected => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  let rawStdout = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    rawStdout += text;
    stdoutBuf += text;
    const parts = stdoutBuf.split('\n');
    stdoutBuf = parts.pop() ?? '';
    stdoutLines.push(...parts.filter((line) => line !== ''));
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const parts = stderrBuf.split('\n');
    stderrBuf = parts.pop() ?? '';
    stderrLines.push(...parts.filter((line) => line !== ''));
  });
  return { stdoutLines, stderrLines, rawStdout: () => rawStdout };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
};

describe('serve — stdio subprocess E2E', () => {
  let child: ReturnType<typeof spawn> | undefined;
  // Each spawned child gets its OWN temp HOME (never the real
  // ~/.kaisers-io/openapi-mcp/cache) — matching
  // cache-concurrency.test.ts's fixture.home pattern — so this suite never
  // races another vitest worker's children over the real user cache's
  // namespace refresh lock.
  let tempHome: string | undefined;

  afterEach(async () => {
    // `kill()` only SIGNALS — the child may still have in-flight cache I/O
    // under tempHome, so await its actual exit before removing the directory.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
      });
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    if (tempHome !== undefined) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it('discover/list/call(meta)/call(upstream, REAL execution against a local server)/shutdown on 2026-07-28, with stdout carrying ONLY JSON-RPC', async () => {
    const upstream = await startUpstream();
    const SECRET = 'sk-e2e-secret-01234567890123456789';
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--base-url',
        `http://127.0.0.1:${String(upstream.port)}`,
        '--header-env',
        'Authorization=UPSTREAM_TOKEN',
        // The on-disk fixture content can differ from a PRIOR run's accepted
        // cache entry at ~/.kaisers-io/openapi-mcp/cache (trust-on-first-use,
        // keyed by file path) — auto-accept here so this test never depends
        // on cache history left over from an earlier run.
        '--trust-spec-updates',
        // With no --allow, only read-only methods are exposed — createPet
        // (POST) needs an explicit allow to be callable (this test needs it
        // for the 404 case below).
        '--allow',
        '**',
      ],
      {
        cwd: fixturesDir,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          UPSTREAM_TOKEN: `Bearer ${SECRET}`,
        },
      },
    );
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);

    // There is no `initialize` on 2026-07-28: the connection's era is decided
    // by the opening request's envelope claim, and `server/discover` is what
    // reports the revisions this server can actually serve.
    sendModern(child, 1, 'server/discover');
    await waitFor(() => stdoutLines.length > 0);
    const discoverResponse = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(discoverResponse.result?.['supportedVersions']).toContain(MODERN_PROTOCOL_VERSION);
    expect(discoverResponse.result?.['resultType']).toBe('complete');
    expect(typeof discoverResponse.result?.['ttlMs']).toBe('number');
    expect(discoverResponse.result?.['cacheScope']).toBe('private');

    sendModern(child, 2, 'tools/list');
    await waitFor(() => stdoutLines.length >= 2);
    const listResponse = JSON.parse(stdoutLines[1] as string) as JsonRpcMessage;
    const tools = (listResponse.result?.['tools'] as { name: string }[]) ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_ORDER);
    // The adapter's cache hint reaches the wire ON THIS ERA: a server that
    // never configured one would answer ttlMs 0 here, so these three are a
    // real observation of the hint, not of the SDK's defaults.
    expect(listResponse.result?.['ttlMs']).toBe(3_600_000);
    expect(listResponse.result?.['cacheScope']).toBe('private');
    expect(listResponse.result?.['resultType']).toBe('complete');

    sendModern(child, 3, 'tools/call', { name: 'openapi_mcp_status', arguments: {} });
    await waitFor(() => stdoutLines.length >= 3);
    const metaResponse = JSON.parse(stdoutLines[2] as string) as JsonRpcMessage;
    expect(metaResponse.result?.['isError']).not.toBe(true);

    sendModern(child, 4, 'tools/call', { name: 'listPets', arguments: {} });
    await waitFor(() => stdoutLines.length >= 4);
    const upstreamResponse = JSON.parse(stdoutLines[3] as string) as JsonRpcMessage;
    // REAL execution: a genuine structuredContent envelope from the local
    // upstream, not a stub placeholder.
    expect(upstreamResponse.result?.['isError']).not.toBe(true);
    const structured = upstreamResponse.result?.['structuredContent'] as
      | { status: number; contentType: string; data: unknown }
      | undefined;
    expect(structured?.status).toBe(200);
    expect(structured?.data).toEqual([{ id: 1, name: 'Rex' }]);
    // The secret header actually reached the upstream...
    expect(upstream.lastAuthHeader()).toBe(`Bearer ${SECRET}`);
    // ...but never appears anywhere in the JSON-RPC response sent to the client.
    expect(JSON.stringify(upstreamResponse)).not.toContain(SECRET);

    // A 404 from the same upstream (the local server only handles GET
    // /pets — createPet's POST /pets falls through to its 404 branch) maps
    // to a redacted isError, never a structuredContent envelope.
    sendModern(child, 5, 'tools/call', { name: 'createPet', arguments: { name: 'Rex' } });
    await waitFor(() => stdoutLines.length >= 5);
    const notFoundResponse = JSON.parse(stdoutLines[4] as string) as JsonRpcMessage;
    expect(notFoundResponse.result?.['isError']).toBe(true);
    expect(notFoundResponse.result?.['structuredContent']).toBeUndefined();
    expect(JSON.stringify(notFoundResponse)).not.toContain(SECRET);

    child.kill('SIGTERM');
    await upstream.close();
    const exitCode = await new Promise<number | null>((resolve) => {
      child?.once('exit', (code) => resolve(code));
    });
    // A signalled shutdown still runs the session teardown to completion and
    // exits normally — the transport's stdin listener is released rather than
    // left holding the process open until the runtime kills it.
    expect(exitCode).toBe(0);

    // Airtight stdout-purity assertion (the one thing an in-process InMemory
    // transport tier cannot catch), evaluated on the RAW
    // accumulation through process exit — not the incremental
    // `stdoutLines`, which quietly drops an unterminated trailing fragment:
    // (1) the raw stream must end with a trailing newline or be empty — no
    //     residual/unterminated partial bytes left over;
    // (2) splitting on "\n" and dropping the final empty segment gives
    //     EXACTLY 5 non-empty lines — the 5 responses sent above, no more,
    //     no fewer (a stray console.log/warning would add a 6th);
    // (3) EVERY one of those parses as JSON AND carries `jsonrpc: "2.0"`.
    const finalRaw = rawStdout();
    expect(finalRaw === '' || finalRaw.endsWith('\n')).toBe(true);
    const allLines = finalRaw.split('\n').filter((line) => line !== '');
    expect(allLines).toHaveLength(5);
    for (const line of allLines) {
      const parsed = JSON.parse(line) as JsonRpcMessage; // Throws on anything non-JSON — no swallowed try/catch
      expect(parsed.jsonrpc).toBe('2.0');
    }
    expect(stderrLines.every((line) => !line.includes('{'))).toBe(true); // Stderr carries plain-text diagnostics, not JSON-RPC
  }, 10_000);

  // Era negotiation: the SAME server, the SAME factory, opened with a 2025-era
  // `initialize` instead of an envelope claim. A claim-less opening pins the
  // legacy era for the connection, so an existing client that never learned
  // 2026-07-28 keeps working unchanged — and its results keep the 2025 shape
  // (no resultType/ttlMs/cacheScope), which is what proves the era was
  // genuinely selected rather than the modern encoding leaking everywhere.
  it('still serves a legacy 2025-11-25 initialize handshake from the same stdio entry', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--base-url',
        'http://127.0.0.1:1',
        '--trust-spec-updates',
        '--allow',
        '**',
      ],
      { cwd: fixturesDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );
    const { stdoutLines, rawStdout } = collectLines(child);

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0.0' },
      },
    });
    await waitFor(() => stdoutLines.length > 0);
    const initResponse = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(initResponse.result?.['protocolVersion']).toBe('2025-11-25');
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(() => stdoutLines.length >= 2);
    const listResponse = JSON.parse(stdoutLines[1] as string) as JsonRpcMessage;
    const tools = (listResponse.result?.['tools'] as { name: string }[]) ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_ORDER);
    expect(listResponse.result?.['resultType']).toBeUndefined();
    expect(listResponse.result?.['ttlMs']).toBeUndefined();

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'openapi_mcp_status', arguments: {} },
    });
    await waitFor(() => stdoutLines.length >= 3);
    const metaResponse = JSON.parse(stdoutLines[2] as string) as JsonRpcMessage;
    expect(metaResponse.result?.['isError']).not.toBe(true);

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child?.once('exit', () => resolve());
    });
    const finalRaw = rawStdout();
    expect(finalRaw === '' || finalRaw.endsWith('\n')).toBe(true);
    expect(finalRaw.split('\n').filter((line) => line !== '')).toHaveLength(3);
  }, 10_000);

  // FALSIFICATION target: pointing buildTools back at
  // SYSTEM_HEADERS only (dropping the `...apiConfig.reservedHeaderNames`
  // union) makes exactly this test fail — the spec's own "X-Trace" header
  // parameter would reappear as a caller-settable tool input even though
  // --header-env configures a SAME-NAMED operator auth header, which the
  // executor injects and the caller must never be able to override.
  it('unions apiConfig.reservedHeaderNames into buildTools: a spec header param colliding with a configured --header-env name is dropped from the tool input schema', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'header-collision.json',
        '--base-url',
        'http://127.0.0.1:1',
        '--header-env',
        'X-Trace=TRACE_ENV',
      ],
      {
        cwd: fixturesDir,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          TRACE_ENV: 'operator-trace-value',
        },
      },
    );
    const { stdoutLines } = collectLines(child);
    sendModern(child, 1, 'tools/list');
    await waitFor(() => stdoutLines.length > 0);
    const listResponse = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    const tools =
      (listResponse.result?.['tools'] as { name: string; inputSchema: unknown }[]) ?? [];
    const getTrace = tools.find((tool) => tool.name === 'getTrace');
    const properties = (
      getTrace?.inputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    expect(properties).toBeDefined();
    expect(Object.keys(properties ?? {})).not.toContain('X-Trace');
  });

  it('a startup failure (missing spec file) goes to stderr as plain text, even with the global --json flag, and never touches stdout', async () => {
    child = spawn(process.execPath, [bin, '--json', 'serve', '--spec', 'does-not-exist.json'], {
      cwd: fixturesDir,
    });
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).not.toBe(0);
    expect(rawStdout()).toBe(''); // ZERO bytes on stdout, not just zero parsed lines
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('\n')).not.toMatch(/^\{/mu); // Never the --json envelope shape
    expect(stderrLines.join('\n').length).toBeGreaterThan(0);
  });

  it("a PRE-action commander parse failure (missing --spec) with the global --json flag never touches stdout — the failure happens before serve.ts's own action body ever runs", async () => {
    child = spawn(process.execPath, [bin, '--json', 'serve'], { cwd: fixturesDir }); // No --spec at all
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(rawStdout()).toBe(''); // ZERO bytes on stdout, not just zero parsed lines
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('\n')).not.toMatch(/^\{/mu); // Never the --json envelope shape
    expect(stderrLines.join('\n').length).toBeGreaterThan(0);
  });

  it('a PRE-action commander parse failure (an unknown flag) never touches stdout, even with the global --json flag', async () => {
    // MUST pass --json here to actually bind the policy this test claims to
    // exercise: with --json ABSENT, getGlobalOpts(program) reads json:false
    // regardless of whether
    // isServeInvocation's own errorOpts branch ever ran, so the assertions
    // below would stay green even if that branch were deleted entirely —
    // proving nothing about the fix. --json forces the two code paths to
    // actually diverge.
    child = spawn(
      process.execPath,
      [bin, '--json', 'serve', '--spec', 'petstore.json', '--bogus-flag'],
      { cwd: fixturesDir },
    );
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(rawStdout()).toBe(''); // ZERO bytes on stdout, not just zero parsed lines
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('\n')).not.toMatch(/^\{/mu);
    expect(stderrLines.join('\n').length).toBeGreaterThan(0);
  });

  it('a `--` options terminator before `serve` never touches stdout, even with the global --json flag (security fix)', async () => {
    // Commander still selects `serve` and throws a parse error (missing
    // --spec), but `--` is not a GLOBAL_BOOLEAN_FLAGS token — an unguarded
    // isServeInvocation() scan would stop on `--` itself, misclassify this
    // as a non-serve invocation, and fall back to getGlobalOpts (json:true),
    // writing the {"ok":false,...} envelope to stdout.
    child = spawn(process.execPath, [bin, '--json', '--', 'serve'], { cwd: fixturesDir });
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(rawStdout()).toBe(''); // ZERO bytes on stdout
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('\n')).not.toMatch(/^\{/mu); // Never the --json envelope shape
    expect(stderrLines.join('\n').length).toBeGreaterThan(0);
  });

  it('an unknown flag BEFORE `serve` never touches stdout, even with the global --json flag (security fix)', async () => {
    // The scanner for the subcommand token must not stop at the first
    // unrecognized flag it meets: `--bogus` is neither `--` nor a known
    // global flag, but it DOES start with '-', so it must be skipped just
    // like `--json` is, leaving `serve` as the first non-option token. A
    // scanner that only skips a fixed set of known global flags
    // (`--json`/`--verbose`) and `--` would stop at `--bogus`, classify this
    // as a non-serve invocation, and fall back to getGlobalOpts (json:true)
    // — leaking the {"ok":false,...} envelope to stdout.
    child = spawn(process.execPath, [bin, '--json', '--bogus', 'serve'], { cwd: fixturesDir });
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(rawStdout()).toBe(''); // ZERO bytes on stdout
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('\n')).not.toMatch(/^\{/mu); // Never the --json envelope shape
    expect(stderrLines.join('\n').length).toBeGreaterThan(0);
  });

  it('a dead --deny pattern in non-strict mode is reported as a sanitized stderr warning and the server still serves normally (security fix)', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--base-url',
        'http://127.0.0.1:1',
        '--deny',
        'zzz-no-such-op',
      ],
      { cwd: fixturesDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );
    const { stdoutLines, stderrLines, rawStdout } = collectLines(child);

    await waitFor(() => stderrLines.some((line) => line.includes('matches no operation')));
    expect(stderrLines.join('\n')).toContain(
      'openapi-mcp: warning: --deny "zzz-no-such-op" matches no operation',
    );

    sendModern(child, 1, 'tools/list');
    await waitFor(() => stdoutLines.length > 0);
    const listResponse = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(
      (listResponse.result?.['tools'] as { name: string }[] | undefined)?.length,
    ).toBeGreaterThan(0);

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child?.once('exit', () => resolve());
    });
    // Stdout stays pure JSON-RPC even though a warning was emitted to stderr
    const finalRaw = rawStdout();
    expect(finalRaw === '' || finalRaw.endsWith('\n')).toBe(true);
    const allLines = finalRaw.split('\n').filter((line) => line !== '');
    for (const line of allLines) {
      const parsed = JSON.parse(line) as JsonRpcMessage;
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });

  it('exits 0 on a graceful shutdown when the client closes stdin (stdin EOF), not just on SIGINT/SIGTERM (security fix)', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [bin, 'serve', '--spec', 'petstore.json', '--base-url', 'http://127.0.0.1:1'],
      { cwd: fixturesDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );
    const { stdoutLines } = collectLines(child);

    sendModern(child, 1, 'server/discover');
    await waitFor(() => stdoutLines.length > 0);
    const discoverResponse = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(discoverResponse.result?.['supportedVersions']).toContain(MODERN_PROTOCOL_VERSION);

    child.stdin?.end();
    const code = await new Promise<number | null>((resolve) => {
      child?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
  }, 10_000);

  // The executor's cleartext gate (executor.ts's
  // `cleartextBlocked` — a secret `--header-env` header over a cleartext
  // http: origin to a NON-loopback host is refused unless
  // --allow-insecure-http) is checked PER-CALL, inside runUpstreamCall, not
  // at startup — it only ever runs in response to a real tools/call
  // dispatch, so (unlike the startup egress check in serve-egress.test.ts)
  // there is no way to reach it without a live, running server: a genuine
  // subprocess-E2E seam, not an in-process one (the gate ITSELF already has
  // in-process unit coverage at core/test/server-execute-executor.test.ts,
  // and --allow-insecure-http's CLI parsing/threading already has coverage
  // at cli/test/api-options.test.ts — this is the missing END-TO-END wire-up
  // proof through a real `serve` invocation). KNOWN FLAKE: this suite's own
  // "a dead --deny pattern..." case above has been observed to time out
  // under parallel full-suite load (confirmed environmental, not a real
  // regression, by re-running the file in isolation) — the same
  // spawn+stdio-JSON-RPC harness is reused here, so this new case shares
  // that exposure.
  //
  // `--base-url http://0.0.0.0:1/` needs no real upstream at all: 0.0.0.0 is
  // NOT loopback per executor.ts's own narrow `isLoopbackHost` (only
  // 127.0.0.0/8 / ::1 / *.localhost are exempt), so the gate applies; a
  // `--base-url` is always TRUSTED (serve.ts's resolveBaseUrl), so the
  // startup egress check never even looks at it. When the gate is bypassed
  // (--allow-insecure-http), the real dispatch attempt to 0.0.0.0:1 fails
  // fast and deterministically (verified empirically: a local `fetch` to
  // that address rejects in single-digit milliseconds, no network
  // dependency) with a DIFFERENT, specific "upstream server failed" message
  // (response.ts's PINNED_ERROR_TEXT.network) — never the cleartext wording
  // — which is what proves the gate did NOT fire that time, not merely that
  // "some error" occurred either way.
  it('the cleartext gate refuses a --header-env secret over http to a non-loopback origin without --allow-insecure-http, and lets the real dispatch attempt through with the flag (security fix)', async () => {
    const SECRET = 'sk-cleartext-e2e-secret-0123456789';
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    const home = tempHome;
    const spawnServe = (extraArgs: readonly string[]): ReturnType<typeof spawn> =>
      spawn(
        process.execPath,
        [
          bin,
          'serve',
          '--spec',
          'petstore.json',
          '--base-url',
          'http://0.0.0.0:1/',
          '--header-env',
          'Authorization=CLEARTEXT_TOKEN',
          ...extraArgs,
        ],
        {
          cwd: fixturesDir,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CLEARTEXT_TOKEN: `Bearer ${SECRET}`,
          },
        },
      );

    const callListPets = async (
      proc: ReturnType<typeof spawn>,
    ): Promise<{ isError: boolean; text: string | undefined }> => {
      const { stdoutLines } = collectLines(proc);
      sendModern(proc, 1, 'tools/call', { name: 'listPets', arguments: {} });
      await waitFor(() => stdoutLines.length > 0);
      const response = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
      const content = response.result?.['content'] as { type: string; text?: string }[] | undefined;
      return {
        isError: response.result?.['isError'] === true,
        text: content?.[0]?.text,
      };
    };

    const denied = spawnServe([]);
    child = denied;
    const deniedResult = await callListPets(denied);
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult.text).toContain('cleartext');
    expect(deniedResult.text).toContain('--allow-insecure-http');
    expect(deniedResult.text).not.toContain(SECRET);
    denied.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      denied.once('exit', () => resolve());
    });

    const permitted = spawnServe(['--allow-insecure-http']);
    child = permitted;
    const permittedResult = await callListPets(permitted);
    expect(permittedResult.isError).toBe(true);
    // A REAL dispatch attempt was made this time (and failed for the
    // unrelated "nothing is listening on 0.0.0.0:1" reason) — specifically
    // NOT the cleartext-gate wording the denied case asserted above.
    expect(permittedResult.text).toContain('the request to the upstream server failed');
    expect(permittedResult.text).not.toContain('cleartext');
    expect(permittedResult.text).not.toContain(SECRET);
    permitted.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      permitted.once('exit', () => resolve());
    });
    child = undefined;
  }, 10_000);
});

// Concurrency and rate limiting end to end: real `serve` subprocess, real
// pinned transport, a local upstream that answers after 20 ms. MCP hosts
// issue parallel tool calls routinely; with the old fail-fast semaphore
// (16 slots, no queue) a burst of 30 parallel calls returned errors for
// every call past the 16th that arrived while all slots were busy.
describe('serve — parallel tool calls and configurable limits (stdio subprocess)', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let tempHome: string | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
      });
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    if (upstream !== undefined) {
      const server = upstream;
      upstream = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (tempHome !== undefined) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  const startSlowUpstream = async (): Promise<number> => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
      }, 20);
    });
    upstream = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  };

  const spawnServe = async (port: number, extraArgs: readonly string[]) => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--base-url',
        `http://127.0.0.1:${String(port)}`,
        '--trust-spec-updates',
        ...extraArgs,
      ],
      { cwd: fixturesDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );
    return { proc: child, ...collectLines(child) };
  };

  const resultsById = (lines: readonly string[]): Map<number, JsonRpcMessage> =>
    new Map(
      lines
        .map((line) => JSON.parse(line) as JsonRpcMessage)
        .filter((message) => message.id !== undefined)
        .map((message) => [message.id as number, message]),
    );

  it('30 parallel tools/call requests at default settings all succeed (0 errors)', async () => {
    const port = await startSlowUpstream();
    const { proc, stdoutLines } = await spawnServe(port, []);
    sendModern(proc, 1, 'server/discover');
    await waitFor(() => stdoutLines.length > 0);
    for (let id = 100; id < 130; id += 1) {
      sendModern(proc, id, 'tools/call', { name: 'listPets', arguments: {} });
    }
    await waitFor(() => stdoutLines.length >= 31, 8000);
    const results = resultsById(stdoutLines);
    const calls = Array.from({ length: 30 }, (_unused, index) => results.get(100 + index));
    const errors = calls.filter((message) => message?.result?.['isError'] === true);
    expect(errors).toEqual([]);
    expect(calls.every((message) => message?.result?.['structuredContent'] !== undefined)).toBe(
      true,
    );
  }, 15_000);

  it('--rate-limit takes effect and the refusal carries an exact retryAfterMs in _meta', async () => {
    const port = await startSlowUpstream();
    const { proc, stdoutLines } = await spawnServe(port, [
      '--rate-limit',
      '2/1m',
      '--max-concurrency',
      '1',
    ]);
    for (let id = 1; id <= 3; id += 1) {
      sendModern(proc, id, 'tools/call', { name: 'listPets', arguments: {} });
    }
    await waitFor(() => stdoutLines.length >= 3, 8000);
    const results = resultsById(stdoutLines);
    expect(results.get(1)?.result?.['isError']).not.toBe(true);
    expect(results.get(2)?.result?.['isError']).not.toBe(true);
    const refused = results.get(3)?.result;
    expect(refused?.['isError']).toBe(true);
    // The detail rides in `_meta`, not structuredContent: listPets declares
    // an outputSchema, which an error detail could never conform to.
    expect(refused?.['structuredContent']).toBeUndefined();
    const meta = refused?.['_meta'] as Record<string, unknown> | undefined;
    expect(meta?.['openapi-mcp/error']).toBe('rate_limited');
    expect(meta?.['openapi-mcp/retryAfterMs']).toBeGreaterThan(55_000);
    expect(meta?.['openapi-mcp/retryAfterMs']).toBeLessThanOrEqual(60_000);
  }, 15_000);
});

// The upstream HTTP client end to end through a real `serve` subprocess
// against a private, trusted --base-url (the internal-API case).
describe('serve — upstream client behaviour (stdio subprocess)', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let tempHome: string | undefined;
  let upstream: Server | undefined;
  const seenAccept: (string | undefined)[] = [];

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
      });
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    if (upstream !== undefined) {
      const server = upstream;
      upstream = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (tempHome !== undefined) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
    seenAccept.length = 0;
  });

  // GET /pets redirects within the same origin (to /pets/), which answers
  // JSON; GET /slow never answers in time.
  const start = async (): Promise<number> => {
    const server = createServer((req, res) => {
      seenAccept.push(req.headers.accept);
      if (req.url === '/pets') {
        res.writeHead(301, { location: '/pets/' });
        res.end();
        return;
      }
      if (req.url === '/pets/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
      }
      // Anything else hangs past the request timeout.
    });
    upstream = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  };

  const spawnServe = async (baseUrl: string, extraArgs: readonly string[]) => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-'));
    child = spawn(
      process.execPath,
      [
        bin,
        'serve',
        '--spec',
        'petstore.json',
        '--base-url',
        baseUrl,
        '--trust-spec-updates',
        ...extraArgs,
      ],
      { cwd: fixturesDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );
    return { proc: child, ...collectLines(child) };
  };

  it('follows a same-origin redirect on a private --base-url and sends a JSON-first Accept', async () => {
    const port = await start();
    const { proc, stdoutLines } = await spawnServe(`http://127.0.0.1:${String(port)}`, []);
    sendModern(proc, 1, 'tools/call', { name: 'listPets', arguments: {} });
    await waitFor(() => stdoutLines.length > 0, 8000);
    const response = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(response.result?.['isError']).not.toBe(true);
    expect((response.result?.['structuredContent'] as { data: unknown } | undefined)?.data).toEqual(
      [{ id: 1, name: 'Rex' }],
    );
    expect(seenAccept).toEqual(['application/json, */*;q=0.1', 'application/json, */*;q=0.1']);
  }, 15_000);

  it('--request-timeout bounds an upstream call independently of --timeout', async () => {
    const port = await start();
    // The base path makes listPets hit /slow/pets, which never answers.
    const { proc, stdoutLines } = await spawnServe(`http://127.0.0.1:${String(port)}/slow`, [
      '--timeout',
      '30s',
      '--request-timeout',
      '1s',
    ]);
    const started = Date.now();
    sendModern(proc, 1, 'tools/call', { name: 'listPets', arguments: {} });
    await waitFor(() => stdoutLines.length > 0, 8000);
    const elapsed = Date.now() - started;
    const response = JSON.parse(stdoutLines[0] as string) as JsonRpcMessage;
    expect(response.result?.['isError']).toBe(true);
    expect(JSON.stringify(response.result?.['content'])).toContain('timed out');
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);
});

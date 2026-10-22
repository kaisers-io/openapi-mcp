import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// In-process coverage for the ~10-line untrusted-base startup-egress
// passthrough in serve.ts's action body (the
// `if (!resolvedBase.trusted) { await assertAllowedRedirectTarget(...) }`
// block) — this was typecheck-only coverage before this file:
// `resolveBaseUrl`/`assertBaseUrlShape` already had
// in-process coverage (serve-base-url.test.ts) and `assertAllowedRedirectTarget`
// itself already had in-process coverage (core/test/egress.test.ts), but
// nothing exercised serve.ts's OWN wiring of the two together at startup —
// every existing serve.test.ts/serve-http.test.ts case passes `--base-url`
// explicitly (always TRUSTED, skipping the check outright). Their spawned
// processes count toward coverage since issue #86 (vitest.coverage.ts), but
// only for the paths they actually take.
//
// `run()` from main.ts drives serve.ts's real action body in-process against
// a `testContext()` — but serve's own success path blocks on a REAL
// `process.once('SIGINT'|'SIGTERM')` (stdio) or the same after `httpServer
// .listen()` (HTTP) with no ctx-injectable escape hatch, and this file runs
// IN the vitest worker process itself (no subprocess isolation) — so a test
// that let serve fully succeed would hang the worker. Both cases below use
// `--http` with a port a plain net.Server has ALREADY bound: serve.ts only
// attempts the HTTP bind strictly AFTER the startup egress check (see
// serve.ts's action body — the check runs long before `httpServer.listen()`),
// so a bind failure (EADDRINUSE) is a real, deterministic, network-free
// signal that the code reached (and passed) the egress check, without ever
// reaching the indefinite shutdown-signal wait.
const PRIVATE_SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Private', version: '1.0.0' },
  // An ABSOLUTE, spec-derived server URL pointing at a loopback address —
  // resolveBaseUrl picks this up UNTRUSTED (see serve.ts: only an operator
  // `--base-url` is trusted), so it is exactly the untrusted candidate the
  // startup egress check exists to classify. The port (9, "discard") is
  // never actually connected to by either test below.
  servers: [{ url: 'http://127.0.0.1:9/' }],
  paths: {
    '/things': {
      get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
    },
  },
});

// A syntactically valid 43-char unpadded Base64URL token decoding to exactly
// 32 bytes — the shape isValidBearerToken requires (mirrors serve-http.test.ts).
const HTTP_TOKEN = 'A'.repeat(43);

describe('serve — untrusted spec-derived base: startup egress classification (in-process)', () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    if (blocker !== undefined) {
      const server = blocker;
      blocker = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  // Binds an ephemeral port with a PLAIN net.Server FIRST, then hands that
  // same port to `serve --http --port`: serve's own httpServer.listen()
  // reliably rejects EADDRINUSE (streamable-http.ts's listen() promise
  // rejects rather than hangs on a port conflict — see serve-http.test.ts's
  // own comment on that behavior).
  const bindBusyPort = async (): Promise<number> => {
    const server = createServer();
    blocker = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  };

  const runServe = (port: number, extraArgs: readonly string[]) => {
    const errLines: string[] = [];
    const ctx = testContext({
      errLines,
      env: { HTTP_TOKEN },
      readFileText: () => Promise.resolve(PRIVATE_SPEC),
      fileSizeBytes: () => Promise.resolve(PRIVATE_SPEC.length),
    });
    return {
      errLines,
      code: run(ctx, [
        'node',
        'openapi-mcp',
        'serve',
        '--spec',
        'private.json',
        ...extraArgs,
        '--http',
        '--port',
        String(port),
        '--http-token-env',
        'HTTP_TOKEN',
      ]),
    };
  };

  it('(a) a private/loopback spec-derived base with NO --allow-private-network fails startup, naming the egress denial', async () => {
    const port = await bindBusyPort();
    const { code, errLines } = runServe(port, []);
    expect(await code).toBe(EXIT.VALIDATION);
    const text = errLines.join('\n');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('private/loopback');
    expect(text).toContain('--allow-private-network');
    // Never got far enough to attempt the (busy) HTTP bind at all.
    expect(text).not.toContain('EADDRINUSE');
  });

  it('(b) the SAME base with --allow-private-network passes the egress check (fails later, at the HTTP bind, for the UNRELATED busy-port reason)', async () => {
    const port = await bindBusyPort();
    const { code, errLines } = runServe(port, ['--allow-private-network']);
    expect(await code).toBe(EXIT.UNEXPECTED);
    const text = errLines.join('\n');
    expect(text).toMatch(/EADDRINUSE/u);
    // Specifically NOT the egress-denial wording this test's sibling asserts.
    expect(text).not.toContain('--allow-private-network to permit');
    expect(text).not.toContain('private/loopback');
  });
});

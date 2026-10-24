import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  createPinnedAgent,
  MAX_DNS_ANSWERS,
  MAX_REDIRECTS,
  pinnedLookup,
  pinnedRequest,
  validateHopUrlSync,
} from '../src/http/pinned-dispatcher.ts';
import type {
  HopHeaders,
  PinnedDeps,
  PinnedPolicy,
  PinnedRequestOptions,
  Resolve,
} from '../src/http/pinned-dispatcher.ts';

type TestServer = {
  port: number;
  hits: string[];
  close: () => Promise<void>;
};

// A real 127.0.0.1 server (never a fake fetcher — the pinning happens at the
// socket layer, so only a real server proves the Agent actually connects to
// the resolved IP while it keeps sending the original Host header).
const startServer = async (): Promise<TestServer> => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.headers.host ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

const rejectingResolve: Resolve = () =>
  Promise.reject(new Error('resolve must not be called for an IP-literal host'));

// Undici's fetch rejects with a generic "fetch failed" TypeError whose
// `.cause` carries our real lookup error (probe-confirmed) — asserting only
// `.rejects.toThrow()` would also "pass" if the request instead failed for
// an unrelated reason (e.g. a real network error reaching an address our
// guard should never have let it try). Matching the cause message pins each
// rejection to the specific guard under test, keeping it falsifiable.
const rejectsWithCause = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringMatching(pattern) as string,
    }) as object,
  });
};

describe('createPinnedAgent', () => {
  let previousHttpProxy: string | undefined;

  afterEach(() => {
    if (previousHttpProxy !== undefined) {
      process.env['HTTP_PROXY'] = previousHttpProxy;
      previousHttpProxy = undefined;
    }
  });

  it('connects to the resolved IP while the server sees the original Host header', async () => {
    const server = await startServer();
    try {
      const resolve: Resolve = () => Promise.resolve(['127.0.0.1']);
      const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
      const response = await undiciFetch(`http://example.test:${server.port}/`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(server.hits).toEqual([`example.test:${server.port}`]);
      await agent.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a private answer when untrusted and allowPrivateNetwork is false', async () => {
    const server = await startServer();
    try {
      const resolve: Resolve = () => Promise.resolve(['127.0.0.1']);
      const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: false }, resolve);
      await rejectsWithCause(
        undiciFetch(`http://example.test:${server.port}/`, { dispatcher: agent }),
        /private\/loopback/u,
      );
      expect(server.hits).toHaveLength(0);
      await agent.close();
    } finally {
      await server.close();
    }
  });

  it.each<PinnedPolicy>([
    { trusted: true, allowPrivateNetwork: false },
    { trusted: false, allowPrivateNetwork: true },
    { trusted: true, allowPrivateNetwork: true },
  ])('always rejects a cloud-metadata answer regardless of policy (%o)', async (policy) => {
    const resolve: Resolve = () => Promise.resolve(['169.254.169.254']);
    const agent = createPinnedAgent(policy, resolve);
    await rejectsWithCause(
      undiciFetch('http://metadata.example.test/', { dispatcher: agent }),
      /cloud-metadata/u,
    );
    await agent.close();
  });

  it('allows a private answer when the policy is trusted (hop 0 from --base-url)', async () => {
    const server = await startServer();
    try {
      const resolve: Resolve = () => Promise.resolve(['127.0.0.1']);
      const agent = createPinnedAgent({ trusted: true, allowPrivateNetwork: false }, resolve);
      const response = await undiciFetch(`http://trusted.example.test:${server.port}/`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      await response.text();
      await agent.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a non-IP DNS answer', async () => {
    const resolve: Resolve = () => Promise.resolve(['not-an-ip']);
    const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
    await rejectsWithCause(
      undiciFetch('http://bad.example.test/', { dispatcher: agent }),
      /non-IP answer/u,
    );
    await agent.close();
  });

  it('rejects zero DNS answers', async () => {
    const resolve: Resolve = () => Promise.resolve([]);
    const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
    await rejectsWithCause(
      undiciFetch('http://empty.example.test/', { dispatcher: agent }),
      /did not resolve to any address/u,
    );
    await agent.close();
  });

  it('rejects more than MAX_DNS_ANSWERS answers', async () => {
    const resolve: Resolve = () =>
      Promise.resolve(Array.from({ length: MAX_DNS_ANSWERS + 1 }, () => '93.184.216.34'));
    const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
    await rejectsWithCause(
      undiciFetch('http://toomany.example.test/', { dispatcher: agent }),
      /too many DNS answers/u,
    );
    await agent.close();
  });

  it('rejects when any answer among several is private (every answer validated)', async () => {
    const resolve: Resolve = () => Promise.resolve(['93.184.216.34', '10.0.0.1']);
    const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: false }, resolve);
    await rejectsWithCause(
      undiciFetch('http://mixed.example.test/', { dispatcher: agent }),
      /private\/loopback/u,
    );
    await agent.close();
  });

  it('rejects when the resolve function throws synchronously (does not hang)', async () => {
    const resolve: Resolve = () => {
      throw new Error('boom: synchronous resolver failure');
    };
    const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
    await rejectsWithCause(
      undiciFetch('http://sync-throw.example.test/', { dispatcher: agent }),
      /boom: synchronous resolver failure/u,
    );
    await agent.close();
  });

  it('ignores HTTP_PROXY — a plain Agent with a custom connect never consults it', async () => {
    previousHttpProxy = process.env['HTTP_PROXY'];
    process.env['HTTP_PROXY'] = 'http://proxy.invalid:9/';
    const server = await startServer();
    try {
      const resolve: Resolve = () => Promise.resolve(['127.0.0.1']);
      const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: true }, resolve);
      const response = await undiciFetch(`http://example.test:${server.port}/`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      await response.text();
      await agent.close();
    } finally {
      await server.close();
    }
  });

  // Documents the gap this Agent alone cannot close: Node skips `lookup`
  // entirely for an IP-literal hostname, so a hop whose URL is already an IP
  // literal bypasses this Agent's validation regardless of policy. A
  // synchronous per-hop check closes this gap for the redirect transport.
  it('bypasses the custom lookup entirely for an IP-literal host', async () => {
    const server = await startServer();
    try {
      const agent = createPinnedAgent(
        { trusted: false, allowPrivateNetwork: false },
        rejectingResolve,
      );
      const response = await undiciFetch(`http://127.0.0.1:${server.port}/`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      await response.text();
      await agent.close();
    } finally {
      await server.close();
    }
  });
});

describe('pinnedLookup', () => {
  it('falls back to the single-address callback form when options.all is not true', async () => {
    const fakeResolve: Resolve = () => Promise.resolve(['93.184.216.34']);
    const lookupFn = pinnedLookup({ trusted: false, allowPrivateNetwork: true }, fakeResolve);
    const result = await new Promise<{
      err: unknown;
      address: unknown;
      family: number | undefined;
    }>((resolve) => {
      lookupFn('single.example.test', { all: false }, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  // The success path's own `settle(...)` call can throw synchronously (a
  // misbehaving downstream lookup callback, exactly as injected here) — that
  // throw rejects the `.then` chain, which the trailing `.catch` then handles
  // by calling `settle` a SECOND time. Without a callback-once latch this
  // fires the underlying callback twice; with it, exactly once.
  it('invokes the underlying callback exactly once even when the success-path callback throws synchronously', async () => {
    const fakeResolve: Resolve = () => Promise.resolve(['93.184.216.34']);
    const lookupFn = pinnedLookup({ trusted: false, allowPrivateNetwork: true }, fakeResolve);
    let calls = 0;
    const throwingCallback = (): void => {
      calls += 1;
      throw new Error('boom: success-path callback throws');
    };
    lookupFn('throwing.example.test', { all: true }, throwingCallback);
    // The lookup contract is fire-and-forget from the caller's perspective
    // (a real connect.lookup consumer never awaits it); a macrotask tick
    // drains the whole `.then`/`.then`/`.catch` microtask chain, including
    // the re-entrant `.catch` this test specifically provokes.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(1);
  });
});

// The pinnedRequest is the shared manual-redirect transport built on
// createPinnedAgent above. A real 127.0.0.1 server plays every role (200,
// redirect, slow, oversized, gzip) — the DNS-pinning happens at the socket
// layer, so only a real server proves headers/bodies/cancellation actually
// behave as claimed. A fake `resolve` always answers 127.0.0.1 so no real DNS
// runs; distinct origins come from distinct PORTS (the origin tuple includes
// the port), not distinct hostnames.

type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
};

type FlexServer = {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

const startFlexServer = async (
  handler: (req: IncomingMessage, res: ServerResponse, hitIndex: number) => void,
): Promise<FlexServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const hitIndex = requests.length;
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    handler(req, res, hitIndex);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // Node's closeAllConnections (>=18.2) so a test that deliberately
        // never finishes a response (the content-length fast-reject
        // fixtures) cannot hang server.close()'s callback.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

const buildHeaders = (overrides: Partial<HopHeaders> = {}): HopHeaders => ({
  sameOriginHeaders: { authorization: 'Bearer secret-token', 'x-tool': 'demo' },
  crossOriginHeaders: { 'x-tool': 'demo' },
  ...overrides,
});

const buildOpts = (overrides: Partial<PinnedRequestOptions> = {}): PinnedRequestOptions => ({
  method: 'GET',
  headers: buildHeaders(),
  baseTrusted: false,
  allowPrivateNetwork: true,
  timeoutMs: 5000,
  maxResponseBytes: 1_000_000,
  signal: new AbortController().signal,
  ...overrides,
});

const buildDeps = (overrides: Partial<PinnedDeps> = {}): PinnedDeps => ({
  fetch: undiciFetch,
  resolve: () => Promise.resolve(['127.0.0.1']),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  ...overrides,
});

// Undici's own DispatcherBase.close(callback) — probed directly against the
// pinned undici@8.8.0 install — is itself implemented as
// `this.close((err, data) => ...)` when called with zero arguments (the
// no-callback Promise form recurses into the callback form), and
// .close()'s OWN internal chain unconditionally calls `this.destroy()` once
// the graceful drain completes (`this[kClose]().then(() => this.destroy())`)
// — BEFORE the outer no-arg close() promise even resolves. So a single
// external `agent.close()` call is recorded by a prototype spy as calls of
// length 0 (the external invocation) AND length 1 (the internal recursive
// form with a real callback); and it also fires a zero-arg `destroy()` call
// as part of ITS OWN graceful-then-destroy sequence — which is correct,
// intended behaviour, not a violation of the destroy-vs-close amendment.
// Filtering to zero-argument calls isolates each method's own TOP-LEVEL,
// no-callback invocations (`agent.close()` / `agent.destroy()` written
// verbatim in pinnedRequest) from those internal recursive/cascading calls,
// so `zeroArgCalls(closeSpy)` counts exactly the hops that took the graceful
// path.
const zeroArgCalls = (spy: ReturnType<typeof vi.spyOn>): number =>
  spy.mock.calls.filter((call: unknown[]) => call.length === 0).length;

describe('pinnedRequest', () => {
  let destroySpy: ReturnType<typeof vi.spyOn>;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A SPY Agent wraps the real undici Agent methods (still calling
    // through, so sockets really close) so every path's destroy()-vs-close()
    // choice is provable, not just inferred from "a follow-up request
    // succeeds".
    destroySpy = vi.spyOn(Agent.prototype, 'destroy');
    closeSpy = vi.spyOn(Agent.prototype, 'close');
  });

  afterEach(() => {
    destroySpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('returns a 200 response with the decoded body and content-type', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      if (outcome.kind === 'response') {
        expect(outcome.status).toBe(200);
        expect(outcome.contentType).toBe('text/plain');
        expect(textOf(outcome.bodyBytes)).toBe('hello world');
      }
      // Graceful: our code calls close() directly exactly once for the
      // single hop (close()'s own internal cascade legitimately also
      // triggers a destroy() — see zeroArgCalls' doc comment above).
      expect(zeroArgCalls(closeSpy)).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('follows a same-origin redirect, forwarding sameOriginHeaders on the second hop', async () => {
    const server = await startFlexServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/start`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.headers['authorization']).toBe('Bearer secret-token');
      expect(server.requests[1]?.headers['x-tool']).toBe('demo');
      // Every hop gets its own agent, gracefully closed (no exceptions).
      expect(zeroArgCalls(closeSpy)).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('strips to crossOriginHeaders on a cross-origin redirect — no auth/tool headers reach the foreign origin', async () => {
    const foreign = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('foreign ok');
    });
    const original = await startFlexServer((_req, res) => {
      res.writeHead(302, { location: `http://origin.test:${foreign.port}/` });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${original.port}/start`),
        buildOpts({
          headers: buildHeaders({
            sameOriginHeaders: { authorization: 'Bearer secret-token' },
            crossOriginHeaders: {},
          }),
        }),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      expect(foreign.requests).toHaveLength(1);
      expect(foreign.requests[0]?.headers['authorization']).toBeUndefined();
    } finally {
      await original.close();
      await foreign.close();
    }
  });

  it('is MONOTONIC: original -> foreign -> original still strips to crossOriginHeaders on the third hop', async () => {
    // Both servers' handlers need each other's port; the original's is
    // filled in once it starts, just after this mutable box is created.
    const originalPortRef: { port: number } = { port: 0 };
    const foreign = await startFlexServer((_req, res) => {
      res.writeHead(302, { location: `http://back-to.test:${originalPortRef.port}/finalA` });
      res.end();
    });
    const original = await startFlexServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://foreign-origin.test:${foreign.port}/mid` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('back home');
    });
    originalPortRef.port = original.port;
    try {
      const outcome = await pinnedRequest(
        new URL(`http://back-to.test:${original.port}/start`),
        buildOpts({
          headers: buildHeaders({
            sameOriginHeaders: { authorization: 'Bearer secret-token' },
            crossOriginHeaders: {},
          }),
        }),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      expect(original.requests).toHaveLength(2);
      // Hop 0: still on the original origin — creds allowed.
      expect(original.requests[0]?.headers['authorization']).toBe('Bearer secret-token');
      // Hop 2: back on the original origin, but the chain crossed in between
      // — creds NEVER regained.
      expect(original.requests[1]?.headers['authorization']).toBeUndefined();
      expect(foreign.requests).toHaveLength(1);
      expect(foreign.requests[0]?.headers['authorization']).toBeUndefined();
    } finally {
      await original.close();
      await foreign.close();
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'])(
    'rejects a redirect on a %s with redirect-write-method — never a second request',
    async (method) => {
      const target = await startFlexServer((_req, res) => {
        res.writeHead(200);
        res.end('should never be hit');
      });
      const origin = await startFlexServer((_req, res) => {
        res.writeHead(302, { location: `http://target.test:${target.port}/` });
        res.end();
      });
      try {
        const outcome = await pinnedRequest(
          new URL(`http://origin.test:${origin.port}/start`),
          buildOpts({ method, body: new TextEncoder().encode('{}') }),
          buildDeps(),
        );
        expect(outcome).toEqual({ kind: 'error', reason: 'redirect-write-method' });
        expect(target.requests).toHaveLength(0);
        expect(origin.requests).toHaveLength(1);
        // Graceful: the body was cancelled, not an exceptional path.
        expect(zeroArgCalls(closeSpy)).toBe(1);
      } finally {
        await origin.close();
        await target.close();
      }
    },
  );

  it(`rejects a chain of more than ${MAX_REDIRECTS} redirects with redirect-loop`, async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(302, { location: '/' });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'redirect-loop' });
      expect(server.requests).toHaveLength(MAX_REDIRECTS + 1);
    } finally {
      await server.close();
    }
  });

  it('rejects a redirect status with no Location header as redirect-invalid', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome).toEqual({
        kind: 'error',
        reason: 'redirect-invalid',
        detail: 'no Location header',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects a redirect status with an unparseable Location header as redirect-invalid', async () => {
    const server = await startFlexServer((_req, res) => {
      // A raw header value node:http will pass through verbatim; new URL()
      // rejects it (no scheme, and a bare "//" authority with no host).
      res.writeHead(302, { location: 'http://' });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome).toEqual({
        kind: 'error',
        reason: 'redirect-invalid',
        detail: 'invalid Location header',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects an over-cap chunked response with too-large and cancels the body (no full buffering)', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // No content-length: chunked. Writes far more than the cap.
      for (let index = 0; index < 20; index += 1) {
        res.write('0123456789');
      }
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ maxResponseBytes: 25 }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
      // Exceptional: destroy() directly, never the graceful close().
      expect(zeroArgCalls(destroySpy)).toBe(1);
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('fast-rejects an identity response whose declared content-length exceeds the cap, without reading any body', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' });
      // Explicitly flush so the headers actually reach the client without a
      // body write/end (Node buffers writeHead's headers until the first
      // write()/end() otherwise) — proves the fast-reject fired from the
      // header alone rather than waiting on a stream that never arrives.
      res.flushHeaders();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ maxResponseBytes: 50, timeoutMs: 3000 }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
    } finally {
      await server.close();
    }
  }, 10_000);

  // The fast-reject above only exercises the ABSENT-encoding half of
  // isIdentityEncoding's `=== null || === 'identity'` check. This fixture
  // sends an EXPLICIT
  // `content-encoding: identity` header with an over-cap declared
  // content-length, exercising the other half — proving the fast-reject
  // fires from the header alone (before any body read) for an explicit
  // identity encoding too, not only a missing one.
  it('fast-rejects an explicit content-encoding: identity response whose declared content-length exceeds the cap', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'identity',
        'content-length': '999999',
      });
      // Same flushHeaders-without-a-body technique as the absent-encoding
      // fixture above: proves the fast-reject fired from the header alone.
      res.flushHeaders();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ maxResponseBytes: 50, timeoutMs: 3000 }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
    } finally {
      await server.close();
    }
  }, 10_000);

  it('does not let compression bypass the cap: a small gzip content-length whose decompressed body overflows is still too-large via streaming', async () => {
    const maxResponseBytes = 200;
    const payload = 'x'.repeat(2000);
    const compressed = gzipSync(Buffer.from(payload, 'utf8'));
    // The ENCODED length is itself under the cap here, so this specific
    // fixture cannot discriminate an identity-aware pre-check from an
    // unconditional one (both skip/pass a declared length that is genuinely
    // under maxBytes) — it proves a DIFFERENT property: the byte cap is
    // measured on DECOMPRESSED bytes, so compression cannot be used to
    // smuggle an oversized body past it. See the next test for the fixture
    // that actually falsifies "unconditional".
    expect(compressed.byteLength).toBeLessThan(maxResponseBytes);
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      });
      res.end(compressed);
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ maxResponseBytes }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
    } finally {
      await server.close();
    }
  });

  it('does not fast-reject a gzip response whose ACCURATE compressed content-length exceeds the cap when the decompressed body is small', async () => {
    // This is the fixture that actually falsifies an unconditional
    // pre-check: gzip's own framing overhead (~20 bytes) makes even a tiny
    // payload's TRUE, wire-accurate
    // compressed length bigger than this small cap, while the real
    // decompressed content comfortably fits. An unconditional pre-check
    // (comparing the declared length to maxBytes regardless of encoding)
    // would wrongly reject this before ever reading the body; the
    // content-encoding-aware pre-check must skip straight to streaming,
    // which sees only 2 decompressed bytes and succeeds.
    const maxResponseBytes = 10;
    const payload = 'hi';
    const compressed = gzipSync(Buffer.from(payload, 'utf8'));
    expect(compressed.byteLength).toBeGreaterThan(maxResponseBytes);
    expect(payload.length).toBeLessThan(maxResponseBytes);
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      });
      res.end(compressed);
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ maxResponseBytes }),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      if (outcome.kind === 'response') {
        expect(textOf(outcome.bodyBytes)).toBe(payload);
      }
    } finally {
      await server.close();
    }
  });

  it('returns an empty body for a null response.body (a HEAD request)', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '11' });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ method: 'HEAD' }),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
      if (outcome.kind === 'response') {
        expect(outcome.bodyBytes).toHaveLength(0);
      }
    } finally {
      await server.close();
    }
  });

  it('swallows a rejecting response.body.cancel() during the content-length fast-reject', async () => {
    const fakeResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain', 'content-length': '999999' }),
      body: { cancel: () => Promise.reject(new Error('cancel boom')) },
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts({ maxResponseBytes: 50 }),
      buildDeps({ fetch: (() => Promise.resolve(fakeResponse)) as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
  });

  it('swallows a rejecting response.body.cancel() when cancelling a redirect response body', async () => {
    const redirectResponse = {
      status: 302,
      headers: new Headers({ location: 'http://origin.test/next' }),
      body: { cancel: () => Promise.reject(new Error('cancel boom')) },
    };
    const finalResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
    };
    let calls = 0;
    const fetchImpl = (): Promise<unknown> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? redirectResponse : finalResponse);
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({ fetch: fetchImpl as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome.kind).toBe('response');
    expect(calls).toBe(2);
  });

  it('swallows a rejecting reader.cancel() when aborting mid-stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const fakeResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('x'));
          streamController.close();
        },
        cancel() {
          return Promise.reject(new Error('reader cancel boom'));
        },
      }),
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts({ signal: controller.signal }),
      buildDeps({ fetch: (() => Promise.resolve(fakeResponse)) as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome).toEqual({ kind: 'error', reason: 'cancelled' });
  });

  it('swallows a rejecting reader.cancel() when the streamed body exceeds the cap', async () => {
    const fakeResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('0123456789'.repeat(10)));
          streamController.close();
        },
        cancel() {
          return Promise.reject(new Error('reader cancel boom'));
        },
      }),
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts({ maxResponseBytes: 5 }),
      buildDeps({ fetch: (() => Promise.resolve(fakeResponse)) as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome).toEqual({ kind: 'error', reason: 'too-large' });
  });

  it('swallows a rejecting agent.destroy() call in the fetch-level exceptional path', async () => {
    destroySpy.mockRejectedValueOnce(new Error('destroy boom'));
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({ fetch: () => Promise.reject(new Error('ECONNREFUSED-ish')) }),
    );
    expect(outcome).toEqual({
      kind: 'error',
      reason: 'network',
      detail: 'ECONNREFUSED-ish',
      beforeResponse: true,
    });
  });

  it('swallows a rejecting agent.close() call in the finally teardown of a normal response', async () => {
    closeSpy.mockRejectedValueOnce(new Error('close boom'));
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts(),
        buildDeps(),
      );
      expect(outcome.kind).toBe('response');
    } finally {
      await server.close();
    }
  });

  it('maps an abort that fires mid-stream (already-aborted signal, body-read throws) to cancelled via the read-path catch', async () => {
    // A fake deps.fetch that RESOLVES successfully with a real body stream,
    // isolating readCapped's own abort handling (onAbort firing because
    // signal.aborted is already true when reading starts, the reader's
    // resulting throw, and the non-TooLargeError reader.cancel() branch)
    // from the separate fetch()-level abort path already covered above.
    const controller = new AbortController();
    controller.abort();
    const fakeResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('irrelevant'));
          streamController.close();
        },
      }),
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts({ signal: controller.signal }),
      buildDeps({ fetch: (() => Promise.resolve(fakeResponse)) as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome).toEqual({ kind: 'error', reason: 'cancelled' });
  });

  it('maps an unexpected body-stream error (not abort, not too-large) to reason network', async () => {
    const boom = new Error('stream boom');
    const fakeResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.error(boom);
        },
      }),
    };
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({ fetch: (() => Promise.resolve(fakeResponse)) as unknown as PinnedDeps['fetch'] }),
    );
    expect(outcome).toEqual({ kind: 'error', reason: 'network', detail: 'stream boom' });
  });

  it('maps a slow server past a small timeoutMs to reason timeout', async () => {
    const server = await startFlexServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('too late');
      }, 2000);
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ timeoutMs: 50 }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'timeout' });
      expect(zeroArgCalls(destroySpy)).toBe(1);
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);

  it('maps a pre-aborted client signal to cancelled — discriminated by signal identity, not err.name', async () => {
    const controller = new AbortController();
    // The client's OWN reason happens to be TimeoutError-shaped: a
    // classification that inspects err.name (or the reason's name) instead
    // of which signal actually fired would misclassify this as 'timeout'.
    controller.abort(new DOMException('synthetic client cancel', 'TimeoutError'));
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ signal: controller.signal, timeoutMs: 5000 }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'cancelled' });
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  // Checking `opts.signal.aborted` at ERROR-HANDLING time misclassifies this
  // exact race — the timeout signal fires and wins
  // FIRST, but the client signal ALSO goes on to abort (e.g. an MCP client
  // cancelling right after a server-side timeout already committed) before
  // the fetch rejection is handled. Both `AbortController.abort()` calls
  // below fire their signals' 'abort' events SYNCHRONOUSLY and in the given
  // order, so trackAbortWinner's listeners record the winner deterministically
  // — no real timers or races needed to prove it.
  it('discriminates the abort winner by identity: timeout fires first, then the client also aborts -> reason timeout, not cancelled', async () => {
    const clientController = new AbortController();
    const timeoutController = new AbortController();
    let fetchReject: ((err: unknown) => void) | undefined;
    const fetchImpl = (): Promise<never> =>
      new Promise((_resolve, reject) => {
        fetchReject = reject;
      });
    const outcomePromise = pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts({ signal: clientController.signal, timeoutMs: 5000 }),
      buildDeps({
        fetch: fetchImpl as unknown as PinnedDeps['fetch'],
        timeoutSignal: () => timeoutController.signal,
      }),
    );
    // The timeout signal wins the race first...
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'));
    // ...then the client also cancels, moments later — after the timeout
    // already committed but before the fetch rejection below is handled.
    clientController.abort(new DOMException('client cancel', 'AbortError'));
    // Only now does the fetch actually reject, mirroring how an abort
    // propagates asynchronously to a real in-flight undici fetch.
    fetchReject?.(new DOMException('This operation was aborted', 'AbortError'));
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('classifies a private-address DNS denial as egress, not network (real socket-level denial)', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200);
      res.end('should never be hit');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ allowPrivateNetwork: false, baseTrusted: false }),
        buildDeps({ resolve: () => Promise.resolve(['127.0.0.1']) }),
      );
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') {
        expect(outcome.reason).toBe('egress');
      }
      expect(server.requests).toHaveLength(0);
      expect(zeroArgCalls(destroySpy)).toBe(1);
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('classifies a plain fetch() rejection with no cause as network', async () => {
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({ fetch: () => Promise.reject(new Error('ECONNREFUSED-ish')) }),
    );
    expect(outcome).toEqual({
      kind: 'error',
      reason: 'network',
      detail: 'ECONNREFUSED-ish',
      beforeResponse: true,
    });
  });

  it('classifies a fetch() rejection whose cause is a non-object (not an EgressError chain) as network', async () => {
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({
        fetch: () => Promise.reject(new Error('fetch failed', { cause: 'not an object' })),
      }),
    );
    expect(outcome).toEqual({
      kind: 'error',
      reason: 'network',
      detail: 'fetch failed',
      beforeResponse: true,
    });
  });

  it('classifies a fetch() rejection as egress when the branded EgressError is nested inside an aggregated cause.errors array', async () => {
    // EgressError itself is not exported (callers only ever see the
    // PinnedErrorReason it maps to) — so the only legitimate way to obtain a
    // REAL instance for this fixture is to capture one from the actual
    // DNS-pinning denial path (createPinnedAgent), exactly as a real undici
    // fetch failure's `.cause` would carry it.
    const denialServer = await startFlexServer((_req, res) => {
      res.writeHead(200);
      res.end('should never be hit');
    });
    let capturedCause: unknown;
    try {
      const agent = createPinnedAgent({ trusted: false, allowPrivateNetwork: false }, () =>
        Promise.resolve(['127.0.0.1']),
      );
      try {
        await undiciFetch(`http://origin.test:${denialServer.port}/`, { dispatcher: agent });
      } catch (error) {
        capturedCause = error instanceof Error ? error.cause : undefined;
      }
      await agent.close();
    } finally {
      await denialServer.close();
    }
    expect(capturedCause).toBeDefined();

    const aggregated = new Error('fetch failed', { cause: { errors: [capturedCause] } });
    const outcome = await pinnedRequest(
      new URL('http://origin.test/'),
      buildOpts(),
      buildDeps({ fetch: () => Promise.reject(aggregated) }),
    );
    expect(outcome).toEqual({
      kind: 'error',
      reason: 'egress',
      detail: 'fetch failed',
      beforeResponse: true,
    });
  });

  it('allows a private-address hop 0 when baseTrusted is set (the --base-url case)', async () => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('trusted ok');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/`),
        buildOpts({ allowPrivateNetwork: false, baseTrusted: true }),
        buildDeps({ resolve: () => Promise.resolve(['127.0.0.1']) }),
      );
      expect(outcome.kind).toBe('response');
    } finally {
      await server.close();
    }
  });

  it.each([
    ['http://127.0.0.1:__TARGET__/', 'private/loopback'],
    ['http://169.254.169.254/', 'cloud-metadata'],
    ['http://[fd00:ec2::254]/', 'cloud-metadata'],
  ])(
    'rejects a redirect to the IP-literal %s with reason egress before any fetch of it — the target gets nothing',
    async (template, expectedDetailSubstring) => {
      const target = await startFlexServer((_req, res) => {
        res.writeHead(200);
        res.end('should never be hit');
      });
      const location = template.replace('__TARGET__', String(target.port));
      const origin = await startFlexServer((_req, res) => {
        res.writeHead(302, { location });
        res.end();
      });
      const fetchSpy = vi.fn<typeof undiciFetch>(undiciFetch);
      try {
        const outcome = await pinnedRequest(
          new URL(`http://origin.test:${origin.port}/start`),
          // Setting baseTrusted allows hop 0's OWN connection (necessarily a
          // private 127.0.0.1 test server) without also flipping
          // allowPrivateNetwork — a redirect hop is NEVER trusted
          // regardless, so this isolates "is hop 1 rejected" from "can hop 0
          // even connect".
          buildOpts({ allowPrivateNetwork: false, baseTrusted: true, timeoutMs: 2000 }),
          buildDeps({ fetch: fetchSpy as unknown as PinnedDeps['fetch'] }),
        );
        expect(outcome.kind).toBe('error');
        if (outcome.kind === 'error') {
          expect(outcome.reason).toBe('egress');
          expect(outcome.detail).toContain(expectedDetailSubstring);
        }
        expect(target.requests).toHaveLength(0);
        // Only the first hop (to `origin`) ever reached fetch(); the
        // IP-literal redirect target never did — a pure synchronous reject.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        await origin.close();
        await target.close();
      }
    },
  );

  it('follows a redirect to a literal PUBLIC IP even with allowPrivateNetwork false (validateHopUrlSync unit check)', () => {
    // A full end-to-end connection to an arbitrary public IP is not
    // reproducible offline; validateHopUrlSync is exported precisely so this
    // half of the guard (the classify-and-allow branch) is directly,
    // deterministically testable.
    const result = validateHopUrlSync(new URL('http://93.184.216.34/'), {
      allowPrivateNetwork: false,
      trusted: false,
    });
    expect(result).toBeUndefined();
  });
});

describe('validateHopUrlSync', () => {
  const untrusted: PinnedPolicy = { allowPrivateNetwork: false, trusted: false };

  it('rejects a non-http(s) scheme', () => {
    expect(validateHopUrlSync(new URL('ftp://example.test/'), untrusted)).toMatch(/scheme/u);
  });

  it('rejects userinfo credentials in the URL', () => {
    expect(validateHopUrlSync(new URL('http://user:pass@example.test/'), untrusted)).toMatch(
      /userinfo/u,
    );
  });

  it('rejects a metadata hostname', () => {
    expect(validateHopUrlSync(new URL('http://metadata.google.internal/'), untrusted)).toMatch(
      /cloud-metadata/u,
    );
  });

  it('rejects a private IP literal when untrusted and allowPrivateNetwork is false', () => {
    expect(validateHopUrlSync(new URL('http://127.0.0.1/'), untrusted)).toMatch(
      /private\/loopback/u,
    );
  });

  it('allows a private IP literal when trusted', () => {
    expect(
      validateHopUrlSync(new URL('http://127.0.0.1/'), {
        allowPrivateNetwork: false,
        trusted: true,
      }),
    ).toBeUndefined();
  });

  it('allows a private IP literal when allowPrivateNetwork is true', () => {
    expect(
      validateHopUrlSync(new URL('http://127.0.0.1/'), {
        allowPrivateNetwork: true,
        trusted: false,
      }),
    ).toBeUndefined();
  });

  it('always rejects a metadata IP literal, even trusted with allowPrivateNetwork', () => {
    expect(
      validateHopUrlSync(new URL('http://169.254.169.254/'), {
        allowPrivateNetwork: true,
        trusted: true,
      }),
    ).toMatch(/cloud-metadata/u);
  });

  it('always rejects an IPv6 metadata literal (bracketed), even trusted with allowPrivateNetwork', () => {
    expect(
      validateHopUrlSync(new URL('http://[fd00:ec2::254]/'), {
        allowPrivateNetwork: true,
        trusted: true,
      }),
    ).toMatch(/cloud-metadata/u);
  });

  it('always rejects the Tencent Cloud metadata hostname, even trusted with allowPrivateNetwork', () => {
    // Regression: METADATA_HOSTNAMES must be the single set shared with
    // egress.ts (not a separately maintained local copy) so this hostname
    // can never be denied in egress.ts but missed here.
    expect(
      validateHopUrlSync(new URL('http://metadata.tencentyun.com/'), {
        allowPrivateNetwork: true,
        trusted: true,
      }),
    ).toBe('"metadata.tencentyun.com" is a cloud-metadata endpoint');
  });

  it('allows a public IP literal', () => {
    expect(validateHopUrlSync(new URL('http://93.184.216.34/'), untrusted)).toBeUndefined();
  });

  it('allows an ordinary hostname (no IP-literal classification applies)', () => {
    expect(validateHopUrlSync(new URL('http://example.test/'), untrusted)).toBeUndefined();
  });
});

// Redirect trust and 303 handling. Every fixture uses a TRUSTED loopback
// base with allowPrivateNetwork OFF, i.e. `--base-url http://127.0.0.1:...`
// for an internal API: only the trusted origin itself may resolve to a
// private address.
describe('pinnedRequest — same-origin redirects and 303 See Other', () => {
  // A permissive pinned Agent (every hostname -> 127.0.0.1, any address
  // allowed) for the recording pools below.
  const loopbackAgent = (): Agent =>
    createPinnedAgent({ trusted: true, allowPrivateNetwork: true }, () =>
      Promise.resolve(['127.0.0.1']),
    );

  const trustedPrivate = (overrides: Partial<PinnedRequestOptions> = {}): PinnedRequestOptions =>
    buildOpts({ baseTrusted: true, allowPrivateNetwork: false, ...overrides });

  it('follows a same-origin redirect on a private trusted base (e.g. /v1 -> /v1/)', async () => {
    const server = await startFlexServer((req, res) => {
      if (req.url === '/v1') {
        res.writeHead(301, { location: '/v1/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/v1`),
        trustedPrivate(),
        buildDeps(),
      );
      expect(outcome).toMatchObject({ kind: 'response', status: 200 });
      expect(server.requests.map((req) => req.url)).toEqual(['/v1', '/v1/']);
    } finally {
      await server.close();
    }
  });

  it('still denies a redirect to ANOTHER private origin (a different port is a different origin)', async () => {
    const other = await startFlexServer((_req, res) => {
      res.writeHead(200);
      res.end('should never be hit');
    });
    const origin = await startFlexServer((_req, res) => {
      res.writeHead(302, { location: `http://origin.test:${other.port}/` });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${origin.port}/start`),
        trustedPrivate(),
        buildDeps(),
      );
      expect(outcome).toMatchObject({ kind: 'error', reason: 'egress' });
      expect(other.requests).toHaveLength(0);
    } finally {
      await origin.close();
      await other.close();
    }
  });

  it('trusts only the base origin until the chain leaves it: original -> foreign -> original', async () => {
    // A recording pool hands out permissive Agents so every hop can connect
    // to loopback; what is asserted is the trust policy each hop
    // ASKED for — the pool key that decides which DNS policy applies.
    const policies: { origin: string; trusted: boolean }[] = [];
    const agents = {
      acquire: (origin: string, policy: PinnedPolicy) => {
        policies.push({ origin, trusted: policy.trusted });
        return loopbackAgent();
      },
      size: () => 0,
      close: () => Promise.resolve(),
    };
    let originPort = 0;
    const foreign = await startFlexServer((_req, res) => {
      res.writeHead(302, { location: `http://origin.test:${originPort}/back` });
      res.end();
    });
    const origin = await startFlexServer((req, res) => {
      if (req.url === '/v1') {
        res.writeHead(301, { location: '/v1/' });
      } else if (req.url === '/v1/') {
        res.writeHead(302, { location: `http://foreign.test:${foreign.port}/` });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    originPort = origin.port;
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${origin.port}/v1`),
        trustedPrivate(),
        buildDeps({ agents }),
      );
      expect(outcome).toMatchObject({ kind: 'response', status: 200 });
      expect(policies.map((entry) => entry.trusted)).toEqual([true, true, false, false]);
      // Credentials were stripped from the return hop as well.
      expect(origin.requests.map((req) => req.url)).toEqual(['/v1', '/v1/', '/back']);
      expect(origin.requests[2]?.headers['authorization']).toBeUndefined();
    } finally {
      await origin.close();
      await foreign.close();
    }
  });

  it('never trusts a redirect hop when the base itself is untrusted', async () => {
    const server = await startFlexServer((req, res) => {
      if (req.url === '/v1') {
        res.writeHead(301, { location: '/v1/' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const policies: boolean[] = [];
    const agents = {
      acquire: (_origin: string, policy: PinnedPolicy) => {
        policies.push(policy.trusted);
        return loopbackAgent();
      },
      size: () => 0,
      close: () => Promise.resolve(),
    };
    try {
      await pinnedRequest(
        new URL(`http://origin.test:${server.port}/v1`),
        buildOpts({ baseTrusted: false, allowPrivateNetwork: false }),
        buildDeps({ agents }),
      );
      expect(policies).toEqual([false, false]);
    } finally {
      await server.close();
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'])(
    'follows a 303 after %s as a GET with no body and no content-type',
    async (method) => {
      const server = await startFlexServer((req, res) => {
        if (req.url === '/things') {
          res.writeHead(303, { location: '/things/1' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":1}');
      });
      try {
        const outcome = await pinnedRequest(
          new URL(`http://origin.test:${server.port}/things`),
          trustedPrivate({
            method,
            body: new TextEncoder().encode('{"name":"x"}'),
            headers: buildHeaders({
              sameOriginHeaders: {
                authorization: 'Bearer secret-token',
                'content-type': 'application/json',
              },
            }),
          }),
          buildDeps(),
        );
        expect(outcome).toMatchObject({ kind: 'response', status: 200 });
        expect(server.requests.map((req) => [req.method, req.url])).toEqual([
          [method, '/things'],
          ['GET', '/things/1'],
        ]);
        const [, followUp] = server.requests;
        expect(followUp?.headers['content-type']).toBeUndefined();
        expect(followUp?.headers['content-length']).toBeUndefined();
        // Same origin: credentials still go along on the GET.
        expect(followUp?.headers['authorization']).toBe('Bearer secret-token');
      } finally {
        await server.close();
      }
    },
  );

  it.each([301, 302, 307, 308])('still refuses a %i after a POST', async (status) => {
    const server = await startFlexServer((_req, res) => {
      res.writeHead(status, { location: '/elsewhere' });
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/things`),
        trustedPrivate({ method: 'POST', body: new TextEncoder().encode('{}') }),
        buildDeps(),
      );
      expect(outcome).toEqual({ kind: 'error', reason: 'redirect-write-method' });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('keeps a POST after a 303 -> 307 chain a GET (the method change sticks)', async () => {
    const server = await startFlexServer((req, res) => {
      if (req.url === '/a') {
        res.writeHead(303, { location: '/b' });
      } else if (req.url === '/b') {
        res.writeHead(307, { location: '/c' });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    try {
      const outcome = await pinnedRequest(
        new URL(`http://origin.test:${server.port}/a`),
        trustedPrivate({ method: 'POST', body: new TextEncoder().encode('{}') }),
        buildDeps(),
      );
      expect(outcome).toMatchObject({ kind: 'response', status: 200 });
      expect(server.requests.map((req) => req.method)).toEqual(['POST', 'GET', 'GET']);
    } finally {
      await server.close();
    }
  });
});

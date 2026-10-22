import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { createPinnedAgentPool } from '../src/http/agent-pool.ts';
import type { PinnedAgentPoolOptions } from '../src/http/agent-pool.ts';
import { pinnedRequest } from '../src/http/pinned-dispatcher.ts';
import type { PinnedDeps, PinnedRequestOptions } from '../src/http/pinned-dispatcher.ts';

// The pool's whole point is connection reuse, and its whole risk is the SSRF
// pin: both are socket-level facts, so every test here runs against a real
// 127.0.0.1 server and counts the TCP connections it actually accepted.
// Distinct origins come from distinct ports; a fake resolver answers the
// hostnames, so no real DNS runs.

type CountingServer = {
  port: number;
  connections: () => number;
  openSockets: () => number;
  requests: IncomingMessage[];
  close: () => Promise<void>;
};

const startServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  },
): Promise<CountingServer> => {
  const requests: IncomingMessage[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.on('connection', (socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    openSockets: () => sockets.size,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const loopback: PinnedDeps['resolve'] = () => Promise.resolve(['127.0.0.1']);

const poolOptions = (overrides: Partial<PinnedAgentPoolOptions> = {}): PinnedAgentPoolOptions => ({
  resolve: loopback,
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  lookupTimeoutMs: 5000,
  connections: 16,
  ...overrides,
});

const buildOpts = (overrides: Partial<PinnedRequestOptions> = {}): PinnedRequestOptions => ({
  method: 'GET',
  headers: {
    sameOriginHeaders: { authorization: 'Bearer example-token-not-a-secret' },
    crossOriginHeaders: {},
  },
  // Hop 0 to the (loopback) base is trusted, exactly like --base-url;
  // allowPrivateNetwork stays false so every redirect hop is held to the
  // strict untrusted policy.
  baseTrusted: true,
  allowPrivateNetwork: false,
  timeoutMs: 5000,
  maxResponseBytes: 1_000_000,
  signal: new AbortController().signal,
  ...overrides,
});

const withPool = (
  pool: ReturnType<typeof createPinnedAgentPool>,
  resolve: PinnedDeps['resolve'] = loopback,
): PinnedDeps => ({
  fetch: undiciFetch,
  resolve,
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  agents: pool,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not reached in time');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

describe('createPinnedAgentPool — connection reuse', () => {
  it('opens a small constant number of connections for 100 sequential calls (per-hop agents open 100)', async () => {
    const server = await startServer();
    const pool = createPinnedAgentPool(poolOptions());
    try {
      const url = new URL(`http://api.test:${server.port}/x`);
      for (let index = 0; index < 100; index += 1) {
        const outcome = await pinnedRequest(url, buildOpts(), withPool(pool));
        expect(outcome.kind).toBe('response');
      }
      // At most 2, not 1: undici hands the fully-read body to the caller a
      // tick before it marks the socket idle again, so a back-to-back next
      // request may find the first socket still "busy" and open one more
      // (plain undici fetch with any Agent behaves identically). It stays
      // at 2 no matter how many calls follow.
      expect(server.connections()).toBeLessThanOrEqual(2);
      // The pre-pool behaviour, for contrast: no `agents` means a fresh
      // Agent per hop, so every call pays a new connection.
      const before = server.connections();
      for (let index = 0; index < 10; index += 1) {
        const { agents: _unused, ...perHop } = withPool(pool);
        await pinnedRequest(url, buildOpts(), perHop);
      }
      expect(server.connections() - before).toBe(10);
    } finally {
      await pool.close();
      await server.close();
    }
  });

  it('caps parallel connections per origin at `connections` (30 parallel calls, cap 4)', async () => {
    const server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 20);
    });
    const pool = createPinnedAgentPool(poolOptions({ connections: 4 }));
    try {
      const url = new URL(`http://api.test:${server.port}/x`);
      const outcomes = await Promise.all(
        Array.from({ length: 30 }, () => pinnedRequest(url, buildOpts(), withPool(pool))),
      );
      expect(outcomes.every((outcome) => outcome.kind === 'response')).toBe(true);
      expect(server.connections()).toBeLessThanOrEqual(4);
      expect(server.requests).toHaveLength(30);
    } finally {
      await pool.close();
      await server.close();
    }
  });
});

describe('createPinnedAgentPool — the DNS pin still holds for every new socket', () => {
  it('re-validates DNS when a pooled agent opens a new socket: a rebinding answer is rejected', async () => {
    // `connection: close` forces every call onto a NEW socket of the SAME
    // pooled agent. The first lookup answers loopback (allowed: hop 0 is
    // trusted); the next answers the cloud-metadata address, which no
    // policy ever allows. A pool that cached the first validated answer, or
    // skipped lookup for a pooled agent, would connect anyway.
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{}');
    });
    const answers = [['127.0.0.1'], ['169.254.169.254']];
    const resolve = vi.fn<PinnedDeps['resolve']>(() =>
      Promise.resolve(answers.shift() ?? ['169.254.169.254']),
    );
    const pool = createPinnedAgentPool(poolOptions({ resolve }));
    try {
      const url = new URL(`http://rebind.test:${server.port}/x`);
      const first = await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      expect(first.kind).toBe('response');
      await waitFor(() => server.openSockets() === 0);
      const second = await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      expect(second).toMatchObject({ kind: 'error', reason: 'egress' });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(server.requests).toHaveLength(1);
      expect(pool.size()).toBe(1);
    } finally {
      await pool.close();
      await server.close();
    }
  });

  it('never hands a lookup the CALLER signal: aborting one call does not poison later lookups', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{}');
    });
    const seen: AbortSignal[] = [];
    const resolve: PinnedDeps['resolve'] = (_hostname, signal) => {
      seen.push(signal);
      return Promise.resolve(['127.0.0.1']);
    };
    const pool = createPinnedAgentPool(poolOptions({ resolve }));
    try {
      const url = new URL(`http://api.test:${server.port}/x`);
      const controller = new AbortController();
      const first = await pinnedRequest(
        url,
        buildOpts({ signal: controller.signal }),
        withPool(pool, resolve),
      );
      expect(first.kind).toBe('response');
      controller.abort();
      await waitFor(() => server.openSockets() === 0);
      const second = await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      expect(second.kind).toBe('response');
      expect(seen).toHaveLength(2);
      expect(seen).not.toContain(controller.signal);
      expect(seen.every((signal) => !signal.aborted)).toBe(true);
    } finally {
      await pool.close();
      await server.close();
    }
  });
});

describe('createPinnedAgentPool — redirects keep the untrusted policy', () => {
  it('a same-origin redirect stays on the trusted agent; a different origin gets a separate untrusted one', async () => {
    const other = await startServer();
    const server = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      if (req.url === '/final') {
        res.writeHead(302, { location: `http://api.test:${other.port}/x` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('{}');
    });
    const pool = createPinnedAgentPool(poolOptions());
    try {
      const outcome = await pinnedRequest(
        new URL(`http://api.test:${server.port}/start`),
        buildOpts(),
        withPool(pool),
      );
      // Hop 1 stays on the trusted base origin and reuses its agent; hop 2
      // leaves it, so its (separate, untrusted) agent rejects the loopback
      // answer.
      expect(outcome).toMatchObject({ kind: 'error', reason: 'egress' });
      expect(server.requests.map((req) => req.url)).toEqual(['/start', '/final']);
      expect(other.requests).toHaveLength(0);
      expect(pool.size()).toBe(2);
    } finally {
      await pool.close();
      await server.close();
      await other.close();
    }
  });

  it('a cross-origin redirect drops credentials and is held to the untrusted policy', async () => {
    const foreign = await startServer();
    const origin = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://foreign.test:${foreign.port}/x` });
      res.end();
    });
    const pool = createPinnedAgentPool(poolOptions());
    try {
      const outcome = await pinnedRequest(
        new URL(`http://api.test:${origin.port}/start`),
        buildOpts({ allowPrivateNetwork: true }),
        withPool(pool),
      );
      expect(outcome.kind).toBe('response');
      expect(foreign.requests).toHaveLength(1);
      expect(foreign.requests[0]?.headers.authorization).toBeUndefined();
      expect(origin.requests[0]?.headers.authorization).toBe('Bearer example-token-not-a-secret');
    } finally {
      await pool.close();
      await origin.close();
      await foreign.close();
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'a %s still never follows a redirect',
    async (method) => {
      const server = await startServer((_req, res) => {
        res.writeHead(307, { location: '/elsewhere' });
        res.end();
      });
      const pool = createPinnedAgentPool(poolOptions());
      try {
        const outcome = await pinnedRequest(
          new URL(`http://api.test:${server.port}/x`),
          buildOpts({ method, body: new TextEncoder().encode('{}') }),
          withPool(pool),
        );
        expect(outcome).toEqual({ kind: 'error', reason: 'redirect-write-method' });
        expect(server.requests).toHaveLength(1);
      } finally {
        await pool.close();
        await server.close();
      }
    },
  );
});

describe('createPinnedAgentPool — cancellation isolation', () => {
  it('cancelling one call leaves concurrent and later calls on the same agent unaffected', async () => {
    const server = await startServer((req, res) => {
      const delay = req.url === '/slow' ? 300 : 30;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, delay);
    });
    const pool = createPinnedAgentPool(poolOptions());
    try {
      const controller = new AbortController();
      const cancelled = pinnedRequest(
        new URL(`http://api.test:${server.port}/slow`),
        buildOpts({ signal: controller.signal }),
        withPool(pool),
      );
      const concurrent = pinnedRequest(
        new URL(`http://api.test:${server.port}/fast`),
        buildOpts(),
        withPool(pool),
      );
      setTimeout(() => controller.abort(), 50);
      await expect(cancelled).resolves.toEqual({ kind: 'error', reason: 'cancelled' });
      await expect(concurrent).resolves.toMatchObject({ kind: 'response', status: 200 });
      const later = await pinnedRequest(
        new URL(`http://api.test:${server.port}/fast`),
        buildOpts(),
        withPool(pool),
      );
      expect(later).toMatchObject({ kind: 'response', status: 200 });
      expect(pool.size()).toBe(1);
    } finally {
      await pool.close();
      await server.close();
    }
  });
});

describe('createPinnedAgentPool — bounds', () => {
  it('keys agents by origin AND policy: no agent is shared across policy contexts', () => {
    const pool = createPinnedAgentPool(poolOptions());
    const trusted = pool.acquire('http://a.test', { trusted: true, allowPrivateNetwork: false });
    const untrusted = pool.acquire('http://a.test', { trusted: false, allowPrivateNetwork: false });
    const privateOk = pool.acquire('http://a.test', { trusted: false, allowPrivateNetwork: true });
    const otherOrigin = pool.acquire('http://b.test', {
      trusted: true,
      allowPrivateNetwork: false,
    });
    expect(new Set([trusted, untrusted, privateOk, otherOrigin]).size).toBe(4);
    expect(pool.acquire('http://a.test', { trusted: true, allowPrivateNetwork: false })).toBe(
      trusted,
    );
    return pool.close();
  });

  it('evicts the least-recently-used agent once maxAgents is reached', async () => {
    const pool = createPinnedAgentPool(poolOptions({ maxAgents: 2 }));
    const policy = { trusted: false, allowPrivateNetwork: false };
    const first = pool.acquire('http://a.test', policy);
    const second = pool.acquire('http://b.test', policy);
    // Touch `a` so `b` becomes the least recently used.
    expect(pool.acquire('http://a.test', policy)).toBe(first);
    pool.acquire('http://c.test', policy);
    expect(pool.size()).toBe(2);
    await waitFor(() => second.closed);
    expect(pool.acquire('http://a.test', policy)).toBe(first);
    expect(pool.acquire('http://b.test', policy)).not.toBe(second);
    await pool.close();
  });

  it('retires an agent past its TTL, so the next call opens a new, re-validated connection', async () => {
    const server = await startServer();
    let clock = 0;
    const resolve = vi.fn<PinnedDeps['resolve']>(loopback);
    const pool = createPinnedAgentPool(poolOptions({ resolve, ttlMs: 1000, now: () => clock }));
    try {
      const url = new URL(`http://api.test:${server.port}/x`);
      for (let index = 0; index < 5; index += 1) {
        await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      }
      const connectionsBefore = server.connections();
      const lookupsBefore = resolve.mock.calls.length;
      expect(lookupsBefore).toBe(connectionsBefore);
      clock = 999;
      await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      expect(server.connections()).toBe(connectionsBefore);
      clock = 1000;
      await pinnedRequest(url, buildOpts(), withPool(pool, resolve));
      // A fresh agent: a new socket, and a new DNS lookup + validation.
      expect(server.connections()).toBe(connectionsBefore + 1);
      expect(resolve).toHaveBeenCalledTimes(lookupsBefore + 1);
      // The retired agent's idle sockets are closed, not leaked.
      await waitFor(() => server.openSockets() === 1);
    } finally {
      await pool.close();
      await server.close();
    }
  });

  it('closes an idle pooled socket after keepAliveTimeoutMs', async () => {
    const server = await startServer();
    const pool = createPinnedAgentPool(poolOptions({ keepAliveTimeoutMs: 100 }));
    try {
      const url = new URL(`http://api.test:${server.port}/x`);
      await pinnedRequest(url, buildOpts(), withPool(pool));
      expect(server.openSockets()).toBe(1);
      await waitFor(() => server.openSockets() === 0);
      await pinnedRequest(url, buildOpts(), withPool(pool));
      expect(server.connections()).toBe(2);
    } finally {
      await pool.close();
      await server.close();
    }
  });

  it('close() destroys every pooled socket and refuses further use', async () => {
    const server = await startServer();
    const pool = createPinnedAgentPool(poolOptions());
    const url = new URL(`http://api.test:${server.port}/x`);
    try {
      await pinnedRequest(url, buildOpts(), withPool(pool));
      const agent = pool.acquire(url.origin, { trusted: true, allowPrivateNetwork: false });
      expect(server.openSockets()).toBe(1);
      await pool.close();
      expect(agent.destroyed).toBe(true);
      await waitFor(() => server.openSockets() === 0);
      expect(pool.size()).toBe(0);
      expect(() => pool.acquire(url.origin, { trusted: true, allowPrivateNetwork: false })).toThrow(
        /closed/u,
      );
    } finally {
      await server.close();
    }
  });

  it('close() also destroys an agent that was retired but is still draining', async () => {
    const server = await startServer((_req, res) => {
      // Never answers: the retired agent's graceful close() would wait
      // forever on this in-flight request.
      res.writeHead(200);
    });
    const pool = createPinnedAgentPool(poolOptions({ maxAgents: 1 }));
    const policy = { trusted: true, allowPrivateNetwork: false };
    const hanging = pinnedRequest(
      new URL(`http://api.test:${server.port}/x`),
      buildOpts(),
      withPool(pool),
    );
    await waitFor(() => server.requests.length === 1);
    const retired = pool.acquire(`http://api.test:${server.port}`, policy);
    pool.acquire('http://other.test', policy);
    expect(retired.closed).toBe(true);
    expect(retired.destroyed).toBe(false);
    await pool.close();
    expect(retired.destroyed).toBe(true);
    // Aborted by the destroy, well before the call's own 5 s timeout.
    await expect(hanging).resolves.toEqual({
      kind: 'error',
      reason: 'network',
      detail: expect.any(String) as string,
    });
    await server.close();
  });
});

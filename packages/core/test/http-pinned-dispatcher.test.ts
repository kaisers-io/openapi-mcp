import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import {
  createPinnedAgent,
  MAX_DNS_ANSWERS,
  pinnedLookup,
  type PinnedPolicy,
  type Resolve,
} from '../src/http/pinned-dispatcher.ts';

interface TestServer {
  port: number;
  hits: string[];
  close: () => Promise<void>;
}

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

  // Documents the gap this Agent alone cannot close (Task 3 brief amendment,
  // context for Task 4): Node skips `lookup` entirely for an IP-literal
  // hostname, so a hop whose URL is already an IP literal bypasses this
  // Agent's validation regardless of policy. Task 4's synchronous per-hop
  // check closes this gap for the redirect transport.
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
});

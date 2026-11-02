import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';

// End-to-end proof for OAuth2 client-credentials
// (kaisers-io/openapi-mcp-archive#55): a REAL `serve` subprocess against ONE
// local server that is both the authorization server (POST /oauth/token) and
// the API (GET /pets, GET /whoami). The spec's tokenUrl is relative, so it
// resolves against the API base — same origin.

const CLIENT_ID = 'demo-client';
const CLIENT_SECRET = 'example-token-not-a-secret';
const EXPECTED_BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

type TokenRequest = { authorization: string | undefined; body: string };

type MockOptions = {
  // The expires_in of every issued token (seconds).
  expiresIn?: number;
  // Reject every API call with 401, whatever the token.
  alwaysUnauthorized?: boolean;
};

type Mock = {
  port: number;
  tokenRequests: TokenRequest[];
  apiAuthHeaders: (string | undefined)[];
  issued: string[];
  // Revokes every token issued so far (the next API call 401s once).
  revokeAll: () => void;
  // Holds the answers of the token endpoint or of the API from now on,
  // until released (issue #22)
  hold: (which: Gate) => void;
  // Opens the gate, or with `count` lets only that many held answers out
  release: (which: Gate, count?: number) => void;
  waiting: (which: Gate) => number;
  close: () => Promise<void>;
};

type Gate = 'token' | 'api';

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const startMock = (options: MockOptions = {}): Promise<Mock> => {
  const tokenRequests: TokenRequest[] = [];
  const apiAuthHeaders: (string | undefined)[] = [];
  const issued: string[] = [];
  const valid = new Set<string>();
  const gates: Record<Gate, { held: boolean; waiting: (() => void)[] }> = {
    token: { held: false, waiting: [] },
    api: { held: false, waiting: [] },
  };
  // The answer is decided on arrival and sent once the gate opens
  const through = async (which: Gate): Promise<void> => {
    if (gates[which].held) {
      await new Promise<void>((resolve) => {
        gates[which].waiting.push(resolve);
      });
    }
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && req.url === '/oauth/token') {
        const body = await readBody(req);
        tokenRequests.push({ authorization: req.headers.authorization, body });
        if (req.headers.authorization !== EXPECTED_BASIC) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client', error_description: CLIENT_SECRET }));
          return;
        }
        const token = `issued-access-token-${String(issued.length + 1)}-abcdefghijklmnop`;
        issued.push(token);
        valid.add(token);
        await through('token');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            access_token: token,
            token_type: 'bearer',
            expires_in: options.expiresIn ?? 3600,
          }),
        );
        return;
      }
      apiAuthHeaders.push(req.headers.authorization);
      const presented = req.headers.authorization?.replace(/^Bearer /u, '') ?? '';
      const authorized = options.alwaysUnauthorized !== true && valid.has(presented);
      await through('api');
      if (!authorized) {
        // A hostile/careless upstream that echoes the credential it rejected.
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end(`invalid token ${presented}`);
        return;
      }
      if (req.url === '/whoami') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`you are ${presented}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        tokenRequests,
        apiAuthHeaders,
        issued,
        revokeAll: () => valid.clear(),
        hold: (which) => {
          gates[which].held = true;
        },
        release: (which, count) => {
          if (count === undefined) {
            gates[which].held = false;
          }
          const released =
            count === undefined
              ? gates[which].waiting.splice(0)
              : gates[which].waiting.splice(0, count);
          for (const resume of released) {
            resume();
          }
        },
        waiting: (which) => gates[which].waiting.length,
        close: () =>
          new Promise<void>((_resolve) => {
            server.closeAllConnections();
            server.close(() => _resolve());
          }),
      });
    });
  });
};

const specFor = (tokenUrl: string): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'OAuth API', version: '1.0.0' },
    components: {
      securitySchemes: {
        cc: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl, scopes: { read: 'read access' } } },
        },
      },
    },
    security: [{ cc: ['read'] }],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'array' } } },
            },
          },
        },
      },
      '/whoami': {
        get: {
          operationId: 'whoami',
          responses: { '200': { description: 'ok', content: { 'text/plain': {} } } },
        },
      },
    },
  });

type RpcResponse = { id?: number; result?: Record<string, unknown> };

type Session = {
  call: (name: string, args?: Record<string, unknown>) => Promise<RpcResponse>;
  // Sends a call and returns its id at once, with its answer to come
  send: (
    name: string,
    args?: Record<string, unknown>,
  ) => { id: number; answer: Promise<RpcResponse> };
  cancel: (id: number) => void;
  // Answered once the server has read everything sent before it
  ping: () => Promise<RpcResponse>;
  stderr: () => string;
  stdout: () => string;
  exited: Promise<number | null>;
};

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

describe('serve — OAuth2 client credentials (subprocess E2E)', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let home: string | undefined;
  let mock: Mock | undefined;

  afterEach(async () => {
    if (child !== undefined) {
      // Graceful, so the child writes its coverage (cli-subprocess.ts)
      await stopChild(child);
    }
    child = undefined;
    await mock?.close();
    mock = undefined;
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  const start = async (
    tokenUrl: string,
    extraArgs: readonly string[],
    mockOptions: MockOptions = {},
  ): Promise<Session> => {
    mock = await startMock(mockOptions);
    home = await mkdtemp(join(tmpdir(), 'openapi-mcp-oauth-'));
    const specPath = join(home, 'spec.json');
    await writeFile(specPath, specFor(tokenUrl));
    child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--spec',
        specPath,
        '--base-url',
        `http://127.0.0.1:${String(mock.port)}`,
        '--trust-spec-updates',
        '--upstream-oauth-client-id-env',
        'CLIENT_ID',
        '--upstream-oauth-client-secret-env',
        'CLIENT_SECRET',
        '--upstream-oauth-scope',
        'read',
        ...extraArgs,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLIENT_ID,
          CLIENT_SECRET,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const pending = new Map<number, (response: RpcResponse) => void>();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n');
      for (const line of lines.slice(0, -1)) {
        if (line !== '') {
          const parsed = JSON.parse(line) as RpcResponse;
          if (parsed.id !== undefined) {
            pending.get(parsed.id)?.(parsed);
          }
        }
      }
      stdout = lines.at(-1) ?? '';
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => {
      child?.once('exit', (code) => resolve(code));
    });
    let nextId = 1;
    const send = (name: string, args: Record<string, unknown> = {}) => {
      const id = nextId;
      nextId += 1;
      const answer = new Promise<RpcResponse>((resolve) => {
        pending.set(id, resolve);
      });
      child?.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args, _meta: ENVELOPE },
        })}\n`,
      );
      return { id, answer };
    };
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<RpcResponse> =>
      await send(name, args).answer;
    const cancel = (id: number): void => {
      child?.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'test' },
        })}\n`,
      );
    };
    const ping = async (): Promise<RpcResponse> => {
      const id = nextId;
      nextId += 1;
      const answer = new Promise<RpcResponse>((resolve) => {
        pending.set(id, resolve);
      });
      child?.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: ENVELOPE } })}\n`,
      );
      return await answer;
    };
    return { call, send, cancel, ping, stderr: () => stderr, stdout: () => stdout, exited };
  };

  const allowPrivate = ['--allow-private-network'];

  it('one token for N concurrent calls (Basic auth, grant_type, scope), reused as Bearer, redacted everywhere, and replaced exactly once on a 401', async () => {
    const session = await start('/oauth/token', allowPrivate);
    // Six concurrent FIRST calls share a single token request.
    const firstWave = await Promise.all(
      Array.from({ length: 6 }, async () => await session.call('listPets')),
    );
    expect(firstWave.every((result) => result.result?.['isError'] !== true)).toBe(true);
    const structured = firstWave[0]?.result?.['structuredContent'] as { data: unknown } | undefined;
    expect(structured?.data).toEqual([{ id: 1, name: 'Rex' }]);
    expect(mock?.tokenRequests).toHaveLength(1);
    expect(mock?.tokenRequests[0]?.authorization).toBe(EXPECTED_BASIC);
    expect(Object.fromEntries(new URLSearchParams(mock?.tokenRequests[0]?.body))).toEqual({
      grant_type: 'client_credentials',
      scope: 'read',
    });
    const firstToken = mock?.issued[0] ?? 'missing';
    expect(new Set(mock?.apiAuthHeaders)).toEqual(new Set([`Bearer ${firstToken}`]));

    // The cached token is reused; an upstream that echoes it gets redacted.
    const echoed = await session.call('whoami');
    expect(JSON.stringify(echoed)).toContain('you are [redacted]');
    expect(mock?.tokenRequests).toHaveLength(1);

    // Revoked upstream: the call 401s (echoing the token), the token is
    // refetched ONCE and the request replayed ONCE.
    mock?.revokeAll();
    const replayed = await session.call('whoami');
    expect(replayed.result?.['isError']).not.toBe(true);
    expect(mock?.tokenRequests).toHaveLength(2);
    const secondToken = mock?.issued[1] ?? 'missing';
    expect(mock?.apiAuthHeaders.slice(-2)).toEqual([
      `Bearer ${firstToken}`,
      `Bearer ${secondToken}`,
    ]);

    const wire = JSON.stringify([...firstWave, echoed, replayed]);
    for (const secret of [firstToken, secondToken, CLIENT_SECRET]) {
      expect(wire).not.toContain(secret);
      expect(session.stderr()).not.toContain(secret);
    }
  }, 20_000);

  // Issue #22: the OAuth lifecycle under concurrency and deadlines
  const until = async (predicate: () => boolean, what: string): Promise<void> => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 10_000) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  };

  it('16 parallel 401s for one token cause one refetch and one replay each', async () => {
    const session = await start('/oauth/token', allowPrivate);
    const warm = await session.call('listPets');
    expect(warm.result?.['isError']).not.toBe(true);
    const [first] = mock?.issued ?? [];
    mock?.revokeAll();
    // Every first attempt carries the revoked token before any 401 is sent
    mock?.hold('api');
    const answers = Array.from({ length: 16 }, () => session.send('listPets').answer);
    await until(() => mock?.waiting('api') === 16, '16 API requests');
    // One 401 first: its replay carries the new token once that is cached.
    // The other 15 then answer 401 for the old token, which must not drop
    // the new one again
    mock?.release('api', 1);
    await until(() => mock?.waiting('api') === 16, 'the replay with the new token');
    mock?.release('api');
    const results = await Promise.all(answers);
    expect(results.filter((result) => result.result?.['isError'] === true)).toStrictEqual([]);
    expect(mock?.tokenRequests).toHaveLength(2);
    const second = mock?.issued[1];
    expect(mock?.apiAuthHeaders).toStrictEqual([
      `Bearer ${first ?? ''}`,
      ...Array.from({ length: 16 }, () => `Bearer ${first ?? ''}`),
      ...Array.from({ length: 16 }, () => `Bearer ${second ?? ''}`),
    ]);
  }, 20_000);

  it('a call waiting for a token times out at its deadline and sends nothing, then the server recovers', async () => {
    const session = await start('/oauth/token', [...allowPrivate, '--request-timeout', '1s']);
    // Started: the stopwatch below measures the deadline, not the startup
    await session.ping();
    mock?.hold('token');
    const started = Date.now();
    const results = await Promise.all([session.call('listPets'), session.call('listPets')]);
    const elapsed = Date.now() - started;
    // The token request shares the call's --request-timeout, so either the
    // call's deadline or the token request's own timeout ends the wait
    // first. The test below separates the two clocks.
    for (const result of results) {
      expect(result.result?.['isError']).toBe(true);
      expect(JSON.stringify(result)).toMatch(
        /timed out waiting for an OAuth2 access token; no API request was sent|the token request timed out/u,
      );
    }
    expect(elapsed).toBeLessThan(5000);
    // The two waited for one shared token request
    expect(mock?.tokenRequests).toHaveLength(1);
    expect(mock?.apiAuthHeaders).toStrictEqual([]);
    mock?.release('token');
    // The failed request is remembered for a few seconds, then retried
    let recovered = false;
    for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
      const result = await session.call('listPets');
      recovered = result.result?.['isError'] !== true;
      if (!recovered) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }
    expect(recovered).toBe(true);
    expect(mock?.tokenRequests).toHaveLength(2);
    expect(mock?.apiAuthHeaders).toHaveLength(1);
  }, 30_000);

  it('a call waiting for a fresh token after a 401 stops at its own deadline, before the token request times out', async () => {
    const session = await start('/oauth/token', [...allowPrivate, '--request-timeout', '8s']);
    const warm = await session.call('listPets');
    expect(warm.result?.['isError']).not.toBe(true);
    mock?.revokeAll();
    mock?.hold('api');
    const pending = session.send('listPets');
    await until(() => mock?.waiting('api') === 1, 'the API request');
    // Five of the call's eight seconds pass at the API. The 401 then needs a
    // new token, whose request has eight seconds of its own, so only the
    // call's deadline can end the wait, after three seconds at most. A slow
    // runner that took longer to get here leaves the call less, never more.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    });
    mock?.hold('token');
    const released = Date.now();
    mock?.release('api');
    const result = await pending.answer;
    const waited = Date.now() - released;
    expect(result.result?.['isError']).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'timed out waiting for a fresh OAuth2 access token; the request was not sent again',
    );
    expect(waited).toBeLessThan(6000);
    expect(mock?.tokenRequests).toHaveLength(2);
    expect(mock?.apiAuthHeaders).toHaveLength(2);
  }, 30_000);

  // That the cancelled waiter itself stops waiting at once is tested in
  // packages/core/test/server-execute-oauth.test.ts: here a later check
  // would also keep it from sending
  it('cancelling one waiter does not cancel the token request the others share', async () => {
    const session = await start('/oauth/token', allowPrivate);
    mock?.hold('token');
    const cancelled = session.send('listPets');
    const kept = session.send('listPets');
    await until(() => mock?.waiting('token') === 1, 'the token request');
    session.cancel(cancelled.id);
    // A cancelled request gets no answer (MCP): the next request's answer
    // shows the server read the cancellation, as it reads stdin in order
    await session.ping();
    mock?.release('token');
    const result = await kept.answer;
    expect(result.result?.['isError']).not.toBe(true);
    expect(mock?.tokenRequests).toHaveLength(1);
    // Only the call still waiting reached the API
    expect(mock?.apiAuthHeaders).toStrictEqual([`Bearer ${mock?.issued[0] ?? ''}`]);
  }, 20_000);

  it('a second 401 is returned, not retried again', async () => {
    const session = await start('/oauth/token', allowPrivate, { alwaysUnauthorized: true });
    const result = await session.call('whoami');
    expect(result.result?.['isError']).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('upstream request failed with status 401');
    expect(text).toContain('CLIENT_ID / CLIENT_SECRET');
    expect(mock?.tokenRequests).toHaveLength(2);
    expect(mock?.apiAuthHeaders).toHaveLength(2);
    for (const secret of mock?.issued ?? []) {
      expect(text).not.toContain(secret);
    }
  }, 15_000);

  it('refreshes a short-lived token before it expires', async () => {
    // An expires_in of 1 s -> refresh margin min(60 s, 10 %) = 100 ms.
    const session = await start('/oauth/token', allowPrivate, { expiresIn: 1 });
    await session.call('listPets');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    const later = await session.call('listPets');
    expect(later.result?.['isError']).not.toBe(true);
    expect(mock?.tokenRequests).toHaveLength(2);
    // Refreshed proactively: the API never saw a rejected token.
    expect(mock?.apiAuthHeaders).toEqual([
      `Bearer ${mock?.issued[0] ?? ''}`,
      `Bearer ${mock?.issued[1] ?? ''}`,
    ]);
  }, 15_000);

  it('a token endpoint error names the env vars and never echoes the endpoint body', async () => {
    const session = await start('/oauth/token', [
      ...allowPrivate,
      '--upstream-oauth-client-auth',
      'client_secret_post',
    ]);
    // A client_secret_post request sends no Basic header, which this mock rejects with
    // invalid_client and an error_description that echoes the secret.
    const result = await session.call('listPets');
    expect(result.result?.['isError']).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('the token endpoint answered HTTP 401 (invalid_client)');
    expect(text).toContain('CLIENT_ID / CLIENT_SECRET');
    expect(text).not.toContain(CLIENT_SECRET);
    expect(new URLSearchParams(mock?.tokenRequests[0]?.body).get('client_secret')).toBe(
      CLIENT_SECRET,
    );
    expect(mock?.apiAuthHeaders).toHaveLength(0);
  }, 15_000);
});

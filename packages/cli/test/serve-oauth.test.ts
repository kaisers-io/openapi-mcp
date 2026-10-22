import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// End-to-end proof for OAuth2 client-credentials (#55): a REAL `serve`
// subprocess against ONE local server that is both the authorization server
// (POST /oauth/token) and the API (GET /pets, GET /whoami). The spec's
// tokenUrl is relative, so it resolves against the API base — same origin.

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
  close: () => Promise<void>;
};

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
      if (options.alwaysUnauthorized === true || !valid.has(presented)) {
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

const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));

type RpcResponse = { id?: number; result?: Record<string, unknown> };

type Session = {
  call: (name: string, args?: Record<string, unknown>) => Promise<RpcResponse>;
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
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
      });
      child.kill('SIGKILL');
      await exited;
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
        bin,
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
    const call = (name: string, args: Record<string, unknown> = {}): Promise<RpcResponse> => {
      const id = nextId;
      nextId += 1;
      const response = new Promise<RpcResponse>((resolve) => {
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
      return response;
    };
    return { call, stderr: () => stderr, stdout: () => stdout, exited };
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

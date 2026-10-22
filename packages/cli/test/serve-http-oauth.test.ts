import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, FIXTURES_DIR, stopChild } from './cli-subprocess.ts';

// `serve --http --http-auth oauth` end to end: a real child process, a
// loopback stand-in authorization server (RFC 8414 metadata + JWKS) and a
// loopback upstream API that records the Authorization header it receives.
// Ports 4381/4382 are disjoint from every other HTTP suite.

const fixturesDir = FIXTURES_DIR;
const UPSTREAM_SECRET = 'example-token-not-a-secret';
const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

// oxlint-disable-next-line node/no-sync -- one fixture signing key for the whole suite
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'e2e-key' };

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const signToken = (payload: Record<string, unknown>): string => {
  const input = `${b64({ alg: 'RS256', kid: 'e2e-key', typ: 'at+jwt' })}.${b64(payload)}`;
  return `${input}.${sign('sha256', Buffer.from(input), signingKey.privateKey).toString('base64url')}`;
};

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
};

const closeServer = async (server: Server): Promise<void> => {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
};

describe('serve --http --http-auth oauth', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const startIssuer = async (): Promise<string> => {
    let issuer = '';
    const server = createServer((req, res) => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
        return;
      }
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    issuer = `http://127.0.0.1:${String(await listen(server))}`;
    cleanups.push(() => closeServer(server));
    return issuer;
  };

  const startUpstream = async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    return { port, seen };
  };

  const spawnServe = async (args: readonly string[]) => {
    const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-serve-oauth-'));
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'serve', '--spec', 'petstore.json', ...args],
      {
        cwd: fixturesDir,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          UPSTREAM_TOKEN: `Bearer ${UPSTREAM_SECRET}`,
          MCP_TOKEN: 'A'.repeat(43),
        },
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const exited = once(child, 'exit');
    cleanups.push(async () => {
      // Graceful, so the child writes its coverage (cli-subprocess.ts)
      await stopChild(child);
      await exited;
      await rm(home, { recursive: true, force: true });
    });
    return { child, exited, stderr: () => Buffer.concat(stderr).toString('utf8') };
  };

  // A raw request so the Host header can name the public audience host
  // while the socket goes to the loopback listener.
  const post = async (
    port: number,
    host: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }> => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        ...headers,
      },
    });
    req.end(JSON.stringify(body));
    const [res] = (await once(req, 'response')) as [IncomingMessage];
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      chunks.push(chunk as Buffer);
    }
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
  };

  const waitForListener = async (port: number, host: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        // Sequential on purpose: a bounded liveness poll.
        await post(port, host, {}, {});
        return;
      } catch {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    throw new Error('serve never came up');
  };

  it.each<[string, readonly string[], RegExp]>([
    ['--http-host without --http', ['--http-host', '0.0.0.0'], /require --http/u],
    ['--oauth-issuer without --http', ['--oauth-issuer', 'https://a.example'], /require --http/u],
    [
      '--http-host in static-token mode',
      ['--http', '--http-token-env', 'MCP_TOKEN', '--http-host', '0.0.0.0'],
      /require --http-auth oauth/u,
    ],
    ['an unknown --http-auth mode', ['--http', '--http-auth', 'basic'], /--http-auth must be/u],
    [
      'oauth mode without issuer and audience',
      ['--http', '--http-auth', 'oauth'],
      /requires --oauth-issuer/u,
    ],
    [
      'oauth mode combined with --http-token-env',
      ['--http', '--http-auth', 'oauth', '--http-token-env', 'MCP_TOKEN'],
      /cannot be combined/u,
    ],
    [
      'a non-IP --http-host',
      [
        '--http',
        '--http-auth',
        'oauth',
        '--oauth-issuer',
        'https://a.example',
        '--oauth-audience',
        'https://m.example',
        '--http-host',
        'example.test',
      ],
      /must be an IP address/u,
    ],
    [
      'a network bind with a cleartext audience',
      [
        '--http',
        '--http-auth',
        'oauth',
        '--oauth-issuer',
        'https://a.example',
        '--oauth-audience',
        'http://127.0.0.1:4381/mcp',
        '--http-host',
        '0.0.0.0',
      ],
      /requires an https --oauth-audience/u,
    ],
    [
      'a malformed scope',
      [
        '--http',
        '--http-auth',
        'oauth',
        '--oauth-issuer',
        'https://a.example',
        '--oauth-audience',
        'https://m.example',
        '--oauth-required-scope',
        'two words',
      ],
      /scope tokens/u,
    ],
  ])('rejects %s at startup (usage error, before any spec work)', async (_label, args, message) => {
    const serve = await spawnServe(args);
    const [code] = await serve.exited;
    expect(code).toBe(2);
    expect(serve.stderr()).toMatch(message);
  });

  it('fails startup when the authorization server cannot be discovered', async () => {
    const serve = await spawnServe([
      '--base-url',
      'http://127.0.0.1:1',
      '--http',
      '--port',
      '4381',
      '--http-auth',
      'oauth',
      '--oauth-issuer',
      'http://127.0.0.1:1',
      '--oauth-audience',
      'http://127.0.0.1:4381/mcp',
    ]);
    const [code] = await serve.exited;
    expect(code).not.toBe(0);
    expect(serve.stderr()).toMatch(/cannot discover the authorization server metadata/u);
  });

  it('binds a network interface, challenges unauthenticated clients, and never forwards the client token upstream', async () => {
    const issuer = await startIssuer();
    const upstream = await startUpstream();
    const audience = 'https://mcp.example.test/mcp';
    const serve = await spawnServe([
      '--base-url',
      `http://127.0.0.1:${String(upstream.port)}`,
      '--header-env',
      'Authorization=UPSTREAM_TOKEN',
      '--trust-spec-updates',
      '--http',
      '--port',
      '4382',
      '--http-host',
      '0.0.0.0',
      '--http-auth',
      'oauth',
      '--oauth-issuer',
      issuer,
      '--oauth-audience',
      audience,
      '--oauth-required-scope',
      'mcp:tools',
    ]);
    await waitForListener(4382, 'mcp.example.test');

    const listBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: MODERN_ENVELOPE },
    };
    const unauthenticated = await post(4382, 'mcp.example.test', listBody, {
      'mcp-method': 'tools/list',
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"',
    );

    const token = signToken({
      iss: issuer,
      aud: audience,
      sub: 'user-1',
      scope: 'mcp:tools',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const callBody = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'listPets', arguments: {}, _meta: MODERN_ENVELOPE },
    };
    const called = await post(4382, 'mcp.example.test', callBody, {
      'mcp-method': 'tools/call',
      'mcp-name': 'listPets',
      authorization: `Bearer ${token}`,
    });
    expect(called.status).toBe(200);
    expect(called.body).toContain('Rex');
    // The upstream saw the operator's credential — never the client's token.
    expect(upstream.seen).toStrictEqual([`Bearer ${UPSTREAM_SECRET}`]);
    expect(called.body).not.toContain(token);
    expect(serve.stderr()).not.toContain(token);

    // A Host other than the audience's is refused before authentication.
    const wrongHost = await post(4382, '127.0.0.1:4382', callBody, {
      'mcp-method': 'tools/call',
      'mcp-name': 'listPets',
      authorization: `Bearer ${token}`,
    });
    expect(wrongHost.status).toBe(403);
    expect(upstream.seen).toHaveLength(1);
    expect(serve.stderr()).not.toMatch(/no --oauth-required-scope/u);
  }, 20_000);

  it('warns at startup when a network bind requires no scope', async () => {
    const issuer = await startIssuer();
    const upstream = await startUpstream();
    const serve = await spawnServe([
      '--base-url',
      `http://127.0.0.1:${String(upstream.port)}`,
      '--trust-spec-updates',
      '--http',
      '--port',
      '4383',
      '--http-host',
      '0.0.0.0',
      '--http-auth',
      'oauth',
      '--oauth-issuer',
      issuer,
      '--oauth-audience',
      'https://mcp.example.test/mcp',
    ]);
    await waitForListener(4383, 'mcp.example.test');
    expect(serve.stderr()).toMatch(
      /no --oauth-required-scope is set, so every access token .* grants full access to all tools/u,
    );
  }, 20_000);
});

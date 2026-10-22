import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createOAuthResourceServer,
  createRedactor,
  SYSTEM_HEADERS,
  textOutcome,
} from '../src/index.ts';
import type { NamedOperation, ToolExecutor } from '../src/index.ts';
import { createStreamableHttpServer } from '../src/server/sdk/streamable-http.ts';
import type { StreamableHttpServerHandle } from '../src/server/sdk/streamable-http.ts';
import { loopbackTransport, makeKey, signJwt, startIssuer } from './helpers/oauth-issuer.ts';
import type { TestIssuer, TestKey } from './helpers/oauth-issuer.ts';

// The HTTP front door in OAuth resource-server mode, end to end over real
// sockets: Protected Resource Metadata, the 401/403 challenges, and a valid
// token reaching the MCP handler. Ports 4660-4669 and 4680 are disjoint from
// the other HTTP suites (core 4610-4651 and 4670-4673, CLI 3999/4083/4177/4271).

const namedOp: NamedOperation = {
  toolName: 'listThings',
  operation: {
    method: 'get',
    path: '/things',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: { '200': { description: 'ok' } },
  },
};
const snapshot = buildSnapshot(
  buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
  {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  },
);
const discoverSnapshot = buildSnapshot(
  buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
  {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  },
  { toolMode: 'discover' },
);

const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'oauth-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

type Running = {
  issuer: TestIssuer;
  key: TestKey;
  server: StreamableHttpServerHandle;
  port: number;
  audience: string;
  errors: string[];
  executorCalls: number;
};

const running: Running[] = [];
// One distinct port per rejection case (see the port note above).
const rejectionPorts = [4662, 4663, 4664, 4665];

const start = async (port: number, served = snapshot): Promise<Running> => {
  const key = makeKey('ES256', 'k1');
  const issuer = await startIssuer([key]);
  const audience = `http://127.0.0.1:${String(port)}/mcp`;
  const oauth = await createOAuthResourceServer(
    {
      issuer: issuer.issuer,
      audience,
      requiredScopes: ['mcp:tools'],
      allowPrivateNetwork: false,
      timeoutMs: 5000,
    },
    { transport: loopbackTransport, now: () => Date.now() },
  );
  const errors: string[] = [];
  const entry: Running = {
    issuer,
    key,
    server: undefined as unknown as StreamableHttpServerHandle,
    port,
    audience,
    errors,
    executorCalls: 0,
  };
  const executor: ToolExecutor = () => {
    entry.executorCalls += 1;
    return Promise.resolve(textOutcome('upstream ok', false));
  };
  entry.server = createStreamableHttpServer({
    name: 'oauth-test',
    version: '1.0.0',
    snapshot: served,
    dispatcherDeps: {
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => Date.now(),
      executor,
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([]),
    },
    guard: { allowedOrigins: new Set(), allowedHost: oauth.publicHost, oauth },
    port,
    onError: (error) => {
      errors.push(error.message);
    },
  });
  await entry.server.listen();
  running.push(entry);
  return entry;
};

const tokenFor = (entry: Running, over: Record<string, unknown> = {}): string =>
  signJwt(entry.key, {
    iss: entry.issuer.issuer,
    aud: entry.audience,
    scope: 'mcp:tools',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...over,
  });

const call = (
  entry: Running,
  token?: string,
  method = 'tools/list',
  params: Record<string, unknown> = {},
) =>
  fetch(`http://127.0.0.1:${String(entry.port)}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: MODERN_ENVELOPE },
    }),
  });

describe('Streamable HTTP — OAuth resource-server mode', () => {
  afterEach(async () => {
    const all = running.splice(0);
    await Promise.all(
      all.map(async (entry) => {
        await entry.server.close();
        await entry.issuer.close();
      }),
    );
  });

  it('serves RFC 9728 Protected Resource Metadata without authentication (GET and HEAD), and 405 for other methods', async () => {
    const entry = await start(4660);
    const prmUrl = `http://127.0.0.1:4660/.well-known/oauth-protected-resource/mcp`;
    const get = await fetch(prmUrl);
    expect(get.status).toBe(200);
    expect(await get.json()).toStrictEqual({
      resource: entry.audience,
      authorization_servers: [entry.issuer.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    });
    const head = await fetch(prmUrl, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${prmUrl}/`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers an unauthenticated MCP request with 401 and WWW-Authenticate: Bearer resource_metadata=…', async () => {
    const entry = await start(4661);
    const response = await call(entry);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://127.0.0.1:4661/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"',
    );
    expect(entry.errors).toStrictEqual([]);
  });

  it.each<[string, (entry: Running) => string]>([
    ['wrong aud', (entry) => tokenFor(entry, { aud: 'http://127.0.0.1:9/other' })],
    ['expired', (entry) => tokenFor(entry, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    [
      'alg none',
      (entry) =>
        `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${tokenFor(entry).split('.')[1] ?? ''}.`,
    ],
    [
      'unknown kid',
      (entry) =>
        signJwt(makeKey('ES256', 'nope'), {
          iss: entry.issuer.issuer,
          aud: entry.audience,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
    ],
  ])(
    'rejects a token with %s: 401 invalid_token, nothing dispatched, cause reported without the token',
    async (_label, makeToken) => {
      const port = rejectionPorts.shift() ?? 0;
      const entry = await start(port);
      const token = makeToken(entry);
      const response = await call(entry, token, 'tools/call', {
        name: 'listThings',
        arguments: {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token"/u);
      expect(await response.json()).toStrictEqual({
        error: 'invalid_token',
        error_description: 'The access token is invalid or expired',
      });
      expect(entry.executorCalls).toBe(0);
      expect(entry.errors).toHaveLength(1);
      expect(entry.errors.join('\n')).not.toContain(token);
    },
  );

  it('answers a token without the required scope with 403 insufficient_scope', async () => {
    const entry = await start(4666);
    const response = await call(entry, tokenFor(entry, { scope: 'other' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toMatch(
      /^Bearer error="insufficient_scope", .*scope="mcp:tools"$/u,
    );
  });

  it('serves tools/list and tools/call for a valid token', async () => {
    const entry = await start(4667);
    const list = await call(entry, tokenFor(entry));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain('listThings');
    const called = await call(entry, tokenFor(entry), 'tools/call', {
      name: 'listThings',
      arguments: {},
    });
    expect(called.status).toBe(200);
    expect(entry.executorCalls).toBe(1);
  });

  it('puts call_operation (discover mode) behind the same token check as any direct tool call', async () => {
    const entry = await start(4680, discoverSnapshot);
    const params = { name: 'call_operation', arguments: { name: 'listThings' } };
    const anonymous = await call(entry, undefined, 'tools/call', params);
    expect(anonymous.status).toBe(401);
    const unscoped = await call(entry, tokenFor(entry, { scope: 'other' }), 'tools/call', params);
    expect(unscoped.status).toBe(403);
    expect(entry.executorCalls).toBe(0);
    const allowed = await call(entry, tokenFor(entry), 'tools/call', params);
    expect(allowed.status).toBe(200);
    expect(entry.executorCalls).toBe(1);
  });

  it('keeps the Host check in front of everything: a foreign Host gets 403, even for the metadata document', async () => {
    const entry = await start(4668);
    const { request } = await import('node:http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: entry.port,
          path: '/.well-known/oauth-protected-resource/mcp',
          headers: { host: 'evil.example.test' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('Streamable HTTP — bind address', () => {
  it('refuses a non-loopback bind address in static-token mode', () => {
    expect(() =>
      createStreamableHttpServer({
        name: 'x',
        version: '1',
        snapshot,
        dispatcherDeps: {
          limiter: { consume: () => true, retryAfterMs: () => 0 },
          now: () => Date.now(),
          executor: () => Promise.resolve(textOutcome('x', false)),
          metaExecutor: createMetaExecutor(),
          redactor: createRedactor([]),
        },
        guard: {
          allowedOrigins: new Set(),
          allowedHost: '0.0.0.0:4669',
          bearer: { configuredToken: 'A'.repeat(43) },
        },
        port: 4669,
        hostname: '0.0.0.0',
      }),
    ).toThrow(/requires OAuth resource-server mode/u);
  });
});

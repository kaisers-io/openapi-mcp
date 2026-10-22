import { describe, expect, it } from 'vitest';
import { Response } from 'undici';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type {
  ExecutorConfig,
  NamedOperation,
  PinnedDeps,
  SnapshotTool,
  TokenResult,
  TokenSource,
} from '../src/index.ts';

// The executor's OAuth2 wiring: Bearer injection, the single replay on 401,
// and token-failure mapping — against a fake TokenSource and a fake fetch
// (the real pinnedRequest still runs).

const ops: NamedOperation[] = [
  {
    toolName: 'ping',
    operation: {
      method: 'get',
      path: '/ping',
      tags: [],
      deprecated: false,
      parameters: [],
      responses: { '204': { description: 'none' } },
    },
  },
  {
    toolName: 'create',
    operation: {
      method: 'post',
      path: '/things',
      tags: [],
      deprecated: false,
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
      },
      responses: { '204': { description: 'none' } },
    },
  },
];

const snapshot = buildSnapshot(
  buildTools(ops, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
  {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  },
);
const tool = (name: string): SnapshotTool => snapshot.toolsByName[name] as SnapshotTool;

// Hands out tok-1, tok-2, ... ; invalidate() is recorded.
// With `keep`, invalidate() declines (a just-minted token, see
// TokenSource.invalidate) and the cached token stays.
const fakeTokens = (
  results?: TokenResult[],
  keep = false,
): { source: TokenSource; invalidated: string[]; fetched: () => number } => {
  let current: string | undefined;
  let count = 0;
  const invalidated: string[] = [];
  return {
    source: {
      getToken: () => {
        if (results !== undefined) {
          const next = results[count] ?? { error: 'exhausted' };
          count += 1;
          return Promise.resolve(next);
        }
        if (current === undefined) {
          count += 1;
          current = `oauth-access-token-${String(count)}`;
        }
        return Promise.resolve({ ok: current });
      },
      invalidate: (token) => {
        invalidated.push(token);
        if (keep) {
          return false;
        }
        if (token === current) {
          current = undefined;
        }
        return true;
      },
    },
    invalidated,
    fetched: () => count,
  };
};

type Seen = { authorization: string | undefined; body: string | undefined };

const run = async (
  name: string,
  args: Record<string, unknown>,
  statuses: number[],
  tokens: TokenSource,
  overrides: Partial<ExecutorConfig> = {},
) => {
  const seen: Seen[] = [];
  const fetch: PinnedDeps['fetch'] = (_input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body as Uint8Array | undefined;
    seen.push({
      authorization: headers['authorization'],
      body: raw === undefined ? undefined : new TextDecoder().decode(raw),
    });
    const status = statuses[seen.length - 1] ?? 500;
    return Promise.resolve(new Response(status === 204 ? null : 'denied', { status }));
  };
  const executor = createExecutor(
    {
      baseUrl: 'https://api.example.test',
      baseTrusted: true,
      allowPrivateNetwork: false,
      allowInsecureHttp: false,
      secretHeaders: [],
      staticHeaders: [],
      reservedHeaderNames: new Set(SYSTEM_HEADERS),
      redactor: createRedactor([]),
      timeoutMs: 5000,
      maxResponseBytes: 65_536,
      outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
      maxConcurrent: 4,
      validators: new Map(
        snapshot.tools.map((entry) => [
          entry.name,
          compileEnvelopeValidator(entry.wireTool.outputSchema),
        ]),
      ),
      oauth: { tokens, envVarHint: 'CID / CSECRET' },
      ...overrides,
    },
    {
      transport: {
        fetch,
        resolve: () => Promise.reject(new Error('no DNS')),
        timeoutSignal: () => new AbortController().signal,
      },
    },
  );
  const outcome = await executor(tool(name), args, new AbortController().signal);
  return { outcome, seen };
};

describe('createExecutor — OAuth2 client credentials', () => {
  it('sends the access token as Authorization: Bearer', async () => {
    const tokens = fakeTokens();
    const { outcome, seen } = await run('ping', {}, [204], tokens.source);
    expect(outcome.isError).toBe(false);
    expect(seen).toEqual([{ authorization: 'Bearer oauth-access-token-1', body: undefined }]);
  });

  it('on 401: invalidates the token, fetches a new one, replays ONCE (body included)', async () => {
    const tokens = fakeTokens();
    const { outcome, seen } = await run('create', { name: 'x' }, [401, 204], tokens.source);
    expect(outcome.isError).toBe(false);
    expect(tokens.invalidated).toEqual(['oauth-access-token-1']);
    expect(seen.map((entry) => entry.authorization)).toEqual([
      'Bearer oauth-access-token-1',
      'Bearer oauth-access-token-2',
    ]);
    expect(seen[1]?.body).toBe(seen[0]?.body);
    expect(seen[1]?.body).toContain('"name":"x"');
  });

  it('a second 401 is returned as-is with the env-var hint, no further retry', async () => {
    const tokens = fakeTokens();
    const { outcome, seen } = await run('ping', {}, [401, 401, 204], tokens.source);
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).toContain(
      'upstream request failed with status 401 (check the CID / CSECRET environment variable)',
    );
    expect(seen).toHaveLength(2);
    expect(tokens.fetched()).toBe(2);
  });

  it('does not replay when the token source keeps the token (minted moments ago)', async () => {
    const tokens = fakeTokens(undefined, true);
    const { outcome, seen } = await run('ping', {}, [401, 204], tokens.source);
    expect(outcome.isError).toBe(true);
    expect(seen).toHaveLength(1);
    expect(tokens.invalidated).toEqual(['oauth-access-token-1']);
    expect(tokens.fetched()).toBe(1);
  });

  it('403 is not retried (the token was accepted, the action was not)', async () => {
    const tokens = fakeTokens();
    const { seen } = await run('ping', {}, [403], tokens.source);
    expect(seen).toHaveLength(1);
    expect(tokens.invalidated).toEqual([]);
  });

  it('a token failure is a tool error naming the env vars, and nothing is sent', async () => {
    const tokens = fakeTokens([{ error: 'could not obtain an OAuth2 access token: boom' }]);
    const { outcome, seen } = await run('ping', {}, [204], tokens.source);
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).toContain(
      'could not obtain an OAuth2 access token: boom (check the CID / CSECRET environment variables)',
    );
    expect(seen).toHaveLength(0);
  });

  it('a token failure on the replay is reported the same way', async () => {
    const tokens = fakeTokens([{ ok: 'first-oauth-token' }, { error: 'refetch failed' }]);
    const { outcome, seen } = await run('ping', {}, [401], tokens.source);
    expect(JSON.stringify(outcome)).toContain('refetch failed (check the CID / CSECRET');
    expect(seen).toHaveLength(1);
  });

  it('the cleartext gate covers the OAuth token like a --header-env secret', async () => {
    const tokens = fakeTokens();
    const { outcome, seen } = await run('ping', {}, [204], tokens.source, {
      baseUrl: 'http://api.example.test',
    });
    expect(JSON.stringify(outcome)).toContain('refusing to send a secret header in cleartext');
    expect(seen).toHaveLength(0);
    expect(tokens.fetched()).toBe(0);
  });

  it('re-checks the header budget with the token in place', async () => {
    const tokens = fakeTokens([{ ok: 'x'.repeat(200) }]);
    const { outcome, seen } = await run('ping', {}, [204], tokens.source, {
      outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 100, maxBodyBytes: 65_536 },
    });
    expect(JSON.stringify(outcome)).toContain('exceeds the outbound resource budget');
    expect(seen).toHaveLength(0);
  });
});

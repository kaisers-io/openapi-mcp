import { EventEmitter } from 'node:events';
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
import type { CallTelemetry } from '../src/server/telemetry.ts';

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
  const reports: CallTelemetry[] = [];
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
      // No real backoff waits; a frozen clock keeps the whole budget.
      retry: { sleep: () => Promise.resolve(), random: () => 0, now: () => 0 },
    },
  );
  const outcome = await executor(
    tool(name),
    args,
    new AbortController().signal,
    undefined,
    (telemetry) => {
      reports.push(telemetry);
    },
  );
  return { outcome, seen, reports };
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

  // The 401 replay (token refresh) and --retries (transient failures) are
  // separate budgets: neither one uses up the other.
  it('a retry spent before the 401 does not prevent the replay', async () => {
    const tokens = fakeTokens();
    const { outcome, seen, reports } = await run('ping', {}, [503, 401, 204], tokens.source, {
      retries: 1,
    });
    expect(outcome.isError).toBe(false);
    expect(seen.map((entry) => entry.authorization)).toEqual([
      'Bearer oauth-access-token-1',
      'Bearer oauth-access-token-1',
      'Bearer oauth-access-token-2',
    ]);
    expect(reports).toMatchObject([{ outcome: 'ok', status: 204, attempts: 3 }]);
  });

  it('the replay does not use up a retry', async () => {
    const tokens = fakeTokens();
    const { outcome, seen, reports } = await run('ping', {}, [401, 503, 204], tokens.source, {
      retries: 1,
    });
    expect(outcome.isError).toBe(false);
    expect(seen.map((entry) => entry.authorization)).toEqual([
      'Bearer oauth-access-token-1',
      'Bearer oauth-access-token-2',
      'Bearer oauth-access-token-2',
    ]);
    expect(reports).toMatchObject([{ outcome: 'ok', attempts: 3 }]);
  });

  it('retries are one budget across the replay, and a 401 is never retried as transient', async () => {
    const tokens = fakeTokens();
    const { outcome, seen, reports } = await run('ping', {}, [503, 401, 503, 204], tokens.source, {
      retries: 1,
    });
    expect(outcome.isError).toBe(true);
    expect(seen).toHaveLength(3);
    expect(tokens.fetched()).toBe(2);
    expect(reports).toMatchObject([{ outcome: 'http_error', status: 503, attempts: 3 }]);
  });

  it('a token failure is reported as token_error, not as bad arguments', async () => {
    const tokens = fakeTokens([{ error: 'could not obtain an OAuth2 access token: boom' }]);
    const { reports } = await run('ping', {}, [204], tokens.source);
    expect(reports).toMatchObject([
      { outcome: 'token_error', method: 'GET', pathTemplate: '/ping' },
    ]);
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

// Issue #21: a caller waiting for a shared token request stops waiting when
// it is cancelled or its time budget runs out, without aborting the request
// the other callers share, and never starts an API request past its budget.
describe('createExecutor — OAuth2 token waits honour each caller (#21)', () => {
  // One token request, settled by the test
  const pendingTokens = (): {
    source: TokenSource;
    issue: (result: TokenResult) => void;
    requested: () => number;
  } => {
    let requests = 0;
    let shared: Promise<TokenResult> | undefined;
    const { promise, resolve } = Promise.withResolvers<TokenResult>();
    return {
      source: {
        getToken: () => {
          if (shared === undefined) {
            requests += 1;
            shared = promise;
          }
          return shared;
        },
        invalidate: () => true,
      },
      issue: resolve,
      requested: () => requests,
    };
  };

  const executorWith = (
    tokens: TokenSource,
    options: {
      statuses?: number[];
      timeoutMs?: number;
      maxConcurrent?: number;
      timeoutSignal?: (ms: number) => AbortSignal;
      now?: () => number;
      onFetch?: () => void;
    } = {},
  ) => {
    const sent: string[] = [];
    const reports: CallTelemetry[] = [];
    const fetch: PinnedDeps['fetch'] = (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push(headers['authorization'] ?? '');
      options.onFetch?.();
      const status = options.statuses?.[sent.length - 1] ?? 204;
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
        timeoutMs: options.timeoutMs ?? 5000,
        maxResponseBytes: 65_536,
        outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
        maxConcurrent: options.maxConcurrent ?? 4,
        validators: new Map(
          snapshot.tools.map((entry) => [
            entry.name,
            compileEnvelopeValidator(entry.wireTool.outputSchema),
          ]),
        ),
        oauth: { tokens, envVarHint: 'CID / CSECRET' },
      },
      {
        transport: {
          fetch,
          resolve: () => Promise.reject(new Error('no DNS')),
          timeoutSignal: options.timeoutSignal ?? (() => new AbortController().signal),
        },
        retry: {
          sleep: () => Promise.resolve(),
          random: () => 0,
          now: options.now ?? (() => 0),
        },
      },
    );
    const call = (name: string, signal = new AbortController().signal) =>
      executor(tool(name), name === 'create' ? { name: 'x' } : {}, signal, undefined, (entry) => {
        reports.push(entry);
      });
    return { call, sent, reports };
  };

  it('a cancelled caller stops waiting at once; the other caller still gets the token', async () => {
    const tokens = pendingTokens();
    const { call, sent, reports } = executorWith(tokens.source);
    const cancelled = new AbortController();
    const first = call('create', cancelled.signal);
    const second = call('ping');
    await Promise.resolve();
    cancelled.abort();
    const outcome = await first;
    // Settled before the token arrived, and nothing was sent for it
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).toContain('the request was cancelled');
    expect(sent).toEqual([]);
    expect(reports).toMatchObject([{ outcome: 'cancelled', method: 'POST' }]);
    tokens.issue({ ok: 'shared-token' });
    const served = await second;
    expect(served.isError).toBe(false);
    expect(sent).toEqual(['Bearer shared-token']);
    expect(tokens.requested()).toBe(1);
  });

  it('a cancelled caller frees its slot before the token arrives', async () => {
    const tokens = pendingTokens();
    const { call } = executorWith(tokens.source, { maxConcurrent: 1 });
    const cancelled = new AbortController();
    const first = call('ping', cancelled.signal);
    await Promise.resolve();
    cancelled.abort();
    await first;
    // The only slot is free again: a new call gets it and waits for the token
    const second = call('ping');
    tokens.issue({ ok: 'shared-token' });
    const served = await second;
    expect(served.isError).toBe(false);
  });

  it('a caller whose budget runs out while waiting for the first token times out', async () => {
    const tokens = pendingTokens();
    const { call, sent, reports } = executorWith(tokens.source, {
      timeoutMs: 40,
      timeoutSignal: (ms) => AbortSignal.timeout(ms),
    });
    const outcome = await call('create');
    expect(JSON.stringify(outcome)).toContain('timed out waiting for an OAuth2 access token');
    expect(sent).toEqual([]);
    expect(reports).toMatchObject([{ outcome: 'timeout', method: 'POST' }]);
    // The shared request is not aborted for the others
    tokens.issue({ ok: 'late-token' });
  });

  it('a caller whose budget runs out while waiting for a refreshed token times out', async () => {
    let calls = 0;
    const issued = Promise.withResolvers<TokenResult>();
    const tokens: TokenSource = {
      getToken: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve({ ok: 'stale' }) : issued.promise;
      },
      invalidate: () => true,
    };
    const { call, sent } = executorWith(tokens, {
      statuses: [401],
      timeoutMs: 40,
      timeoutSignal: (ms) => AbortSignal.timeout(ms),
    });
    const outcome = await call('ping');
    expect(JSON.stringify(outcome)).toContain('timed out waiting for an OAuth2 access token');
    expect(sent).toEqual(['Bearer stale']);
    issued.resolve({ ok: 'fresh' });
  });

  it('sends nothing when the token arrives just as the budget runs out', async () => {
    let clock = 0;
    const tokens: TokenSource = {
      getToken: () => {
        clock = 1000;
        return Promise.resolve({ ok: 'late' });
      },
      invalidate: () => true,
    };
    const { call, sent, reports } = executorWith(tokens, { timeoutMs: 1000, now: () => clock });
    const outcome = await call('create');
    expect(JSON.stringify(outcome)).toContain('the call timed out before the request was sent');
    expect(sent).toEqual([]);
    expect(reports).toMatchObject([{ outcome: 'timeout', method: 'POST' }]);
  });

  it('sends no 401 replay once the budget is spent', async () => {
    let clock = 0;
    const tokens = fakeTokens();
    const { call, sent, reports } = executorWith(tokens.source, {
      statuses: [401, 204],
      timeoutMs: 1000,
      now: () => clock,
      // The first attempt uses up the whole budget
      onFetch: () => {
        clock += 1000;
      },
    });
    const outcome = await call('create');
    expect(JSON.stringify(outcome)).toContain(
      'the call timed out before the request could be sent again with a fresh OAuth2 access token; it was not applied',
    );
    expect(sent).toEqual(['Bearer oauth-access-token-1']);
    expect(reports).toMatchObject([{ outcome: 'timeout', method: 'POST' }]);
  });

  it('removes its abort listener from the caller signal when the wait is abandoned', async () => {
    const tokens = pendingTokens();
    const { call } = executorWith(tokens.source);
    const cancelled = new AbortController();
    const first = call('ping', cancelled.signal);
    await Promise.resolve();
    expect(EventEmitter.getEventListeners(cancelled.signal, 'abort')).toHaveLength(1);
    cancelled.abort();
    await first;
    // Nothing else ever listened: the call never reached the transport
    expect(EventEmitter.getEventListeners(cancelled.signal, 'abort')).toHaveLength(0);
    tokens.issue({ ok: 'late-token' });
  });
});

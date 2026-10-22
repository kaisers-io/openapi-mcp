import { describe, expect, it } from 'vitest';
import { Response } from 'undici';
import {
  buildSnapshot,
  buildTools,
  clientSecretBasic,
  compileEnvelopeValidator,
  createCallStats,
  createClientCredentialsSource,
  createDispatcher,
  createExecutor,
  createMetaExecutor,
  createRedactor,
  formatCallLog,
  META_TOOL_NAME,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { CallRecord, NamedOperation, PinnedDeps } from '../src/index.ts';

// Upstream OAuth2 credentials never reach the call records, the --log json
// lines, the status counters or a tool result — not on success, not across
// a 401 token replay, and not when the token endpoint echoes the secret back
// in its error body.

const CLIENT_ID = 'demo-client-id';
const CLIENT_SECRET = 'example-client-secret-not-real-4711';
const TOKEN_URL = 'https://auth.example.test/oauth/token';
const tokenValue = (n: number): string => `example-access-token-${String(n)}-not-real-0815`;

const getThing: NamedOperation = {
  toolName: 'getThing',
  operation: {
    method: 'get',
    path: '/thing',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: { '200': { description: 'echo', content: { 'text/plain': {} } } },
  },
};

const snapshot = buildSnapshot(
  buildTools([getThing], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
  {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  },
);

type Endpoint = (authorization: string | undefined, index: number) => Response;

const harness = (token: Endpoint, api: Endpoint) => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const fetch: PinnedDeps['fetch'] = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (String(input) === TOKEN_URL) {
      tokenCalls += 1;
      return Promise.resolve(token(headers['authorization'], tokenCalls));
    }
    apiCalls += 1;
    return Promise.resolve(api(headers['authorization'], apiCalls));
  };
  const transport: PinnedDeps = {
    fetch,
    resolve: () => Promise.reject(new Error('no DNS in this suite')),
    timeoutSignal: () => new AbortController().signal,
  };
  // As serve builds it: the client secret and its Basic form are startup
  // secrets; access tokens are registered as they are issued.
  const redactor = createRedactor([CLIENT_SECRET, clientSecretBasic(CLIENT_ID, CLIENT_SECRET)]);
  const tokens = createClientCredentialsSource(
    {
      tokenUrl: new URL(TOKEN_URL),
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [],
      clientAuth: 'client_secret_basic',
      allowPrivateNetwork: false,
      timeoutMs: 5000,
      redactor,
      now: () => Date.now(),
    },
    transport,
  );
  const executor = createExecutor(
    {
      baseUrl: 'https://api.example.test',
      baseTrusted: true,
      allowPrivateNetwork: false,
      allowInsecureHttp: false,
      secretHeaders: [],
      staticHeaders: [],
      reservedHeaderNames: new Set(SYSTEM_HEADERS),
      redactor,
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
    },
    { transport },
  );
  const records: CallRecord[] = [];
  const lines: string[] = [];
  const stats = createCallStats();
  const dispatcher = createDispatcher({
    snapshot,
    limiter: { consume: () => true, retryAfterMs: () => 0 },
    now: () => Date.now(),
    executor,
    metaExecutor: createMetaExecutor({ stats }),
    redactor,
    onCall: (record) => {
      stats.record(record);
      records.push(record);
      lines.push(formatCallLog(record, redactor, new Date(0)));
    },
  });
  const call = async (name: string) =>
    await dispatcher.call({ name, arguments: {}, signal: new AbortController().signal });
  return { call, records, lines, counts: () => ({ tokenCalls, apiCalls }) };
};

const expectNoCredential = (text: string): void => {
  expect(text).not.toContain(CLIENT_SECRET);
  expect(text).not.toContain(clientSecretBasic(CLIENT_ID, CLIENT_SECRET).slice('Basic '.length));
  expect(text).not.toContain('example-access-token-');
};

const issue = (_authorization: string | undefined, index: number): Response =>
  Response.json({ access_token: tokenValue(index), token_type: 'Bearer', expires_in: 3600 });

// A hostile upstream: echoes the Authorization header it received.
const echo =
  (statuses: number[]): Endpoint =>
  (authorization, index) =>
    new Response(`you sent ${authorization ?? 'nothing'}`, {
      status: statuses[index - 1] ?? 500,
      headers: { 'content-type': 'text/plain' },
    });

describe('upstream OAuth2 credentials never reach call records, logs or results', () => {
  it('on success and across a 401 token replay', async () => {
    const run = harness(issue, echo([200, 401, 200]));
    const outputs = [
      await run.call('getThing'),
      // The second call is rejected with 401 and replayed with a new token.
      await run.call('getThing'),
      await run.call(META_TOOL_NAME),
    ];
    expect(run.counts()).toEqual({ tokenCalls: 2, apiCalls: 3 });
    expect(run.records.map((record) => record.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(run.records[1]?.attempts).toBe(2);
    expectNoCredential(JSON.stringify(outputs));
    expectNoCredential(JSON.stringify(run.records));
    expectNoCredential(run.lines.join('\n'));
  });

  it('when the token endpoint echoes the client secret in its error body', async () => {
    const run = harness(
      () =>
        Response.json(
          { error: 'invalid_client', error_description: `bad secret ${CLIENT_SECRET}` },
          { status: 401 },
        ),
      echo([200]),
    );
    const outputs = [await run.call('getThing'), await run.call(META_TOOL_NAME)];
    expect(run.counts()).toEqual({ tokenCalls: 1, apiCalls: 0 });
    expect(run.records.map((record) => record.outcome)).toEqual(['token_error', 'ok']);
    expect(JSON.stringify(outputs[0])).toContain('HTTP 401 (invalid_client)');
    expectNoCredential(JSON.stringify(outputs));
    expectNoCredential(JSON.stringify(run.records));
    expectNoCredential(run.lines.join('\n'));
  });
});

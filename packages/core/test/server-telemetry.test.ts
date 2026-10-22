import { describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createCallStats,
  createDispatcher,
  createExecutor,
  createMetaExecutor,
  createRedactor,
  formatCallLog,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type {
  CallRecord,
  ExecutorConfig,
  NamedOperation,
  PinnedDeps,
  ServerSnapshot,
  ToolExecutor,
} from '../src/index.ts';
import { EgressError } from '../src/http/pinned-dispatcher.ts';

// Every tools/call yields exactly one record with the right outcome class,
// and nothing in it (or in the formatted log line) came from arguments or
// bodies.

const SECRET = 'example-token-not-a-secret-789';
const MARKER = 'ARG-MARKER-5c1e';

const getPet: NamedOperation = {
  toolName: 'getPetById',
  operation: {
    method: 'get',
    path: '/pet/{petId}',
    tags: [],
    deprecated: false,
    parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          },
        },
      },
    },
  },
};

const snapshotOf = (
  ops: readonly NamedOperation[],
  toolMode: 'per-operation' | 'discover' = 'per-operation',
): ServerSnapshot =>
  buildSnapshot(
    buildTools(ops, { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' }),
    {
      spec: { title: 't', specVersion: '1', omitted: [] },
      contentHash: 'h',
      displaySource: 's',
      deadPatterns: [],
    },
    { toolMode },
  );

const config = (
  snapshot: ServerSnapshot,
  overrides: Partial<ExecutorConfig> = {},
): ExecutorConfig => {
  const validators = new Map(
    snapshot.operations.map((tool) => [
      tool.name,
      compileEnvelopeValidator(tool.wireTool.outputSchema),
    ]),
  );
  return {
    baseUrl: 'https://api.example.test',
    baseTrusted: true,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    secretHeaders: [],
    staticHeaders: [],
    reservedHeaderNames: new Set(SYSTEM_HEADERS),
    redactor: createRedactor([SECRET]),
    timeoutMs: 5000,
    maxResponseBytes: 65_536,
    outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
    maxConcurrent: 4,
    validators,
    ...overrides,
  };
};

// A full dispatcher -> executor -> fake transport pipeline with a fake clock.
const pipeline = (
  fetch: PinnedDeps['fetch'],
  options: { consume?: () => boolean; overrides?: Partial<ExecutorConfig> } = {},
) => {
  const snapshot = snapshotOf([getPet]);
  const records: CallRecord[] = [];
  let clock = 1000;
  const executor = createExecutor(config(snapshot, options.overrides), {
    transport: {
      fetch,
      resolve: () => Promise.reject(new Error('no DNS in this suite')),
      timeoutSignal: () => new AbortController().signal,
    },
    retry: { now: () => clock },
  });
  const dispatcher = createDispatcher({
    snapshot,
    limiter: { consume: options.consume ?? (() => true), retryAfterMs: () => 5000 },
    now: () => {
      clock += 7;
      return clock;
    },
    executor,
    metaExecutor: createMetaExecutor(),
    redactor: createRedactor([SECRET]),
    onCall: (record) => records.push(record),
  });
  const call = (args: Record<string, unknown>, signal = new AbortController().signal) =>
    dispatcher.call({ name: 'getPetById', arguments: args, signal });
  return { call, records, dispatcher };
};

const ok200: PinnedDeps['fetch'] = () => Promise.resolve(Response.json({ id: 1 }));

describe('call records — one per call, classified', () => {
  it('records an ok call with method, path template, status, sizes and timings', async () => {
    const { call, records } = pipeline(ok200);
    await call({ petId: MARKER });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: 'getPetById',
      method: 'GET',
      pathTemplate: '/pet/{petId}',
      status: 200,
      outcome: 'ok',
      responseBytes: 8,
      queuedMs: 0,
    });
    expect(records[0]?.latencyMs).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(MARKER);
  });

  it.each<[string, PinnedDeps['fetch'], string]>([
    ['an HTTP error', () => Promise.resolve(new Response('nope', { status: 404 })), 'http_error'],
    [
      'an upstream body that fails the output schema',
      () => Promise.resolve(Response.json({ id: 'x' })),
      'response_error',
    ],
    [
      'a network failure',
      () => Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') })),
      'network_error',
    ],
    [
      'an egress denial',
      () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new EgressError('egress: private address') }),
        ),
      'egress_denied',
    ],
  ])('classifies %s', async (_label, fetch, outcome) => {
    const { call, records } = pipeline(fetch);
    await call({ petId: '1' });
    expect(records.map((record) => record.outcome)).toEqual([outcome]);
  });

  it('classifies a cancelled call', async () => {
    const { call, records } = pipeline(ok200);
    await call({ petId: '1' }, AbortSignal.abort());
    expect(records.map((record) => record.outcome)).toEqual(['cancelled']);
  });

  it('classifies a rate-limited call and an invalid-arguments call without reaching the executor', async () => {
    const limited = pipeline(ok200, { consume: () => false });
    await limited.call({ petId: '1' });
    expect(limited.records.map((record) => record.outcome)).toEqual(['rate_limited']);
    const invalid = pipeline(ok200);
    await invalid.call({ petId: 42 });
    expect(invalid.records).toEqual([
      expect.objectContaining({ tool: 'getPetById', outcome: 'validation_error' }),
    ]);
  });

  it.each<[string, Partial<ExecutorConfig>]>([
    [
      'the cleartext credential gate',
      {
        baseUrl: 'http://api.example.test',
        secretHeaders: [{ name: 'Authorization', value: `Bearer ${SECRET}`, envVar: 'API_TOKEN' }],
      },
    ],
    [
      'the outbound budget',
      { outboundBudgets: { maxUrlLength: 10, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 } },
    ],
  ])('classifies a refusal by %s as refused, not validation_error', async (_label, overrides) => {
    const { call, records } = pipeline(ok200, { overrides });
    await call({ petId: '1' });
    expect(records.map((record) => record.outcome)).toEqual(['refused']);
  });

  it('records secret_withheld when the boundary turns a reported success into an error', async () => {
    const snapshot = snapshotOf([getPet]);
    const records: CallRecord[] = [];
    const executor: ToolExecutor = (_tool, _args, _signal, _trace, report) => {
      report?.({ outcome: 'ok', method: 'GET', pathTemplate: '/pet/{petId}', status: 200 });
      return Promise.resolve({
        isError: false,
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { status: 200, contentType: 'application/json', data: { t: SECRET } },
      });
    };
    const dispatcher = createDispatcher({
      snapshot,
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([SECRET]),
      onCall: (record) => records.push(record),
    });
    const result = await dispatcher.call({
      name: 'getPetById',
      arguments: { petId: '1' },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'outcome', outcome: { isError: true } });
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'secret_withheld', status: 200, method: 'GET' }),
    ]);
  });

  // The executor withholds a 2xx body that carries a registered secret itself
  // (response.ts), before the boundary sees it: the record must still say
  // secret_withheld, also when forwarded headers rebuild the outcome.
  it.each<[string, Record<string, string>]>([
    ['without forwarded headers', {}],
    ['with a forwarded header', { etag: '"v1"' }],
  ])(
    'records secret_withheld for a 2xx body withheld by the executor (%s)',
    async (_l, headers) => {
      const leaky: PinnedDeps['fetch'] = () =>
        Promise.resolve(Response.json({ id: 1, note: SECRET }, { headers }));
      const { call, records } = pipeline(leaky);
      const result = await call({ petId: '1' });
      expect(result).toMatchObject({ kind: 'outcome', outcome: { isError: true } });
      expect(JSON.stringify(result)).toContain('the upstream call succeeded');
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(records).toEqual([
        expect.objectContaining({ outcome: 'secret_withheld', status: 200, method: 'GET' }),
      ]);
    },
  );

  it('does not record an unknown tool (a protocol error, not a tool call)', async () => {
    const { dispatcher, records } = pipeline(ok200);
    await dispatcher.call({ name: 'nope', arguments: {}, signal: new AbortController().signal });
    expect(records).toEqual([]);
  });

  it('ignores an observer that throws', async () => {
    const snapshot = snapshotOf([getPet]);
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ isError: false, content: [{ type: 'text', text: 'x' }] }),
    );
    const dispatcher = createDispatcher({
      snapshot,
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([]),
      onCall: () => {
        throw new Error('log sink down');
      },
    });
    const result = await dispatcher.call({
      name: 'getPetById',
      arguments: { petId: '1' },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'outcome', outcome: { isError: false } });
  });
});

describe('formatCallLog', () => {
  it('writes one JSON line without arguments, bodies or secrets', async () => {
    const { call, records } = pipeline(() =>
      Promise.resolve(new Response(`upstream says ${SECRET}`, { status: 500 })),
    );
    await call({ petId: MARKER });
    const line = formatCallLog(records[0] as CallRecord, createRedactor([SECRET]), new Date(0));
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      event: 'tool_call',
      tool: 'getPetById',
      method: 'GET',
      pathTemplate: '/pet/{petId}',
      status: 500,
      outcome: 'http_error',
      latencyMs: expect.any(Number) as number,
      responseBytes: expect.any(Number) as number,
      queuedMs: 0,
      upstreamMs: expect.any(Number) as number,
      attempts: 1,
    });
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain(SECRET);
  });

  it('redacts and sanitizes every string field', () => {
    const line = formatCallLog(
      { tool: 't', outcome: 'ok', latencyMs: 1, pathTemplate: `/x/${SECRET}‮` },
      createRedactor([SECRET]),
      new Date(0),
    );
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('‮');
  });
});

describe('createCallStats and openapi_mcp_status', () => {
  const record = (outcome: CallRecord['outcome'], upstreamMs?: number): CallRecord => ({
    tool: 't',
    outcome,
    latencyMs: 1,
    ...(upstreamMs === undefined ? {} : { upstreamMs }),
  });

  it('counts calls by outcome and reports p50/p95 upstream latency over a bounded window', () => {
    const stats = createCallStats(10);
    expect(stats.summary()).toEqual({ total: 0, byOutcome: {}, upstreamLatencyMs: { samples: 0 } });
    for (let ms = 1; ms <= 20; ms += 1) {
      stats.record(record('ok', ms));
    }
    stats.record(record('rate_limited'));
    const summary = stats.summary();
    expect(summary.total).toBe(21);
    expect(summary.byOutcome).toEqual({ ok: 20, rate_limited: 1 });
    // Only the last 10 latencies (11..20) are kept.
    expect(summary.upstreamLatencyMs).toEqual({ samples: 10, p50: 15, p95: 20 });
  });

  it('adds the counters to openapi_mcp_status, and the result still validates against its schema', async () => {
    const snapshot = snapshotOf([getPet]);
    const stats = createCallStats();
    stats.record(record('ok', 12));
    const outcome = await createMetaExecutor({ stats })(snapshot, new AbortController().signal);
    expect(outcome.structuredContent?.['calls']).toEqual({
      total: 1,
      byOutcome: { ok: 1 },
      upstreamLatencyMs: { samples: 1, p50: 12, p95: 12 },
    });
    const metaTool = snapshot.toolsByName['openapi_mcp_status'];
    const validate = compileEnvelopeValidator(metaTool?.wireTool.outputSchema);
    expect(validate?.(outcome.structuredContent)).toBe(true);
    const plain = await createMetaExecutor()(snapshot, new AbortController().signal);
    expect(plain.structuredContent?.['calls']).toBeUndefined();
    expect(validate?.(plain.structuredContent)).toBe(true);
  });
});

describe('call records through call_operation (discover mode)', () => {
  const discoverPipeline = () => {
    const snapshot = snapshotOf([getPet], 'discover');
    const records: CallRecord[] = [];
    const executor = createExecutor(config(snapshot), {
      transport: {
        fetch: ok200,
        resolve: () => Promise.reject(new Error('no DNS in this suite')),
        timeoutSignal: () => new AbortController().signal,
      },
    });
    const dispatcher = createDispatcher({
      snapshot,
      limiter: { consume: () => true, retryAfterMs: () => 0 },
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
      redactor: createRedactor([SECRET]),
      onCall: (record) => records.push(record),
    });
    const call = (args: unknown) =>
      dispatcher.call({
        name: 'call_operation',
        arguments: { name: 'getPetById', arguments: args },
        signal: new AbortController().signal,
      });
    return { call, records };
  };

  it('records the operation that ran, with the upstream facts', async () => {
    const { call, records } = discoverPipeline();
    await call({ petId: '1' });
    expect(records).toEqual([
      expect.objectContaining({
        tool: 'getPetById',
        method: 'GET',
        pathTemplate: '/pet/{petId}',
        status: 200,
        outcome: 'ok',
      }),
    ]);
  });

  it('classifies invalid operation arguments as validation_error', async () => {
    const { call, records } = discoverPipeline();
    await call({ petId: 42 });
    expect(records.map((record) => record.outcome)).toEqual(['validation_error']);
  });
});

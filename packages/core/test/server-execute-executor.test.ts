import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Response, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { pinnedRequest } from '../src/http/pinned-dispatcher.ts';
import {
  buildRequest,
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createEnvelopeCompiler,
  createExecutor,
  createRedactor,
  lazyEnvelopeValidators,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type {
  EnvelopeValidator,
  ExecutorConfig,
  ExecutorDeps,
  FieldMapping,
  NamedOperation,
  OutboundBudgets,
  PinnedDeps,
  RequestMapper,
  ServerSnapshot,
  SnapshotTool,
} from '../src/index.ts';

// The createExecutor is the integration point wiring request building + the
// pinned transport + response mapping + redaction + a global concurrency
// semaphore into a real ToolExecutor. `deps.transport` here is a FAKE
// PinnedDeps whose `fetch` never touches the network — the real
// pinnedRequest still runs (only its transport is faked), so this suite
// proves the real join/header-assembly/budget/redirect-trust wiring, not a
// reimplementation of it.

// A partial mock: `pinnedRequest` becomes a spy that still DELEGATES to the
// real implementation by default (every test's behaviour is unaffected), so
// a handful of tests can additionally assert the exact PinnedRequestOptions
// executor.ts handed it — proving baseTrusted / allowPrivateNetwork
// propagate exactly, not just "the call succeeded".
vi.mock(import('../src/http/pinned-dispatcher.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pinnedRequest: vi.fn<typeof actual.pinnedRequest>(actual.pinnedRequest) };
});

// A second partial mock, same pattern: `buildRequest` becomes a spy that
// DELEGATES to the real implementation by default. One test below overrides
// it once (`mockReturnValueOnce`) to prove the executor's OWN reserved-name
// re-check lowercases a built header name before comparing — the real
// buildRequest always lowercases its built header keys, so a mixed-case
// built name cannot occur through the real pipeline; this spy is what makes
// that otherwise-unconstructable input reachable for the test.
vi.mock(import('../src/server/execute/request.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildRequest: vi.fn<typeof actual.buildRequest>(actual.buildRequest) };
});

// Deliberately never reset between tests: every assertion below reads
// `.mock.calls.at(-1)`, which is always THIS test's own most recent call
// (vitest runs a file's tests sequentially) regardless of how many earlier
// tests also invoked the spy.
const budgets: OutboundBudgets = {
  maxUrlLength: 8192,
  maxHeaderBytes: 16_384,
  maxBodyBytes: 65_536,
};

const buildToolSnapshot = (
  ops: readonly NamedOperation[],
  defaultResponseIsError = false,
): ServerSnapshot => {
  const built = buildTools(ops, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    defaultResponseIsError,
  });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

const validatorsFor = (snapshot: ServerSnapshot): Map<string, EnvelopeValidator | undefined> => {
  const map = new Map<string, EnvelopeValidator | undefined>();
  for (const tool of snapshot.tools) {
    map.set(tool.name, compileEnvelopeValidator(tool.wireTool.outputSchema));
  }
  return map;
};

type NamedFieldMapping = Exclude<FieldMapping, { destination: 'body' }>;
const hasWireName = (mapping: FieldMapping): mapping is NamedFieldMapping =>
  mapping.destination !== 'body';

const fieldNameFor = (
  mapper: RequestMapper,
  destination: NamedFieldMapping['destination'],
  wireName: string,
): string => {
  const entry = Object.entries(mapper.fields).find(
    ([, mapping]) =>
      hasWireName(mapping) && mapping.destination === destination && mapping.wireName === wireName,
  );
  if (entry === undefined) {
    throw new Error(`no ${destination} field for wireName "${wireName}"`);
  }
  return entry[0];
};

// A GET tool with a required path param and a real {status,contentType,data}
// outputSchema (deriveOutputSchema turns its 200/application/json response
// into exactly that oneOf shape).
const idPathOp: NamedOperation = {
  toolName: 'getThing',
  operation: {
    method: 'get',
    path: '/things/{id}',
    tags: [],
    deprecated: false,
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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

// A no-param, no-outputSchema (204) GET — the plain-text/JSON success path.
const pingOp: NamedOperation = {
  toolName: 'pingThing',
  operation: {
    method: 'get',
    path: '/ping',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: { '204': { description: 'no content' } },
  },
};

// A POST with a flattened JSON body — exercises the content-type-when-a-body-
// is-sent branch of assembleHeaders.
const createThingOp: NamedOperation = {
  toolName: 'createThing',
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
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
    },
    responses: { '201': { description: 'created' } },
  },
};

// A header parameter buildTools KEEPS (it is not in SYSTEM_HEADERS), used to
// prove the executor's OWN defensive reserved-name re-check earns its keep
// independent of toolgen/layout.ts's build-time drop — simulating the
// hypothetical drift where an operator-configured reserved name reaches
// config.reservedHeaderNames without also being unioned into buildTools's
// reservedHeaders.
const forcedHeaderOp: NamedOperation = {
  toolName: 'forcedHeaderThing',
  operation: {
    method: 'get',
    path: '/forced',
    tags: [],
    deprecated: false,
    parameters: [{ name: 'X-Forced', in: 'header', required: true, schema: { type: 'string' } }],
    responses: { '204': { description: 'no content' } },
  },
};

// A deliberately malformed operation.path (no leading '/') — never produced
// by normalizeSpec in practice, but the final-URL segment-boundary check
// must fail closed even under a hypothetical upstream regression: joined
// against base path "/api" this produces "/api-evil/x", which must NOT be
// accepted as "under /api".
const evilPathOp: NamedOperation = {
  toolName: 'evilThing',
  operation: {
    method: 'get',
    path: '-evil/x',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: { '204': { description: 'no content' } },
  },
};

const baseConfig = (overrides: Partial<ExecutorConfig> = {}): ExecutorConfig => ({
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
  outboundBudgets: budgets,
  maxConcurrent: 16,
  validators: new Map(),
  ...overrides,
});

const jsonResponse = (status: number, data: unknown): Response => Response.json(data, { status });

const textResponse = (status: number, body: string, contentType = 'text/plain'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

// A resolver that must NEVER be called: the fake `fetch` below always
// short-circuits before undici's real Agent ever attempts a socket connect,
// so no real DNS lookup should ever happen in this whole suite.
const rejectingResolve: PinnedDeps['resolve'] = () =>
  Promise.reject(new Error('resolve must not be called — this suite never opens a real socket'));

const timeoutSignal = (_ms: number): AbortSignal => new AbortController().signal;
const freshSignal = (): AbortSignal => new AbortController().signal;

type FetchCall = {
  url: string;
  init: { headers?: Record<string, string>; signal?: AbortSignal | null; body?: unknown };
};

const recordingTransport = (
  handler: (call: FetchCall) => Response | Promise<Response>,
): { deps: ExecutorDeps; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetch: PinnedDeps['fetch'] = (input, init) => {
    const call: FetchCall = { url: String(input), init: (init ?? {}) as FetchCall['init'] };
    calls.push(call);
    if (call.init.signal?.aborted === true) {
      throw new Error('the request was aborted');
    }
    return Promise.resolve(handler(call));
  };
  return {
    deps: { transport: { fetch, resolve: rejectingResolve, timeoutSignal } },
    calls,
  };
};

describe('createExecutor — happy path', () => {
  it('maps a validated 200 JSON response to a structuredOutcome envelope', async () => {
    const snapshot = buildToolSnapshot([idPathOp]);
    const tool = snapshot.toolsByName['getThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => jsonResponse(200, { id: 42 }));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { id: '42' }, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 42 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/things/42');
  });
});

describe('createExecutor — header assembly', () => {
  it('injects static and secret headers into the same-origin request', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        staticHeaders: [{ name: 'X-Client', value: 'openapi-mcp' }],
        secretHeaders: [
          { name: 'Authorization', value: 'Bearer s3cr3t-token-value', envVar: 'API_TOKEN' },
        ],
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['x-client']).toBe('openapi-mcp');
    expect(headers['authorization']).toBe('Bearer s3cr3t-token-value');
  });

  it('includes content-type in the same-origin headers for a POST carrying a JSON body', async () => {
    const snapshot = buildToolSnapshot([createThingOp]);
    const tool = snapshot.toolsByName['createThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { name: 'widget' }, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]?.init.body).toBeDefined();
  });

  it('sends the declared JSON variant as Content-Type end to end (kaisers-io/openapi-mcp-archive#54: merge-patch+json)', async () => {
    const patchOp: NamedOperation = {
      toolName: 'patchThing',
      operation: {
        method: 'patch',
        path: '/things',
        tags: [],
        deprecated: false,
        parameters: [],
        requestBody: {
          content: {
            'application/merge-patch+json': {
              schema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    };
    const snapshot = buildToolSnapshot([patchOp]);
    const tool = snapshot.toolsByName['patchThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { name: 'widget' }, freshSignal());
    expect(outcome.isError).toBe(false);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['content-type']).toBe('application/merge-patch+json');
    const body = calls[0]?.init.body as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ name: 'widget' });
  });

  it('sends the bytes {} for a required body whose properties are all optional (kaisers-io/openapi-mcp-archive#40)', async () => {
    const noteOp: NamedOperation = {
      toolName: 'touchThing',
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
              schema: {
                type: 'object',
                properties: { note: { type: 'string' } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    };
    const snapshot = buildToolSnapshot([noteOp]);
    const tool = snapshot.toolsByName['touchThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(false);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(calls[0]?.init.body as Uint8Array)).toBe('{}');
  });

  it('sends decoded raw bytes for an application/octet-stream body (kaisers-io/openapi-mcp-archive#71)', async () => {
    const uploadOp: NamedOperation = {
      toolName: 'uploadFile',
      operation: {
        method: 'post',
        path: '/upload',
        tags: [],
        deprecated: false,
        parameters: [],
        requestBody: {
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: { '200': { description: 'ok' } },
      },
    };
    const snapshot = buildToolSnapshot([uploadOp]);
    const tool = snapshot.toolsByName['uploadFile'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { body: 'AAEC/w==' }, freshSignal());
    expect(outcome.isError).toBe(false);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['content-type']).toBe('application/octet-stream');
    const sent = calls[0]?.init.body as Uint8Array;
    expect([...sent]).toEqual([0, 1, 2, 255]);
  });

  it('sends a parseable multipart/form-data body with a generated boundary (kaisers-io/openapi-mcp-archive#71)', async () => {
    const formOp: NamedOperation = {
      toolName: 'uploadForm',
      operation: {
        method: 'post',
        path: '/upload',
        tags: [],
        deprecated: false,
        parameters: [],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    };
    const snapshot = buildToolSnapshot([formOp]);
    const tool = snapshot.toolsByName['uploadForm'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { file: 'aGk=', note: 'n' }, freshSignal());
    expect(outcome.isError).toBe(false);
    const headers = calls[0]?.init.headers ?? {};
    const contentType = headers['content-type'] ?? '';
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/u);
    const sent = calls[0]?.init.body as Uint8Array;
    const form = await new globalThis.Request('http://example.test/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: sent,
    }).formData();
    expect(form.get('note')).toBe('n');
    expect(await (form.get('file') as File).text()).toBe('hi');
  });

  it('rejects a tool argument whose header name collides with a reserved header (defensive re-check)', async () => {
    const snapshot = buildToolSnapshot([forcedHeaderOp]);
    const tool = snapshot.toolsByName['forcedHeaderThing'] as SnapshotTool;
    const fieldName = fieldNameFor(
      (tool.generated as NonNullable<SnapshotTool['generated']>).mapper,
      'header',
      'X-Forced',
    );
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        reservedHeaderNames: new Set([...SYSTEM_HEADERS, 'x-forced']),
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, { [fieldName]: 'value' }, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/reserved header/u);
    expect(calls).toHaveLength(0);
  });

  // The reserved-name check must lowercase the BUILT header name itself
  // before comparing against reservedHeaderNames — HTTP header names are
  // case-insensitive, and this is the mandatory auth-collision gate, so it
  // must not depend on the unstated upstream invariant that buildRequest
  // always lowercases its built keys. A mixed-case built header name cannot
  // occur through the real pipeline today (buildRequest always lowercases —
  // see request.ts's `headers[mapping.wireName.toLowerCase()] = ...`), so
  // this test injects one via a spy on buildRequest to reach the
  // otherwise-unconstructable input and prove the executor's OWN
  // `.toLowerCase()` closes the gate regardless of upstream casing.
  it('rejects a mixed-case built header colliding with a reserved name (self-contained lowercase compare)', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    vi.mocked(buildRequest).mockReturnValueOnce({
      ok: { pathname: '/ping', query: '', headers: { 'X-Forced': 'value' } },
    });
    const executor = createExecutor(
      baseConfig({
        reservedHeaderNames: new Set([...SYSTEM_HEADERS, 'x-forced']),
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/reserved header/u);
    expect(calls).toHaveLength(0);
  });

  // The assembleHeaders function writes content/tool-arg headers FIRST, then --header,
  // then --header-env LAST, so a same-name secret header always wins over a
  // static one, which always wins over a tool-argument one — the precedence is
  // content < tool < --header < --header-env. Unreachable
  // through the real pipeline (the reserved-name gate above always rejects
  // a tool-arg name colliding with an operator-configured header before
  // assembleHeaders ever runs), so this test reaches the fallback path the
  // same way the mixed-case test above does: a `buildRequest` spy injects a
  // built header name that the reservedHeaderNames set does NOT cover.
  it('secretHeaders win over staticHeaders, which win over a colliding tool-arg header (precedence fallback)', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    vi.mocked(buildRequest).mockReturnValueOnce({
      ok: { pathname: '/ping', query: '', headers: { 'x-dup': 'tool-value' } },
    });
    const executor = createExecutor(
      baseConfig({
        staticHeaders: [{ name: 'X-Dup', value: 'static-value' }],
        secretHeaders: [{ name: 'X-Dup', value: 'secret-value', envVar: 'API_TOKEN' }],
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers['x-dup']).toBe('secret-value');
  });
});

describe('createExecutor — cleartext gate', () => {
  const secretHeaders = [
    { name: 'Authorization', value: 'Bearer secret-value-1234567890', envVar: 'API_TOKEN' },
  ];

  it('refuses a secret header over a non-loopback http:// origin without --allow-insecure-http', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseUrl: 'http://api.example.test',
        secretHeaders,
        allowInsecureHttp: false,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/cleartext/u);
    expect(calls).toHaveLength(0);
  });

  it('proceeds over a non-loopback http:// origin when --allow-insecure-http is set', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseUrl: 'http://api.example.test',
        secretHeaders,
        allowInsecureHttp: true,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('proceeds over http://127.0.0.1 (loopback) without the flag', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseUrl: 'http://127.0.0.1',
        secretHeaders,
        allowInsecureHttp: false,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

const OVERLOADED_META = {
  'openapi-mcp/error': 'overloaded',
  'openapi-mcp/retryAfterMs': 1000,
};

describe('createExecutor — global concurrency queue', () => {
  const pingSetup = () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    return { snapshot, tool };
  };

  // A fake transport whose every response is held until the test releases
  // it, recording how many requests were in flight at once.
  const gatedTransport = () => {
    const gates: ((response: Response) => void)[] = [];
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const fetch: PinnedDeps['fetch'] = async () => {
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const { promise, resolve } = Promise.withResolvers<Response>();
      gates.push(resolve);
      const response = await promise;
      inFlight -= 1;
      return response;
    };
    return {
      fetch,
      peak: () => peak,
      started: () => started,
      releaseOne: () => gates.shift()?.(textResponse(200, '')),
    };
  };

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };

  it('queues an overlapping call once maxConcurrent is reached, and runs it when a slot frees', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, validators: validatorsFor(snapshot) }),
      { transport: { fetch: gated.fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    const first = executor(tool, {}, freshSignal());
    const second = executor(tool, {}, freshSignal());
    await flush();
    // The second call waits for the slot instead of failing fast.
    expect(gated.started()).toBe(1);
    gated.releaseOne();
    await expect(first).resolves.toMatchObject({ isError: false });
    await flush();
    expect(gated.started()).toBe(2);
    gated.releaseOne();
    await expect(second).resolves.toMatchObject({ isError: false });
  });

  it('runs 10 parallel calls with maxConcurrent 2: all succeed, never more than 2 in flight', async () => {
    const { snapshot, tool } = pingSetup();
    let inFlight = 0;
    let peak = 0;
    const fetch: PinnedDeps['fetch'] = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      inFlight -= 1;
      return textResponse(200, '');
    };
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 2, validators: validatorsFor(snapshot) }),
      { transport: { fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => executor(tool, {}, freshSignal())),
    );
    expect(outcomes.filter((outcome) => outcome.isError)).toEqual([]);
    expect(peak).toBe(2);
  });

  it('serves queued calls in FIFO order', async () => {
    const snapshot = buildToolSnapshot([idPathOp]);
    const tool = snapshot.toolsByName['getThing'] as SnapshotTool;
    const order: string[] = [];
    const gates: (() => void)[] = [];
    const fetch: PinnedDeps['fetch'] = async (input) => {
      order.push(String(input));
      const { promise, resolve } = Promise.withResolvers<void>();
      gates.push(resolve);
      await promise;
      return jsonResponse(200, { id: 1 });
    };
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, validators: validatorsFor(snapshot) }),
      { transport: { fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    const calls = ['a', 'b', 'c', 'd'].map((id) => executor(tool, { id }, freshSignal()));
    for (let index = 0; index < 4; index += 1) {
      await flush();
      gates.shift()?.();
    }
    await Promise.all(calls);
    expect(order.map((url) => url.slice(-1))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('removes an aborted queued call from the queue: the upstream is never called for it', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, validators: validatorsFor(snapshot) }),
      { transport: { fetch: gated.fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    const first = executor(tool, {}, freshSignal());
    const controller = new AbortController();
    const queued = executor(tool, {}, controller.signal);
    const third = executor(tool, {}, freshSignal());
    await flush();
    controller.abort();
    const queuedOutcome = await queued;
    expect(queuedOutcome.isError).toBe(true);
    expect(queuedOutcome.content[0]?.text).toMatch(/cancelled/u);
    gated.releaseOne();
    await first;
    await flush();
    gated.releaseOne();
    await expect(third).resolves.toMatchObject({ isError: false });
    // Only `first` and `third` ever reached the upstream.
    expect(gated.started()).toBe(2);
  });

  it('refuses a call once the queue is full, with an actionable retryAfterMs', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, maxQueued: 1, validators: validatorsFor(snapshot) }),
      { transport: { fetch: gated.fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    const first = executor(tool, {}, freshSignal());
    const queued = executor(tool, {}, freshSignal());
    const overflow = await executor(tool, {}, freshSignal());
    expect(overflow.isError).toBe(true);
    expect(overflow.content[0]?.text).toMatch(/already in flight or queued; retry after 1s/u);
    expect(overflow.structuredContent).toBeUndefined();
    expect(overflow.meta).toEqual(OVERLOADED_META);
    await flush();
    gated.releaseOne();
    await first;
    await flush();
    gated.releaseOne();
    await expect(queued).resolves.toMatchObject({ isError: false });
  });

  it('defaults the queue to 4 x maxConcurrent', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 2, validators: validatorsFor(snapshot) }),
      { transport: { fetch: gated.fetch, resolve: rejectingResolve, timeoutSignal } },
    );
    // 2 in flight + 8 queued are admitted; the 11th is refused.
    const admitted = Array.from({ length: 10 }, () => executor(tool, {}, freshSignal()));
    const refused = await executor(tool, {}, freshSignal());
    expect(refused.meta).toEqual(OVERLOADED_META);
    for (let index = 0; index < 10; index += 1) {
      await flush();
      gated.releaseOne();
    }
    const outcomes = await Promise.all(admitted);
    expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
  });

  it('bounds the wait by the call timeout: a call still queued at its deadline is refused', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const deadlines: AbortController[] = [];
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, validators: validatorsFor(snapshot) }),
      {
        transport: {
          fetch: gated.fetch,
          resolve: rejectingResolve,
          timeoutSignal: () => {
            const controller = new AbortController();
            deadlines.push(controller);
            return controller.signal;
          },
        },
      },
    );
    const first = executor(tool, {}, freshSignal());
    await flush();
    const deadlinesBeforeQueueing = deadlines.length;
    const queued = executor(tool, {}, freshSignal());
    await flush();
    // Exactly one extra deadline was started — for the WAIT, and only
    // because this call had to queue.
    expect(deadlines).toHaveLength(deadlinesBeforeQueueing + 1);
    deadlines.at(-1)?.abort();
    const outcome = await queued;
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/timed out waiting for a free upstream request slot/u);
    expect(outcome.meta).toEqual(OVERLOADED_META);
    gated.releaseOne();
    await expect(first).resolves.toMatchObject({ isError: false });
    expect(gated.started()).toBe(1);
  });

  it('charges the queue wait against one call budget: wait <= half, upstream gets the rest', async () => {
    const { snapshot, tool } = pingSetup();
    const gated = gatedTransport();
    const requested: number[] = [];
    let clock = 0;
    const executor = createExecutor(
      baseConfig({ maxConcurrent: 1, timeoutMs: 5000, validators: validatorsFor(snapshot) }),
      {
        transport: {
          fetch: gated.fetch,
          resolve: rejectingResolve,
          timeoutSignal: (ms) => {
            requested.push(ms);
            return new AbortController().signal;
          },
        },
        now: () => clock,
      },
    );
    const first = executor(tool, {}, freshSignal());
    await flush();
    // Uncontended: the upstream request gets the whole budget.
    expect(requested).toEqual([5000]);
    const queued = executor(tool, {}, freshSignal());
    await flush();
    // The wait itself is bounded by half the budget.
    expect(requested).toEqual([5000, 2500]);
    clock = 1200;
    gated.releaseOne();
    await expect(first).resolves.toMatchObject({ isError: false });
    await flush();
    // The queued call's upstream request gets only what is left (5000 - 1200),
    // so queue wait + upstream never exceed the configured timeout.
    expect(requested).toEqual([5000, 2500, 3800]);
    gated.releaseOne();
    await expect(queued).resolves.toMatchObject({ isError: false });
  });
});

describe('createExecutor — upstream connection reuse', () => {
  it('reuses pooled connections across calls and closes them on close()', async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    server.on('connection', (socket: Socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const snapshot = buildToolSnapshot([pingOp]);
      const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
      const executor = createExecutor(
        baseConfig({ baseUrl: `http://api.test:${port}`, validators: validatorsFor(snapshot) }),
        {
          transport: {
            fetch: undiciFetch,
            resolve: () => Promise.resolve(['127.0.0.1']),
            timeoutSignal: (ms) => AbortSignal.timeout(ms),
          },
        },
      );
      for (let index = 0; index < 50; index += 1) {
        const outcome = await executor(tool, {}, freshSignal());
        expect(outcome.isError).toBe(false);
      }
      // Before pooling, every call opened its own connection (50 here).
      expect(connections).toBeLessThanOrEqual(2);
      expect(sockets.size).toBeGreaterThan(0);
      await executor.close();
      const deadline = Date.now() + 2000;
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(sockets.size).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe('createExecutor — cancellation and redaction', () => {
  it('maps a pre-aborted client signal to a cancelled isError', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const controller = new AbortController();
    controller.abort();
    const outcome = await executor(tool, {}, controller.signal);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/cancelled/u);
  });

  it('redacts a configured secret echoed back in an upstream error body', async () => {
    const secret = 'sk-live-1234567890abcdef';
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => textResponse(500, `boom: ${secret} happened`));
    const executor = createExecutor(
      baseConfig({
        secretHeaders: [{ name: 'Authorization', value: secret, envVar: 'API_TOKEN' }],
        redactor: createRedactor([secret]),
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).not.toContain(secret);
  });

  // Issue kaisers-io/openapi-mcp-archive#58, end to end: the redactor is built
  // from the header VALUE exactly as serve.ts registers it (`Bearer <token>`),
  // the header really goes out, and the upstream echoes only the bare token.
  it('redacts the bare token of a `Bearer <token>` header echoed in an upstream error body', async () => {
    const token = 'example-token-not-a-secret';
    const headerValue = `Bearer ${token}`;
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() =>
      textResponse(500, `{"error":"invalid api key ${token}"}`),
    );
    const executor = createExecutor(
      baseConfig({
        secretHeaders: [{ name: 'Authorization', value: headerValue, envVar: 'API_TOKEN' }],
        redactor: createRedactor([headerValue]),
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(calls[0]?.init.headers?.['authorization']).toBe(headerValue);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toBe(
      'upstream request failed with status 500: {"error":"invalid api key [redacted]"}',
    );
  });
});

describe('createExecutor — fail-closed wiring', () => {
  it('maps a buildRequest value-shape error to isError instead of throwing', async () => {
    const snapshot = buildToolSnapshot([idPathOp]);
    const tool = snapshot.toolsByName['getThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => jsonResponse(200, { id: 1 }));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    // Missing the required "id" path value.
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  // The buildRequest function's own `{error}` strings embed a header/path/query param's
  // spec-derived `wireName` verbatim (request.ts's serializeHeaderValue,
  // e.g. an invalid-header-name message). finalizeOutcome (dispatch.ts) only
  // redacts SECRETS, never control/bidi characters, so a hostile spec field
  // named with an RLO (right-to-left override, U+202E) would otherwise
  // reach the client raw. Built via String.fromCodePoint per the
  // escape-sequence discipline — never pasted.
  it('sanitizes a spec-derived wireName containing an RLO out of the buildRequest error text', async () => {
    const rlo = String.fromCodePoint(0x20_2e);
    const hostileName = `x-hdr${rlo}evil`;
    const hostileOp: NamedOperation = {
      toolName: 'hostileThing',
      operation: {
        method: 'get',
        path: '/hostile',
        tags: [],
        deprecated: false,
        parameters: [
          { name: hostileName, in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'no content' } },
      },
    };
    const snapshot = buildToolSnapshot([hostileOp]);
    const tool = snapshot.toolsByName['hostileThing'] as SnapshotTool;
    const fieldName = fieldNameFor(
      (tool.generated as NonNullable<SnapshotTool['generated']>).mapper,
      'header',
      hostileName,
    );
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    const outcome = await executor(tool, { [fieldName]: 'value' }, freshSignal());
    expect(outcome.isError).toBe(true);
    const text = outcome.content[0]?.text ?? '';
    expect(text).not.toContain(rlo);
    expect(calls).toHaveLength(0);
  });

  it('rejects a final assembled request that exceeds the outbound header byte budget', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        staticHeaders: [{ name: 'X-Big', value: 'x'.repeat(200) }],
        outboundBudgets: { ...budgets, maxHeaderBytes: 32 },
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/budget/u);
    expect(calls).toHaveLength(0);
  });

  it('fails closed when config.validators has no entry for the tool (wiring bug)', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(baseConfig({ validators: new Map() }), deps);
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/validator/u);
    expect(calls).toHaveLength(0);
  });

  it('refuses a call whose lazily compiled validator fails, before sending anything (issue #8)', async () => {
    const snapshot = buildToolSnapshot([createThingOp]);
    const tool = snapshot.toolsByName['createThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(201, ''));
    const failures: string[] = [];
    const validators = lazyEnvelopeValidators(
      createEnvelopeCompiler(),
      new Map([['createThing', { type: 'object', oneOf: 'not-an-array' }]]),
      (toolName) => {
        failures.push(toolName);
      },
    );
    const executor = createExecutor(baseConfig({ validators }), deps);
    for (const _ of [1, 2]) {
      const outcome = await executor(tool, { name: 'x' }, freshSignal());
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0]?.text).toBe(
        "tool execution failed: this tool's output schema could not be compiled, so its response cannot be validated; the request was not sent",
      );
    }
    // The write was never sent, and the operator hears about the schema once
    expect(calls).toHaveLength(0);
    expect(failures).toEqual(['createThing']);
  });

  it('validates through a lazily compiled validator like an eager one (issue #8)', async () => {
    const snapshot = buildToolSnapshot([idPathOp]);
    const tool = snapshot.toolsByName['getThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => jsonResponse(200, { id: 'not-an-integer' }));
    const validators = lazyEnvelopeValidators(
      createEnvelopeCompiler(),
      new Map(snapshot.tools.map((entry) => [entry.name, entry.wireTool.outputSchema])),
    );
    const executor = createExecutor(baseConfig({ validators }), deps);
    const outcome = await executor(tool, { id: '1' }, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/did not match the tool's declared output schema/u);
  });

  it('defensively refuses a tool with no generated upstream operation', async () => {
    const metaTool: SnapshotTool = {
      kind: 'meta',
      name: 'meta',
      wireTool: { name: 'meta', description: '', inputSchema: {}, annotations: {} },
      inputSchema: z.object({}),
    };
    const { deps, calls } = recordingTransport(() => textResponse(200, 'unused'));
    const executor = createExecutor(
      baseConfig({ validators: new Map([['meta', undefined]]) }),
      deps,
    );
    const outcome = await executor(metaTool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a final URL that escapes the base path at a non-boundary (SEGMENT-BOUNDARY check)', async () => {
    const snapshot = buildToolSnapshot([evilPathOp]);
    const tool = snapshot.toolsByName['evilThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({ baseUrl: 'https://api.example.test/api', validators: validatorsFor(snapshot) }),
      deps,
    );
    const outcome = await executor(tool, {}, freshSignal());
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/escaped/u);
    expect(calls).toHaveLength(0);
  });
});

describe('createExecutor — trust propagation into pinnedRequest', () => {
  it('propagates baseTrusted:true for a trusted --base-url override', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseTrusted: true,
        allowPrivateNetwork: false,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    await executor(tool, {}, freshSignal());
    const opts = vi.mocked(pinnedRequest).mock.calls.at(-1)?.[1];
    expect(opts?.baseTrusted).toBe(true);
    expect(opts?.allowPrivateNetwork).toBe(false);
  });

  it('propagates baseTrusted:false for an untrusted spec base', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseTrusted: false,
        allowPrivateNetwork: false,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    await executor(tool, {}, freshSignal());
    const opts = vi.mocked(pinnedRequest).mock.calls.at(-1)?.[1];
    expect(opts?.baseTrusted).toBe(false);
    expect(opts?.allowPrivateNetwork).toBe(false);
  });

  it('propagates allowPrivateNetwork:true when --allow-private-network is on', async () => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({
        baseTrusted: false,
        allowPrivateNetwork: true,
        validators: validatorsFor(snapshot),
      }),
      deps,
    );
    await executor(tool, {}, freshSignal());
    const opts = vi.mocked(pinnedRequest).mock.calls.at(-1)?.[1];
    expect(opts?.baseTrusted).toBe(false);
    expect(opts?.allowPrivateNetwork).toBe(true);
  });
});

describe('createExecutor — Accept derived from the declared response media types', () => {
  const negotiatedOp: NamedOperation = {
    toolName: 'getReport',
    operation: {
      method: 'get',
      path: '/report',
      tags: [],
      deprecated: false,
      parameters: [{ name: 'Accept', in: 'header', required: false, schema: { type: 'string' } }],
      responses: {
        '200': {
          content: {
            'application/xml': { schema: { type: 'string' } },
            'application/json; charset=utf-8': { schema: { type: 'object' } },
          },
        },
        '404': { content: { 'application/problem+json': { schema: { type: 'object' } } } },
      },
    },
  };

  const acceptSent = async (
    op: NamedOperation,
    overrides: Partial<ExecutorConfig> = {},
    args: Record<string, unknown> = {},
  ): Promise<string | undefined> => {
    const snapshot = buildToolSnapshot([op]);
    const tool = snapshot.toolsByName[op.toolName] as SnapshotTool;
    const { deps, calls } = recordingTransport(() => textResponse(200, ''));
    const executor = createExecutor(
      baseConfig({ validators: validatorsFor(snapshot), ...overrides }),
      deps,
    );
    await executor(tool, args, freshSignal());
    return calls[0]?.init.headers?.['accept'];
  };

  it('asks for the declared JSON type first and other declared types at a lower weight', async () => {
    expect(await acceptSent(negotiatedOp)).toBe(
      'application/json, application/xml;q=0.9, */*;q=0.1',
    );
  });

  it('asks for the declared JSON type of a plain JSON operation', async () => {
    expect(await acceptSent(idPathOp, {}, { id: '1' })).toBe('application/json, */*;q=0.1');
  });

  it('falls back to JSON-first for an operation that declares no success media type', async () => {
    expect(await acceptSent(pingOp)).toBe('application/json, */*;q=0.1');
  });

  it('lets an operator --header Accept override the derived value', async () => {
    expect(
      await acceptSent(negotiatedOp, {
        staticHeaders: [{ name: 'Accept', value: 'application/vnd.example+json' }],
      }),
    ).toBe('application/vnd.example+json');
  });

  it("drops a spec 'Accept' header parameter from the tool input (OAS: it SHALL be ignored)", async () => {
    const snapshot = buildToolSnapshot([negotiatedOp]);
    const tool = snapshot.toolsByName['getReport'] as SnapshotTool;
    const { properties } = tool.wireTool.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(properties ?? {}).map((key) => key.toLowerCase())).not.toContain('accept');
    // An extra argument named like the header is not mapped onto the wire.
    expect(await acceptSent(negotiatedOp, {}, { Accept: 'text/html' })).toBe(
      'application/json, application/xml;q=0.9, */*;q=0.1',
    );
  });
});

describe('createExecutor — forwarded upstream response headers', () => {
  const SECRET = 'example-token-not-a-secret-123';
  const run = async (
    op: NamedOperation,
    response: () => Response,
    args: Record<string, unknown> = {},
  ) => {
    const snapshot = buildToolSnapshot([op]);
    const tool = snapshot.toolsByName[op.toolName] as SnapshotTool;
    const { deps } = recordingTransport(response);
    const executor = createExecutor(
      baseConfig({
        validators: validatorsFor(snapshot),
        redactor: createRedactor([SECRET]),
      }),
      deps,
    );
    return { outcome: await executor(tool, args, freshSignal()), tool };
  };

  const pagedHeaders = {
    'content-type': 'application/json',
    link: '<https://api.example.test/things/1?page=2>; rel="next"',
    'x-total-count': '42',
    etag: '"v1"',
    'x-ratelimit-remaining': '9',
    'set-cookie': `session=${SECRET}`,
    'x-request-id': 'not-forwarded',
  };

  it('puts allowlisted headers in the structured envelope, which still validates', async () => {
    const { outcome, tool } = await run(
      idPathOp,
      () => new Response('{"id":1}', { status: 200, headers: pagedHeaders }),
      { id: '1' },
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 1 },
      headers: { 'x-total-count': '42', etag: '"v1"', 'x-ratelimit-remaining': '9' },
    });
    const validate = compileEnvelopeValidator(tool.wireTool.outputSchema);
    expect(validate?.(outcome.structuredContent)).toBe(true);
    // The raw Link URL never reaches the model; Set-Cookie never at all.
    expect(JSON.stringify(outcome)).not.toContain('page=2');
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain('not-forwarded');
  });

  it('leaves the envelope unchanged when the upstream sends none of them', async () => {
    const { outcome } = await run(idPathOp, () => jsonResponse(200, { id: 1 }), { id: '1' });
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 1 },
    });
  });

  it('adds a trailing headers block to a text result', async () => {
    const { outcome } = await run(
      pingOp,
      () =>
        new Response('pong', {
          status: 200,
          headers: { ...pagedHeaders, 'content-type': 'text/plain' },
        }),
    );
    expect(outcome.content.map((block) => block.text)).toEqual([
      'pong',
      'headers:\netag: "v1"\nx-ratelimit-remaining: 9\nx-total-count: 42',
    ]);
  });

  it('drops a header whose value carries a registered secret, keeping the rest', async () => {
    const { outcome } = await run(
      pingOp,
      () =>
        new Response('pong', {
          status: 200,
          headers: { 'content-type': 'text/plain', etag: `"${SECRET}"`, 'x-total-count': '1' },
        }),
    );
    expect(outcome.content.at(-1)?.text).toBe('headers:\nx-total-count: 1');
  });

  it('drops a header whose NAME carries a registered secret, in a structured result too', async () => {
    const { outcome, tool } = await run(
      idPathOp,
      () =>
        new Response('{"id":1}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            [`x-ratelimit-${SECRET}`]: '1',
            'x-total-count': '1',
          },
        }),
      { id: '1' },
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 1 },
      headers: { 'x-total-count': '1' },
    });
    expect(compileEnvelopeValidator(tool.wireTool.outputSchema)?.(outcome.structuredContent)).toBe(
      true,
    );
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('forwards a same-origin Location as a path, and drops a foreign one', async () => {
    const created = await run(
      createThingOp,
      () =>
        new Response(null, {
          status: 201,
          headers: { location: 'https://api.example.test/things/7?x=1' },
        }),
      { name: 'x' },
    );
    expect(created.outcome.content.at(-1)?.text).toBe('headers:\nlocation: /things/7?x=1');
    const relative = await run(
      createThingOp,
      () => new Response(null, { status: 201, headers: { location: 'things/8' } }),
      { name: 'x' },
    );
    expect(relative.outcome.content.at(-1)?.text).toBe('headers:\nlocation: /things/8');
    const foreign = await run(
      createThingOp,
      () =>
        new Response(null, { status: 201, headers: { location: 'https://evil.example/steal' } }),
      { name: 'x' },
    );
    expect(JSON.stringify(foreign.outcome)).not.toContain('evil.example');
    expect(foreign.outcome.content).toHaveLength(1);
  });

  it('reports upstreamRetryAfterMs for a 429 with Retry-After seconds', async () => {
    const { outcome } = await run(
      pingOp,
      () =>
        new Response('slow down', {
          status: 429,
          headers: { 'content-type': 'text/plain', 'retry-after': '3' },
        }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.meta).toEqual({ 'openapi-mcp/upstreamRetryAfterMs': 3000 });
    expect(outcome.content.at(-1)?.text).toBe('headers:\nretry-after: 3');
  });

  it('parses an HTTP-date Retry-After on a 503', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const { outcome } = await run(
      pingOp,
      () => new Response('', { status: 503, headers: { 'retry-after': at } }),
    );
    const retry = outcome.meta?.['openapi-mcp/upstreamRetryAfterMs'] as number;
    expect(retry).toBeGreaterThan(55_000);
    expect(retry).toBeLessThanOrEqual(60_000);
  });

  it('does not report upstreamRetryAfterMs on a success', async () => {
    const { outcome } = await run(
      pingOp,
      () => new Response('', { status: 200, headers: { 'retry-after': '3' } }),
    );
    expect(outcome.meta).toBeUndefined();
  });
});

describe('createExecutor — pagination hints', () => {
  const SECRET = 'example-token-not-a-secret-456';
  const listReposOp: NamedOperation = {
    toolName: 'listRepos',
    operation: {
      method: 'get',
      path: '/orgs/{org}/repos',
      tags: [],
      deprecated: false,
      parameters: [
        { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
        { name: 'per_page', in: 'query', schema: { type: 'integer' } },
        { name: 'sort', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'ok',
          headers: { Link: { schema: { type: 'string' } } },
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'integer' } } },
              },
            },
          },
        },
      },
    },
  };
  const cursorOp: NamedOperation = {
    toolName: 'listEvents',
    operation: {
      method: 'get',
      path: '/events',
      tags: [],
      deprecated: false,
      parameters: [
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { items: { type: 'array' }, next_cursor: { type: ['string', 'null'] } },
              },
            },
          },
        },
      },
    },
  };
  const stripeOp: NamedOperation = {
    toolName: 'listCharges',
    operation: {
      method: 'get',
      path: '/v1/charges',
      tags: [],
      deprecated: false,
      parameters: [
        { name: 'starting_after', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { has_more: { type: 'boolean' }, data: { type: 'array' } },
              },
            },
          },
        },
      },
    },
  };

  const call = async (
    op: NamedOperation,
    response: () => Response,
    args: Record<string, unknown>,
  ) => {
    const snapshot = buildToolSnapshot([op]);
    const tool = snapshot.toolsByName[op.toolName] as SnapshotTool;
    const { deps, calls } = recordingTransport(response);
    const executor = createExecutor(
      baseConfig({ validators: validatorsFor(snapshot), redactor: createRedactor([SECRET]) }),
      deps,
    );
    const outcome = await executor(tool, args, freshSignal());
    const validate = compileEnvelopeValidator(tool.wireTool.outputSchema);
    return { outcome, tool, calls, valid: validate?.(outcome.structuredContent) };
  };

  const page =
    (link: string | undefined, body: unknown = [{ id: 1 }, { id: 2 }]) =>
    () =>
      Response.json(body, { status: 200, headers: link === undefined ? {} : { link } });

  const nextOf = (outcome: { structuredContent?: Record<string, unknown> }) =>
    (outcome.structuredContent?.['pagination'] as { next: unknown } | undefined)?.next;

  it('maps Link rel="next" onto the tool arguments, typed per field, and the envelope validates', async () => {
    const { outcome, valid, calls } = await call(
      listReposOp,
      page(
        '<https://api.example.test/orgs/acme/repos?page=2&per_page=2>; rel="next", ' +
          '<https://api.example.test/orgs/acme/repos?page=3&per_page=2>; rel="last"',
      ),
      { org: 'acme', per_page: 2 },
    );
    expect(calls[0]?.url).toBe('https://api.example.test/orgs/acme/repos?per_page=2');
    expect(outcome.isError).toBe(false);
    expect(nextOf(outcome)).toEqual({ org: 'acme', page: 2, per_page: 2 });
    expect(valid).toBe(true);
    // No raw URL reaches the result.
    expect(JSON.stringify(outcome)).not.toContain('https://api.example.test/orgs');
  });

  it.each([
    ['another origin', '<https://evil.example/orgs/acme/repos?page=2>; rel="next"'],
    ['another path', '<https://api.example.test/orgs/other/repos?page=2>; rel="next"'],
    [
      'an unmapped parameter',
      '<https://api.example.test/orgs/acme/repos?page=2&token=x>; rel="next"',
    ],
    [
      'a non-numeric value for an integer field',
      '<https://api.example.test/orgs/acme/repos?page=two>; rel="next"',
    ],
    [
      'a repeated parameter',
      '<https://api.example.test/orgs/acme/repos?page=2&page=3>; rel="next"',
    ],
    ['no rel=next (last page)', '<https://api.example.test/orgs/acme/repos?page=1>; rel="prev"'],
    ['a malformed Link header', 'https://api.example.test/orgs/acme/repos?page=2; rel=next'],
  ])('yields next: null for %s', async (_label, link) => {
    const { outcome, valid } = await call(listReposOp, page(link), { org: 'acme' });
    expect(outcome.isError).toBe(false);
    expect(nextOf(outcome)).toBeNull();
    expect(valid).toBe(true);
  });

  it('resolves a relative next link against the response URL', async () => {
    const { outcome } = await call(listReposOp, page('</orgs/acme/repos?page=2>; rel="next"'), {
      org: 'acme',
    });
    expect(nextOf(outcome)).toEqual({ org: 'acme', page: 2 });
  });

  it('withholds a hint that would carry a registered secret into the next call', async () => {
    const { outcome } = await call(
      listReposOp,
      page(`<https://api.example.test/orgs/acme/repos?sort=${SECRET}>; rel="next"`),
      { org: 'acme' },
    );
    expect(nextOf(outcome)).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('maps a body cursor (next_cursor -> cursor), keeping the other arguments', async () => {
    const { outcome, valid } = await call(
      cursorOp,
      page(undefined, { items: [], next_cursor: 'c-2' }),
      { limit: 10 },
    );
    expect(nextOf(outcome)).toEqual({ limit: 10, cursor: 'c-2' });
    expect(valid).toBe(true);
    const last = await call(cursorOp, page(undefined, { items: [], next_cursor: null }), {});
    expect(nextOf(last.outcome)).toBeNull();
  });

  const issuesOp = (explodeLabels: boolean): NamedOperation => ({
    toolName: 'listIssues',
    operation: {
      method: 'get',
      path: '/issues',
      tags: [],
      deprecated: false,
      parameters: [
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
        { name: 'archived', in: 'query', schema: { type: 'boolean' } },
        {
          name: 'labels',
          in: 'query',
          style: 'form',
          explode: explodeLabels,
          schema: { type: 'array', items: { type: 'string' } },
        },
      ],
      responses: {
        '200': {
          description: 'ok',
          headers: { Link: { schema: { type: 'string' } } },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { items: { type: 'array' }, next_cursor: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  });
  const acceptedAsInput = (tool: SnapshotTool, next: unknown): boolean | undefined =>
    tool.generated?.inputSchema.safeParse(next).success;

  it('keeps carried boolean/array arguments in a body-cursor hint, and the 200 stays valid', async () => {
    const { outcome, valid, tool } = await call(
      issuesOp(false),
      page(undefined, { items: [], next_cursor: 'c2' }),
      { archived: true, labels: ['a', 'b'] },
    );
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({ archived: true, labels: ['a', 'b'], cursor: 'c2' });
    expect(acceptedAsInput(tool, next)).toBe(true);
  });

  it.each([
    [false, '<https://api.example.test/issues?page=2&archived=true&labels=a,b>; rel="next"'],
    [true, '<https://api.example.test/issues?page=2&archived=true&labels=a&labels=b>; rel="next"'],
  ])(
    'decodes Link values per declared type and style (labels explode=%s), round-tripping the input schema',
    async (explode, link) => {
      const { outcome, valid, tool } = await call(issuesOp(explode), page(link, {}), {
        archived: true,
        labels: ['a', 'b'],
      });
      expect(outcome.isError).toBe(false);
      expect(valid).toBe(true);
      const next = nextOf(outcome);
      expect(next).toEqual({ page: 2, archived: true, labels: ['a', 'b'] });
      expect(acceptedAsInput(tool, next)).toBe(true);
    },
  );

  // PR kaisers-io/openapi-mcp-archive#108's styles
  // (kaisers-io/openapi-mcp-archive#145): a delimited array's value is split on
  // its own delimiter; a deepObject field (JSON:API `page[number]`,
  // `filter[x]`) is reassembled from its `name[key]` parameters, declared keys
  // only.
  const withLabels = (style: string): NamedOperation => {
    const op = issuesOp(false);
    return {
      ...op,
      operation: {
        ...op.operation,
        parameters: [
          ...op.operation.parameters.filter((param) => param['name'] !== 'labels'),
          {
            name: 'labels',
            in: 'query',
            style,
            explode: false,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
      },
    };
  };
  const issuesLink = (query: string) =>
    page(`<https://api.example.test/issues?page=2&${query}>; rel="next"`, {});

  it.each([
    ['pipeDelimited', 'labels=a|b'],
    ['pipeDelimited', 'labels=a%7Cb'],
    ['spaceDelimited', 'labels=a%20b'],
    ['spaceDelimited', 'labels=a+b'],
  ])('decodes a %s array (%s), round-tripping the input schema', async (style, query) => {
    const { outcome, valid, tool, calls } = await call(withLabels(style), issuesLink(query), {
      labels: ['a', 'b'],
    });
    expect(calls[0]?.url).toContain(style === 'pipeDelimited' ? 'labels=a%7Cb' : 'labels=a%20b');
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({ page: 2, labels: ['a', 'b'] });
    expect(acceptedAsInput(tool, next)).toBe(true);
  });

  it('splits a delimited array only on its own delimiter', async () => {
    const { outcome } = await call(withLabels('pipeDelimited'), issuesLink('labels=a,b'), {});
    expect(nextOf(outcome)).toEqual({ page: 2, labels: ['a,b'] });
  });

  it.each([
    ['an empty item', 'labels=a||b'],
    ['a repeated key', 'labels=a|b&labels=c'],
  ])('yields next: null for a pipe-delimited array with %s', async (_label, query) => {
    const { outcome, valid } = await call(withLabels('pipeDelimited'), issuesLink(query), {});
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  // A JSON:API collection: `page` and `filter` are deepObject parameters
  // (https://jsonapi.org/format/#fetching-pagination), plus a form `sort`.
  const jsonApiParams: Record<string, unknown>[] = [
    {
      name: 'page',
      in: 'query',
      style: 'deepObject',
      explode: true,
      schema: {
        type: 'object',
        properties: { number: { type: 'integer' }, size: { type: 'integer' } },
      },
    },
    {
      name: 'filter',
      in: 'query',
      style: 'deepObject',
      explode: true,
      schema: {
        type: 'object',
        properties: { status: { type: 'string' }, featured: { type: 'boolean' } },
      },
    },
    { name: 'sort', in: 'query', schema: { type: 'string' } },
  ];
  const jsonApiOp = (parameters: Record<string, unknown>[] = jsonApiParams): NamedOperation => ({
    toolName: 'listArticles',
    operation: {
      method: 'get',
      path: '/articles',
      tags: [],
      deprecated: false,
      parameters,
      responses: {
        '200': {
          description: 'ok',
          headers: { Link: { schema: { type: 'string' } } },
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  });
  const articles = (query: string) =>
    page(`<https://api.example.test/articles?${query}>; rel="next"`, { data: [] });

  it('maps JSON:API page[number]/page[size] and filter[x] back onto deepObject fields', async () => {
    const { outcome, valid, tool, calls } = await call(
      jsonApiOp(),
      articles(
        'page%5Bnumber%5D=2&page%5Bsize%5D=10&filter[status]=published&filter[featured]=true&sort=-created',
      ),
      { page: { size: 10 }, filter: { status: 'published', featured: true }, sort: '-created' },
    );
    expect(calls[0]?.url).toBe(
      'https://api.example.test/articles?page%5Bsize%5D=10&filter%5Bstatus%5D=published&filter%5Bfeatured%5D=true&sort=-created',
    );
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({
      page: { number: 2, size: 10 },
      filter: { status: 'published', featured: true },
      sort: '-created',
    });
    expect(acceptedAsInput(tool, next)).toBe(true);
  });

  it.each([
    ['a key the deepObject schema does not declare', 'page[number]=2&page[cursor]=x'],
    ['a nested bracket key', 'page[number]=2&filter[author][name]=x'],
    ['an empty bracket key', 'page[]=2'],
    ['a repeated deepObject key', 'page[number]=2&page[number]=3'],
    ['the bare deepObject name', 'page=2'],
    ['a bracket key on a form field', 'page[number]=2&sort[by]=x'],
    ['a value that does not decode to the property type', 'page[number]=two'],
    ['a bracket key on an undeclared parameter', 'page[number]=2&fields[articles]=title'],
    ['an inherited property name as key', 'page[number]=2&page[__proto__]=1'],
    ['an inherited property name as parameter', 'page[number]=2&constructor=x'],
    ['an inherited property name as deepObject owner', 'page[number]=2&toString[a]=x'],
  ])('yields next: null for %s', async (_label, query) => {
    const { outcome, valid } = await call(jsonApiOp(), articles(query), {});
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  it('yields next: null when a bracket name is both a form parameter and a deepObject key', async () => {
    // `page[number]` is declared literally as a form parameter AND is
    // `page.number` of the deepObject: the link cannot say which one it means.
    const op = jsonApiOp([
      ...jsonApiParams,
      { name: 'page[number]', in: 'query', schema: { type: 'integer' } },
    ]);
    const { outcome, valid } = await call(op, articles('page[number]=2'), {});
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  it('still maps a literal bracket-named form parameter when no deepObject claims it', async () => {
    const op = jsonApiOp([
      { name: 'page[number]', in: 'query', schema: { type: 'integer' } },
      { name: 'page[size]', in: 'query', schema: { type: 'integer' } },
    ]);
    const { outcome, valid, tool } = await call(op, articles('page[number]=2&page[size]=5'), {});
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({ 'page[number]': 2, 'page[size]': 5 });
    expect(acceptedAsInput(tool, next)).toBe(true);
  });

  // JSON:API puts pagination links in the BODY, in the top-level `links`
  // object (https://jsonapi.org/format/#fetching-pagination), not in a Link
  // header. A realistic `application/vnd.api+json` collection document.
  const JSON_API = 'application/vnd.api+json';
  const jsonApiDocOp = (
    pageProperties: Record<string, unknown>,
    mediaType = JSON_API,
    schema?: Record<string, unknown>,
  ): NamedOperation => ({
    toolName: 'listArticles',
    operation: {
      method: 'get',
      path: '/articles',
      tags: [],
      deprecated: false,
      parameters: [
        {
          name: 'page',
          in: 'query',
          style: 'deepObject',
          explode: true,
          schema: { type: 'object', properties: pageProperties },
        },
        jsonApiParams[1] as Record<string, unknown>,
        { name: 'sort', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'ok',
          content: { [mediaType]: { schema: schema ?? { type: 'object' } } },
        },
      },
    },
  });
  const numbered = { number: { type: 'integer' }, size: { type: 'integer' } };
  const cursored = { after: { type: 'string' }, size: { type: 'integer' } };
  const jsonApiDoc =
    (links: Record<string, unknown> | undefined, link?: string, mediaType = JSON_API) =>
    () =>
      Response.json(
        {
          data: [
            { type: 'articles', id: '1', attributes: { title: 'JSON:API paints my bikeshed!' } },
            { type: 'articles', id: '2', attributes: { title: 'Rails is Omakase' } },
          ],
          ...(links === undefined ? {} : { links }),
          meta: { totalPages: 13 },
        },
        {
          status: 200,
          headers: { 'content-type': mediaType, ...(link === undefined ? {} : { link }) },
        },
      );
  const BASE = 'https://api.example.test/articles';

  it('maps a JSON:API body links.next (page[number]/page[size] + filter[x]) onto the arguments', async () => {
    const { outcome, valid, tool } = await call(
      jsonApiDocOp(numbered),
      jsonApiDoc({
        self: `${BASE}?page%5Bnumber%5D=2&page%5Bsize%5D=2&filter%5Bstatus%5D=published`,
        first: `${BASE}?page%5Bnumber%5D=1&page%5Bsize%5D=2&filter%5Bstatus%5D=published`,
        prev: `${BASE}?page%5Bnumber%5D=1&page%5Bsize%5D=2&filter%5Bstatus%5D=published`,
        next: `${BASE}?page%5Bnumber%5D=3&page%5Bsize%5D=2&filter%5Bstatus%5D=published`,
        last: `${BASE}?page%5Bnumber%5D=13&page%5Bsize%5D=2&filter%5Bstatus%5D=published`,
      }),
      { page: { number: 2, size: 2 }, filter: { status: 'published' } },
    );
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({ page: { number: 3, size: 2 }, filter: { status: 'published' } });
    expect(acceptedAsInput(tool, next)).toBe(true);
    // Still arguments, never the URL.
    expect(JSON.stringify(outcome.structuredContent?.['pagination'])).not.toContain('https://');
  });

  it('maps a JSON:API cursor links.next (page[after]), resolving a relative link', async () => {
    const { outcome, valid, tool } = await call(
      jsonApiDocOp(cursored),
      jsonApiDoc({ next: '/articles?page[size]=2&page[after]=eyJpZCI6Mn0' }),
      { page: { size: 2 } },
    );
    expect(valid).toBe(true);
    const next = nextOf(outcome);
    expect(next).toEqual({ page: { size: 2, after: 'eyJpZCI6Mn0' } });
    expect(acceptedAsInput(tool, next)).toBe(true);
  });

  it('reads a JSON:API 1.1 link object (links.next.href)', async () => {
    const { outcome, valid } = await call(
      jsonApiDocOp(numbered),
      jsonApiDoc({ next: { href: `${BASE}?page[number]=3`, meta: { count: 2 } } }),
      {},
    );
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toEqual({ page: { number: 3 } });
  });

  it('reads links.next from an application/json response whose schema declares it', async () => {
    const schema = {
      type: 'object',
      properties: {
        data: { type: 'array' },
        links: { type: 'object', properties: { next: { type: ['string', 'null'] } } },
      },
    };
    const { outcome, valid } = await call(
      jsonApiDocOp(numbered, 'application/json', schema),
      jsonApiDoc({ next: `${BASE}?page[number]=2` }, undefined, 'application/json'),
      {},
    );
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toEqual({ page: { number: 2 } });
  });

  it('never reads links.next where the response is not declared JSON:API-shaped', async () => {
    const { outcome } = await call(
      jsonApiDocOp(numbered, 'application/json'),
      jsonApiDoc({ next: `${BASE}?page[number]=2` }, undefined, 'application/json'),
      {},
    );
    expect(nextOf(outcome)).toBeNull();
  });

  it('prefers the Link header over the body links.next', async () => {
    const { outcome } = await call(
      jsonApiDocOp(numbered),
      jsonApiDoc({ next: `${BASE}?page[number]=3` }, `<${BASE}?page[number]=5>; rel="next"`),
      {},
    );
    expect(nextOf(outcome)).toEqual({ page: { number: 5 } });
  });

  it.each([
    ['only a non-pagination rel', '<https://api.example.test/docs>; rel="describedby"'],
    ['a deprecation notice', '<https://api.example.test/sunset>; rel="deprecation"'],
    ['an unparsable value', 'not a link header'],
  ])('reads the body links.next when the Link header has %s', async (_label, link) => {
    const { outcome } = await call(
      jsonApiDocOp(numbered),
      jsonApiDoc({ next: `${BASE}?page[number]=3` }, link),
      {},
    );
    expect(nextOf(outcome)).toEqual({ page: { number: 3 } });
  });

  it('keeps a pagination Link header final even without rel=next (last page)', async () => {
    const { outcome } = await call(
      jsonApiDocOp(numbered),
      jsonApiDoc({ next: `${BASE}?page[number]=3` }, `<${BASE}?page[number]=1>; rel="prev"`),
      {},
    );
    expect(nextOf(outcome)).toBeNull();
  });

  it.each([
    ['links.next null (last page)', { self: `${BASE}?page[number]=13`, next: null }],
    ['no links.next', { self: `${BASE}?page[number]=13` }],
    ['no links object', undefined],
    ['a non-string links.next', { next: 3 }],
    ['a link object without href', { next: { meta: { count: 3 } } }],
    ['another origin', { next: 'https://evil.example/articles?page[number]=3' }],
    ['another path', { next: 'https://api.example.test/admin?page[number]=3' }],
    ['an unmapped parameter', { next: `${BASE}?page[number]=3&token=x` }],
    ['an undeclared page key', { next: `${BASE}?page[number]=3&page[cursor]=x` }],
    ['a nested bracket key', { next: `${BASE}?page[number]=3&filter[author][name]=x` }],
    ['an unparsable URL', { next: 'http://[::1' }],
  ])('yields next: null for a JSON:API body with %s', async (_label, links) => {
    const { outcome, valid } = await call(jsonApiDocOp(numbered), jsonApiDoc(links), {});
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  // JSON:API precedence belongs to the response actually returned, not to
  // the operation: an ordinary JSON 200 next to a JSON:API 206 keeps its
  // body cursor (review of kaisers-io/openapi-mcp-archive#149).
  const mixedOp: NamedOperation = {
    toolName: 'listThings',
    operation: {
      method: 'get',
      path: '/things',
      tags: [],
      deprecated: false,
      parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  next_cursor: { type: 'string' },
                  links: { type: 'object', properties: { self: { type: 'string' } } },
                },
              },
            },
          },
        },
        '206': {
          description: 'partial',
          content: { [JSON_API]: { schema: { type: 'object' } } },
        },
      },
    },
  };
  const mixedBody = {
    next_cursor: 'page-two',
    links: { self: 'https://api.example.test/things?cursor=page-one' },
  };
  const mixedPage = (status: number, mediaType: string) => () =>
    Response.json(mixedBody, { status, headers: { 'content-type': mediaType } });

  it('keeps the body cursor of a plain JSON 200 when only another response is JSON:API', async () => {
    const { outcome, valid } = await call(mixedOp, mixedPage(200, 'application/json'), {
      cursor: 'page-one',
    });
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toEqual({ cursor: 'page-two' });
  });

  it('treats the links object of an actual JSON:API response as final (no next -> null)', async () => {
    const { outcome, valid } = await call(mixedOp, mixedPage(206, JSON_API), {
      cursor: 'page-one',
    });
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  it.each([
    ['a non-boolean value for a boolean field', 'archived=maybe'],
    ['a repeated key for an explode=false array', 'labels=a&labels=b'],
  ])('yields next: null for %s', async (_label, query) => {
    const { outcome, valid } = await call(
      issuesOp(false),
      page(`<https://api.example.test/issues?page=2&${query}>; rel="next"`, {}),
      {},
    );
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  it('yields next: null for a hint the tool input schema would reject (enum)', async () => {
    const enumOp: NamedOperation = {
      ...listReposOp,
      operation: {
        ...listReposOp.operation,
        parameters: listReposOp.operation.parameters.map((param) =>
          param['name'] === 'sort'
            ? { ...param, schema: { type: 'string', enum: ['created'] } }
            : param,
        ),
      },
    };
    const link = '<https://api.example.test/orgs/acme/repos?page=2&sort=pushed>; rel="next"';
    const { outcome, valid } = await call(enumOp, page(link), { org: 'acme' });
    expect(outcome.isError).toBe(false);
    expect(valid).toBe(true);
    expect(nextOf(outcome)).toBeNull();
  });

  it('maps Stripe-style has_more + last id to starting_after', async () => {
    const more = await call(
      stripeOp,
      page(undefined, { has_more: true, data: [{ id: 'ch_1' }, { id: 'ch_2' }] }),
      { limit: 2 },
    );
    expect(nextOf(more.outcome)).toEqual({ limit: 2, starting_after: 'ch_2' });
    const done = await call(stripeOp, page(undefined, { has_more: false, data: [] }), {});
    expect(nextOf(done.outcome)).toBeNull();
  });

  it('leaves a non-paginated tool byte-identical: no pagination key, none in its schema', async () => {
    const { outcome, tool } = await call(
      idPathOp,
      page('<https://api.example.test/things/1?page=2>; rel="next"', { id: 1 }),
      { id: '1' },
    );
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 1 },
    });
    expect(JSON.stringify(tool.wireTool.outputSchema)).not.toContain('pagination');
  });

  it('never treats a non-GET operation as paginated', () => {
    const postOp: NamedOperation = {
      ...listReposOp,
      toolName: 'createRepo',
      operation: { ...listReposOp.operation, method: 'post' },
    };
    const snapshot = buildToolSnapshot([postOp]);
    expect(snapshot.toolsByName['createRepo']?.generated?.pagination).toBeUndefined();
  });

  it('adds the hint as its own text block for a paginated tool without an output schema', async () => {
    const textOp: NamedOperation = {
      ...listReposOp,
      toolName: 'listReposText',
      operation: {
        ...listReposOp.operation,
        responses: { '200': { description: 'ok', headers: { Link: {} } } },
      },
    };
    const { outcome } = await call(
      textOp,
      page('<https://api.example.test/orgs/acme/repos?page=2>; rel="next"'),
      { org: 'acme' },
    );
    expect(outcome.content.at(-1)?.text).toBe('pagination: {"next":{"org":"acme","page":2}}');
  });
});

describe('createExecutor — optional retries for retry-safe requests', () => {
  const idemOp: NamedOperation = {
    toolName: 'createOrder',
    operation: {
      method: 'post',
      path: '/orders',
      tags: [],
      deprecated: false,
      parameters: [
        { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
          },
        },
      },
      responses: { '201': { description: 'created' } },
    },
  };
  const putOp: NamedOperation = {
    ...pingOp,
    toolName: 'putThing',
    operation: { ...pingOp.operation, method: 'put' },
  };

  type Step = number | 'reset';
  // A scripted fake transport plus a fake clock: sleep() advances the clock
  // instead of waiting, so the backoff schedule is asserted exactly.
  const scripted = (steps: Step[], headers: Record<string, string> = {}) => {
    let clock = 0;
    const sleeps: number[] = [];
    const calls: FetchCall[] = [];
    const fetch: PinnedDeps['fetch'] = (input, init) => {
      calls.push({ url: String(input), init: (init ?? {}) as FetchCall['init'] });
      const step = steps.shift() ?? 200;
      if (step === 'reset') {
        return Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
      }
      return Promise.resolve(new Response(step === 200 ? 'ok' : 'busy', { status: step, headers }));
    };
    const deps: ExecutorDeps = {
      transport: { fetch, resolve: rejectingResolve, timeoutSignal },
      retry: {
        now: () => clock,
        random: () => 0.5,
        sleep: (ms, signal) => {
          sleeps.push(ms);
          clock += ms;
          return signal.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
        },
      },
    };
    return { deps, calls, sleeps };
  };

  const run = (
    op: NamedOperation,
    deps: ExecutorDeps,
    retries: number,
    args: Record<string, unknown> = {},
    signal = freshSignal(),
  ) => {
    const snapshot = buildToolSnapshot([op]);
    const tool = snapshot.toolsByName[op.toolName] as SnapshotTool;
    const executor = createExecutor(
      baseConfig({ retries, validators: validatorsFor(snapshot) }),
      deps,
    );
    return executor(tool, args, signal);
  };

  it('GET 503, 503, 200 with --retries 2 succeeds on the third attempt with jittered backoff', async () => {
    const { deps, calls, sleeps } = scripted([503, 503, 200]);
    const outcome = await run(pingOp, deps, 2);
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(3);
    // Full jitter with random() = 0.5 over a 250 ms, then 500 ms window.
    expect(sleeps).toEqual([125, 250]);
  });

  it('--retries 0 (the default) never retries', async () => {
    const { deps, calls } = scripted([503, 200]);
    const outcome = await run(pingOp, deps, 0);
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of retries and returns the last upstream error', async () => {
    const { deps, calls } = scripted([502, 502, 502, 200]);
    const outcome = await run(pingOp, deps, 2);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/502/u);
    expect(calls).toHaveLength(3);
  });

  it('retries a connection error that happened before any response (PUT is idempotent)', async () => {
    const { deps, calls } = scripted(['reset', 200]);
    const outcome = await run(putOp, deps, 1);
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('never retries DELETE after an ambiguous connection error, but does after a 503', async () => {
    const deleteOp: NamedOperation = {
      ...pingOp,
      toolName: 'deleteThing',
      operation: { ...pingOp.operation, method: 'delete' },
    };
    // The upstream may have deleted the resource and lost the connection
    // while answering: a retry would then report 404 for a successful delete.
    const reset = scripted(['reset', 200]);
    const failed = await run(deleteOp, reset.deps, 2);
    expect(failed.isError).toBe(true);
    expect(reset.calls).toHaveLength(1);
    const busy = scripted([503, 200]);
    const outcome = await run(deleteOp, busy.deps, 2);
    expect(outcome.isError).toBe(false);
    expect(busy.calls).toHaveLength(2);
  });

  it('ignores Retry-After on a 502/504 (honoured only on 429/503)', async () => {
    const { deps, sleeps } = scripted([502, 200], { 'retry-after': '3' });
    await run(pingOp, deps, 1);
    expect(sleeps).toEqual([125]);
  });

  it.each([400, 401, 403, 404, 409, 500, 501])('never retries a %i', async (status) => {
    const { deps, calls } = scripted([status, 200]);
    await run(pingOp, deps, 3);
    expect(calls).toHaveLength(1);
  });

  it('never retries a POST without an Idempotency-Key parameter', async () => {
    const { deps, calls } = scripted([503, 201]);
    const outcome = await run(createThingOp, deps, 3, { name: 'x' });
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('retries a POST that declares Idempotency-Key, sending ONE generated key on every attempt', async () => {
    const { deps, calls } = scripted([503, 504, 201]);
    const outcome = await run(idemOp, deps, 2, { sku: 'a' });
    expect(outcome.isError).toBe(false);
    expect(calls).toHaveLength(3);
    const keys = calls.map((call) => call.init.headers?.['idempotency-key']);
    expect(keys[0]).toMatch(/^[\da-f-]{36}$/u);
    expect(new Set(keys).size).toBe(1);
    // Echoed, so the caller can repeat a failed call with the same key.
    expect(outcome.meta?.['openapi-mcp/idempotencyKey']).toBe(keys[0]);
  });

  it('echoes the key in _meta when the call finally fails too', async () => {
    const { deps, calls } = scripted([503, 503]);
    const outcome = await run(idemOp, deps, 1, { sku: 'a' });
    expect(outcome.isError).toBe(true);
    expect(outcome.meta?.['openapi-mcp/idempotencyKey']).toBe(
      calls[0]?.init.headers?.['idempotency-key'],
    );
  });

  it("keeps the caller's own Idempotency-Key on every attempt", async () => {
    const snapshot = buildToolSnapshot([idemOp]);
    const field = Object.entries(
      (snapshot.toolsByName['createOrder'] as SnapshotTool).generated?.mapper.fields ?? {},
    ).find(([, mapping]) => mapping.destination === 'header')?.[0] as string;
    const { deps, calls } = scripted([503, 201]);
    await run(idemOp, deps, 1, { sku: 'a', [field]: 'caller-key-1' });
    expect(calls.map((call) => call.init.headers?.['idempotency-key'])).toEqual([
      'caller-key-1',
      'caller-key-1',
    ]);
  });

  it('does not add an Idempotency-Key when retries are off', async () => {
    const { deps, calls } = scripted([201]);
    const outcome = await run(idemOp, deps, 0, { sku: 'a' });
    expect(calls[0]?.init.headers?.['idempotency-key']).toBeUndefined();
    expect(outcome.meta?.['openapi-mcp/idempotencyKey']).toBeUndefined();
  });

  it('waits for a 429 Retry-After instead of the jittered delay', async () => {
    const { deps, sleeps, calls } = scripted([429, 200], { 'retry-after': '1' });
    const outcome = await run(pingOp, deps, 1);
    expect(outcome.isError).toBe(false);
    expect(sleeps).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  it('stops when the next backoff would cross the call deadline, reporting the upstream Retry-After', async () => {
    // Retry-After 10 s, but the call timeout (baseConfig) is 5 s.
    const { deps, calls } = scripted([503, 200], { 'retry-after': '10' });
    const outcome = await run(pingOp, deps, 3);
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(outcome.meta).toEqual({ 'openapi-mcp/upstreamRetryAfterMs': 10_000 });
  });

  it('returns cancelled, with no further attempt, when the caller aborts during backoff', async () => {
    const controller = new AbortController();
    const { deps, calls } = scripted([503, 200]);
    const sleep = deps.retry?.sleep;
    const withAbort: ExecutorDeps = {
      ...deps,
      retry: {
        ...deps.retry,
        sleep: (ms, signal) => {
          controller.abort();
          return sleep?.(ms, signal) ?? Promise.resolve();
        },
      },
    };
    const outcome = await run(pingOp, withAbort, 2, {}, controller.signal);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/cancelled/u);
    expect(calls).toHaveLength(1);
  });
});

describe('createExecutor — W3C trace context propagation', () => {
  const TRACE = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    tracestate: 'congo=t61rcWkgMzE',
  };

  const run = async (
    propagate: boolean | undefined,
    handler: (call: FetchCall) => Response = () => textResponse(200, ''),
  ) => {
    const snapshot = buildToolSnapshot([pingOp]);
    const tool = snapshot.toolsByName['pingThing'] as SnapshotTool;
    const { deps, calls } = recordingTransport(handler);
    const executor = createExecutor(
      baseConfig({
        validators: validatorsFor(snapshot),
        ...(propagate === undefined ? {} : { propagateTraceContext: propagate }),
      }),
      deps,
    );
    await executor(tool, {}, freshSignal(), TRACE);
    return calls;
  };

  it('forwards traceparent/tracestate on the same-origin request when enabled', async () => {
    const [call] = await run(true);
    expect(call?.init.headers?.['traceparent']).toBe(TRACE.traceparent);
    expect(call?.init.headers?.['tracestate']).toBe(TRACE.tracestate);
  });

  it('never forwards it when propagation is off (the core default)', async () => {
    for (const propagate of [false, undefined]) {
      const [call] = await run(propagate);
      expect(call?.init.headers?.['traceparent']).toBeUndefined();
    }
  });

  it('never forwards it to a cross-origin redirect target', async () => {
    const calls = await run(true, (call) =>
      call.url.startsWith('https://api.example.test')
        ? new Response(null, { status: 302, headers: { location: 'https://other.example/x' } })
        : textResponse(200, ''),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers?.['traceparent']).toBe(TRACE.traceparent);
    expect(calls[1]?.init.headers?.['traceparent']).toBeUndefined();
    expect(calls[1]?.init.headers?.['tracestate']).toBeUndefined();
  });

  it('reserves traceparent/tracestate: a spec header parameter of that name is no tool input', () => {
    expect(SYSTEM_HEADERS.has('traceparent')).toBe(true);
    expect(SYSTEM_HEADERS.has('tracestate')).toBe(true);
  });
});

// Issue kaisers-io/openapi-mcp-archive#72: end to end with
// --default-response-is-error semantics.
describe('createExecutor — default response treated as error (kaisers-io/openapi-mcp-archive#72)', () => {
  const chargeOp: NamedOperation = {
    toolName: 'getCharge',
    operation: {
      method: 'get',
      path: '/charges',
      tags: [],
      deprecated: false,
      parameters: [],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
        default: { description: 'error' },
      },
    },
  };

  const call = (response: Response) => {
    const snapshot = buildToolSnapshot([chargeOp], true);
    const tool = snapshot.toolsByName['getCharge'] as SnapshotTool;
    const { deps } = recordingTransport(() => response);
    const executor = createExecutor(baseConfig({ validators: validatorsFor(snapshot) }), deps);
    return executor(tool, {}, freshSignal());
  };

  it('returns structuredContent for the documented 200', async () => {
    const outcome = await call(jsonResponse(200, { id: 'ch_1' }));
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toEqual({
      status: 200,
      contentType: 'application/json',
      data: { id: 'ch_1' },
    });
  });

  it('fails closed on an undocumented 201, naming the flag', async () => {
    const outcome = await call(jsonResponse(201, { id: 'ch_1' }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toContain('--default-response-is-error');
  });

  it('keeps the HTTP error path for a 4xx', async () => {
    const outcome = await call(jsonResponse(404, { error: {} }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toContain('404');
  });
});

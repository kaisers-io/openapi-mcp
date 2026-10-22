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
  createExecutor,
  createRedactor,
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

  it('sends the declared JSON variant as Content-Type end to end (#54: merge-patch+json)', async () => {
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

  it('sends the bytes {} for a required body whose properties are all optional (#40)', async () => {
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

  it('sends decoded raw bytes for an application/octet-stream body (#71)', async () => {
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

  it('sends a parseable multipart/form-data body with a generated boundary (#71)', async () => {
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
      socket.on('close', () => sockets.delete(socket));
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

  // Issue #58, end to end: the redactor is built from the header VALUE
  // exactly as serve.ts registers it (`Bearer <token>`), the header really
  // goes out, and the upstream echoes only the bare token.
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

// #72: end to end with --default-response-is-error semantics.
describe('createExecutor — default response treated as error (#72)', () => {
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

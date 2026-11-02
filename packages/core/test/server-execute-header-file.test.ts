import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Response } from 'undici';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createExecutor,
  createHeaderFileSource,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { ExecutorConfig, NamedOperation, PinnedDeps, SnapshotTool } from '../src/index.ts';
import type { CallTelemetry } from '../src/server/telemetry.ts';

// --header-file (#125) in the executor: the value read per call, a file that
// cannot be used sends nothing, a 401 is not replayed but makes the next call
// read the file again, and the 401 hint names the file.

const ops: NamedOperation[] = [
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
      responses: { '200': { description: 'echo', content: { 'text/plain': {} } } },
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
const create = snapshot.toolsByName['create'] as SnapshotTool;

const TOKEN_1 = 'Bearer example-token-not-a-secret-1';
const TOKEN_2 = 'Bearer example-token-not-a-secret-2';

let dir: string;
let path: string;
const writeToken = (value: string): void => {
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

// One executor whose upstream answers each call with the next status; a 200
// echoes the Authorization header it received
const setup = (statuses: number[], overrides: Partial<ExecutorConfig> = {}) => {
  const seen: (string | undefined)[] = [];
  const reports: CallTelemetry[] = [];
  const redactor = createRedactor([]);
  const fetch: PinnedDeps['fetch'] = (_input, init) => {
    const { authorization } = (init?.headers ?? {}) as Record<string, string | undefined>;
    seen.push(authorization);
    const status = statuses[seen.length - 1] ?? 500;
    return Promise.resolve(
      new Response(status === 200 ? `you sent ${String(authorization)}` : 'denied', {
        status,
        headers: { 'content-type': 'text/plain' },
      }),
    );
  };
  const config: ExecutorConfig = {
    baseUrl: 'https://api.example.test',
    baseTrusted: true,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    secretHeaders: [],
    fileHeaders: [
      createHeaderFileSource({
        name: 'Authorization',
        path,
        maxLength: 8192,
        redactor,
        now: () => 0,
      }),
    ],
    staticHeaders: [],
    reservedHeaderNames: new Set([...SYSTEM_HEADERS, 'authorization']),
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
    ...overrides,
  };
  const executor = createExecutor(config, {
    transport: {
      fetch,
      resolve: () => Promise.reject(new Error('no DNS')),
      timeoutSignal: () => new AbortController().signal,
    },
    retry: { sleep: () => Promise.resolve(), random: () => 0, now: () => 0 },
  });
  const call = async () =>
    await executor(create, { name: 'x' }, new AbortController().signal, undefined, (telemetry) => {
      reports.push(telemetry);
    });
  return { call, seen, reports };
};

const textOf = (outcome: { content: unknown }): string => JSON.stringify(outcome.content);

describe('createExecutor — --header-file', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openapi-mcp-execute-header-file-'));
    path = join(dir, 'api.token');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends nothing while the file is missing, then the value once it is there', async () => {
    const { call, seen, reports } = setup([200]);
    const missing = await call();
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('the header file');
    expect(textOf(missing)).toContain('is missing');
    expect(seen).toHaveLength(0);
    expect(reports[0]?.outcome).toBe('token_error');
    writeToken(TOKEN_1);
    const sent = await call();
    expect(sent.isError).toBe(false);
    expect(seen).toStrictEqual([TOKEN_1]);
    // The upstream echoed the value: withheld
    expect(textOf(sent)).not.toContain('example-token-not-a-secret');
  });

  it('does not replay a 401, names the file, and the next call sends the renewed value', async () => {
    writeToken(TOKEN_1);
    const { call, seen } = setup([401, 200]);
    const denied = await call();
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain(
      `upstream request failed with status 401 (check the header file ${JSON.stringify(path).replaceAll('\\', '\\\\').replaceAll('"', '\\"')})`,
    );
    expect(seen).toStrictEqual([TOKEN_1]);
    writeToken(TOKEN_2);
    const renewed = await call();
    expect(renewed.isError).toBe(false);
    expect(seen).toStrictEqual([TOKEN_1, TOKEN_2]);
  });

  it('marks the sent value stale on a 401 even when an OAuth replay then fails', async () => {
    const stale: string[] = [];
    const fileHeader = {
      name: 'X-Key',
      path,
      read: () => Promise.resolve({ ok: 'example-key-not-a-secret' }),
      stale: (value: string) => {
        stale.push(value);
      },
    };
    let tokens = 0;
    const { call, seen } = setup([401], {
      fileHeaders: [fileHeader],
      oauth: {
        envVarHint: 'CID / CSECRET',
        tokens: {
          getToken: () => {
            tokens += 1;
            return Promise.resolve(
              tokens === 1 ? { ok: 'example-access-token' } : { error: 'no token' },
            );
          },
          invalidate: () => true,
        },
      },
    });
    const outcome = await call();
    expect(outcome.isError).toBe(true);
    expect(seen).toHaveLength(1);
    expect(stale).toStrictEqual(['example-key-not-a-secret']);
  });
});

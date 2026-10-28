import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createRedactor,
  dryRunCall,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { ExecutorConfig, NamedOperation } from '../src/index.ts';
import { openManagedFolder } from '../src/files/folder.ts';
import type { SnapshotTool } from '../src/server/types.ts';
import { pngOf } from './helpers/images.ts';

// `call --dry-run` (issue #78): the request a call would send, described by
// the executor's own steps, with nothing sent

const OPERATIONS: NamedOperation[] = [
  {
    toolName: 'createThing',
    operation: {
      method: 'post',
      path: '/things',
      tags: [],
      deprecated: false,
      parameters: [{ name: 'tag', in: 'query', schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '201': { description: 'created' } },
    },
  },
  {
    toolName: 'putImage',
    operation: {
      method: 'put',
      path: '/image',
      tags: [],
      deprecated: false,
      parameters: [],
      requestBody: {
        required: true,
        content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: { '204': { description: 'stored' } },
    },
  },
];

const toolNamed = (name: string, uploadDir?: string): SnapshotTool => {
  const built = buildTools(OPERATIONS, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    ...(uploadDir === undefined ? {} : { uploadDir }),
  });
  const snapshot = buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
  const tool = snapshot.toolsByName[name];
  if (tool === undefined) {
    throw new Error(name);
  }
  return tool;
};

const config = (overrides: Partial<ExecutorConfig> = {}): ExecutorConfig => ({
  baseUrl: 'https://api.example.test/v1',
  baseTrusted: false,
  allowPrivateNetwork: false,
  allowInsecureHttp: false,
  secretHeaders: [],
  staticHeaders: [],
  reservedHeaderNames: new Set(SYSTEM_HEADERS),
  redactor: createRedactor([]),
  timeoutMs: 5000,
  maxResponseBytes: 65_536,
  outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
  maxConcurrent: 16,
  // Every tool has a validator entry, as serve registers one per tool
  validators: { has: () => true, get: () => {} },
  ...overrides,
});

const publicHost = () => Promise.resolve(['93.184.215.14']);

describe('dryRunCall (issue #78)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('describes the request without a header value', async () => {
    const result = await dryRunCall(
      config({
        staticHeaders: [{ name: 'X-Client', value: 'cli' }],
        secretHeaders: [{ name: 'X-Api-Key', value: 'example-token-not-a-secret', envVar: 'KEY' }],
        oauth: {
          tokens: {
            getToken: () => Promise.reject(new Error('no token may be requested')),
            invalidate: () => false,
          },
          envVarHint: 'ID/SECRET',
        },
      }),
      toolNamed('createThing'),
      { tag: 'a', body: { name: 'box' } },
      publicHost,
    );
    expect(result).toStrictEqual({
      report: {
        method: 'POST',
        origin: 'https://api.example.test',
        path: '/v1/things',
        query: ['tag'],
        headers: [
          { name: 'accept' },
          { name: 'content-type' },
          { name: 'x-client' },
          { name: 'x-api-key', credential: 'set' },
          { name: 'authorization', credential: 'not evaluated' },
        ],
        body: { mediaType: 'application/json', bytes: JSON.stringify({ name: 'box' }).length },
        uploads: [],
        checks: {
          route: { status: 'not evaluated', reason: 'no route table is configured' },
          egress: { status: 'allowed' },
          budgets: { status: 'allowed' },
        },
        notEvaluated: expect.arrayContaining([
          'the OAuth2 access token, its size and its request',
        ]) as unknown,
      },
    });
    expect(JSON.stringify(result)).not.toContain('example-token-not-a-secret');
  });

  it.each([
    ['a private answer', () => Promise.resolve(['10.0.0.5']), 'refused'],
    ['no answer', () => Promise.resolve([]), 'refused'],
    ['a failed lookup', () => Promise.reject(new Error('ENOTFOUND')), 'not evaluated'],
  ])('reports the egress check for %s', async (_name, resolve, status) => {
    const result = await dryRunCall(config(), toolNamed('createThing'), { body: {} }, resolve);
    expect('report' in result && result.report.checks.egress.status).toBe(status);
  });

  it('checks an IP literal without a lookup', async () => {
    const lookups: string[] = [];
    const resolve = (hostname: string) => {
      lookups.push(hostname);
      return publicHost();
    };
    const metadata = await dryRunCall(
      config({ baseUrl: 'http://169.254.169.254' }),
      toolNamed('createThing'),
      { body: {} },
      resolve,
    );
    expect('report' in metadata && metadata.report.checks.egress.status).toBe('refused');
    const literal = await dryRunCall(
      config({ baseUrl: 'http://[2606:2800:220:1::1]' }),
      toolNamed('createThing'),
      { body: {} },
      resolve,
    );
    expect('report' in literal && literal.report.checks.egress.status).toBe('allowed');
    expect(lookups).toEqual([]);
  });

  it('reports headers over the budget as refused', async () => {
    const result = await dryRunCall(
      config({
        outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 10, maxBodyBytes: 65_536 },
      }),
      toolNamed('createThing'),
      { body: {} },
      publicHost,
    );
    expect('report' in result && result.report.checks.budgets.status).toBe('refused');
  });

  it('refuses what the executor refuses before sending', async () => {
    const cleartext = await dryRunCall(
      config({
        baseUrl: 'http://api.example.test',
        secretHeaders: [{ name: 'X-Api-Key', value: 'example-token-not-a-secret', envVar: 'KEY' }],
      }),
      toolNamed('createThing'),
      { body: {} },
      publicHost,
    );
    expect('refused' in cleartext).toBe(true);
    const build = await dryRunCall(config(), toolNamed('createThing'), {}, publicHost);
    expect('refused' in build).toBe(true);
    const meta = await dryRunCall(config(), toolNamed('openapi_mcp_status'), {}, publicHost);
    expect('refused' in meta).toBe(true);
    const unregistered = await dryRunCall(
      config({ validators: new Map() }),
      toolNamed('createThing'),
      { body: {} },
      publicHost,
    );
    expect('refused' in unregistered).toBe(true);
  });

  it('refuses a call whose response validator cannot be compiled, as the executor does', async () => {
    const result = await dryRunCall(
      config({
        validators: {
          has: () => true,
          get: () => {
            throw new Error('invalid pattern');
          },
        },
      }),
      toolNamed('createThing'),
      { body: {} },
      publicHost,
    );
    expect('refused' in result && result.refused.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('output schema could not be compiled') as unknown,
      }),
    ]);
  });

  it('names an upload with its size, and refuses a missing file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oamcp-dry-run-'));
    roots.push(root);
    const folder = await openManagedFolder(join(root, 'uploads'), 'upload folder');
    const png = pngOf(2, 2);
    await writeFile(join(folder.path, 'photo.png'), png);
    const uploads = { folder, maxBytes: 1000 };
    const tool = toolNamed('putImage', folder.path);
    const result = await dryRunCall(
      config({ uploads }),
      tool,
      { body: { file: 'photo.png' } },
      publicHost,
    );
    expect('report' in result && result.report).toMatchObject({
      body: { mediaType: 'image/png', bytes: png.byteLength },
      uploads: [{ field: 'body', file: 'photo.png', bytes: png.byteLength }],
    });
    const missing = await dryRunCall(
      config({ uploads }),
      tool,
      { body: { file: 'missing.png' } },
      publicHost,
    );
    expect('refused' in missing).toBe(true);
  });
});

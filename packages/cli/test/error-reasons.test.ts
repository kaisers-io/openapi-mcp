import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import type { CliContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// Issue #79: a stable `reason` next to `code` for the causes a user can fix
// in the config. The stale-refresh warning's reason is tested in cache.test.ts.

const spec = (extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Reasons', version: '1' },
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        responses: { '200': { description: 'ok' } },
        ...extra,
      },
    },
  },
});

const SPECS: Record<string, unknown> = {
  'plain.json': spec(),
  'ftp-server.json': { ...spec(), servers: [{ url: 'ftp://api.example.test' }] },
  'external-ref.json': spec({ parameters: [{ $ref: 'other.json#/components/parameters/x' }] }),
};

let dir: string;

type Envelope = {
  ok: boolean;
  error?: { code: string; reason?: string; message: string };
  data?: {
    environment: { status: string; reason?: string };
    startup: { status: string; error?: { code: string; reason?: string } };
  };
};

const runJson = async (
  args: readonly string[],
  overrides: Parameters<typeof testContext>[0] = {},
): Promise<{ code: number; envelope: Envelope }> => {
  const lines: string[] = [];
  const ctx = testContext({
    lines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => dir,
    ...overrides,
  });
  const code = await run(ctx, ['node', 'openapi-mcp', '--json', ...args]);
  return { code, envelope: JSON.parse(lines.join('\n')) as Envelope };
};

describe('error reasons (issue #79)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-reasons-'));
    for (const [name, value] of Object.entries(SPECS)) {
      await writeFile(join(dir, name), JSON.stringify(value));
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('env_missing: a variable named by --spec-header-env is unset', async () => {
    const { code, envelope } = await runJson([
      'tools',
      '--spec',
      'https://api.example.test/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(envelope.error).toMatchObject({ code: 'usage', reason: 'env_missing' });
  });

  it('env_missing: check reports it on the environment stage', async () => {
    const { code, envelope } = await runJson([
      'check',
      '--spec',
      'plain.json',
      '--base-url',
      'https://api.example.test',
      '--header-env',
      'Authorization=API_TOKEN',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(envelope.data?.environment).toMatchObject({ status: 'failed', reason: 'env_missing' });
  });

  it('base_url_unresolved: a file spec without servers and without --base-url', async () => {
    const { code, envelope } = await runJson(['check', '--spec', 'plain.json']);
    expect(code).toBe(EXIT.USAGE);
    expect(envelope.data?.startup.error).toMatchObject({
      code: 'usage',
      reason: 'base_url_unresolved',
    });
  });

  it('base_url_unresolved: a spec base URL with a bad shape', async () => {
    const { code, envelope } = await runJson(['check', '--spec', 'ftp-server.json']);
    expect(code).toBe(EXIT.USAGE);
    expect(envelope.data?.startup.error).toMatchObject({
      code: 'usage',
      reason: 'base_url_unresolved',
    });
  });

  it.each([401, 403])('spec_http_401_403: the spec fetch answers %i', async (status) => {
    const fetcher = (() =>
      Promise.resolve(new Response('denied', { status }))) as unknown as CliContext['fetcher'];
    const { code, envelope } = await runJson(
      ['tools', '--spec', 'https://api.example.test/openapi.json'],
      { fetcher },
    );
    expect(code).toBe(EXIT.VALIDATION);
    expect(envelope.error).toMatchObject({ code: 'validation', reason: 'spec_http_401_403' });
  });

  it('has no reason for another failed status', async () => {
    const fetcher = (() =>
      Promise.resolve(new Response('gone', { status: 404 }))) as unknown as CliContext['fetcher'];
    const { envelope } = await runJson(
      ['tools', '--spec', 'https://api.example.test/openapi.json'],
      { fetcher },
    );
    expect(envelope.error?.code).toBe('validation');
    expect(envelope.error).not.toHaveProperty('reason');
  });

  it('spec_external_ref: the spec has an external $ref', async () => {
    const { code, envelope } = await runJson(['tools', '--spec', 'external-ref.json']);
    expect(code).toBe(EXIT.VALIDATION);
    expect(envelope.error).toMatchObject({ code: 'validation', reason: 'spec_external_ref' });
  });

  it('filter_no_selector: a filter pattern has no selector', async () => {
    const { code, envelope } = await runJson([
      'tools',
      '--spec',
      'plain.json',
      '--allow',
      '/things',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(envelope.error).toMatchObject({ code: 'usage', reason: 'filter_no_selector' });
  });
});

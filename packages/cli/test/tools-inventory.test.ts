import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import type { NormalizedSpec } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { withFacts } from '../src/inventory-facts.ts';
import { run } from '../src/main.ts';

// Issue #76: --json tools tells what each operation does and which
// credentials it accepts, exposed or not, so filters can be chosen from it.

const ok = { '200': { description: 'ok' } };
const SPEC = {
  // 3.2: a security scheme can be deprecated
  openapi: '3.2.0',
  info: { title: 'Inventory', version: '1' },
  servers: [{ url: 'https://api.example.test' }],
  security: [{ token: [] }],
  components: {
    securitySchemes: {
      token: { type: 'http', scheme: 'bearer' },
      key: { type: 'apiKey', in: 'header', name: 'X-Key' },
      oauth: {
        type: 'oauth2',
        deprecated: true,
        flows: { clientCredentials: { tokenUrl: 'https://api.example.test/token', scopes: {} } },
      },
      // Past the 64 schemes that are read
      ...Object.fromEntries(
        Array.from({ length: 63 }, (_, index) => [
          `extra${String(index)}`,
          { type: 'http', scheme: 'basic' },
        ]),
      ),
    },
  },
  paths: {
    '/tickets': {
      get: {
        operationId: 'listTickets',
        tags: ['Tickets'],
        summary: 'List tickets',
        description: `Lists every ticket. ${'x'.repeat(2000)}`,
        responses: ok,
      },
      post: {
        operationId: 'createTicket',
        tags: ['Tickets'],
        summary: 'Create a ticket',
        // Either a token, or a key together with OAuth scope tickets:write
        security: [{ token: [] }, { key: [], oauth: ['tickets:write'] }],
        responses: ok,
      },
    },
    '/health': {
      get: { operationId: 'health', security: [], responses: ok },
    },
    '/public': {
      get: { operationId: 'publicInfo', security: [{}, { token: [] }], responses: ok },
    },
    '/cookies': {
      get: {
        operationId: 'withCookie',
        summary: 'Omitted while the spec is read',
        parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }],
        responses: ok,
      },
    },
    '/search': {
      // Its GET is omitted while tools are built, so every HEAD call would be
      // refused (issue #68)
      head: { operationId: 'searchHead', security: [], responses: ok },
      get: {
        operationId: 'search',
        summary: 'Omitted while its tool is built',
        parameters: [
          {
            name: 'expand',
            in: 'query',
            style: 'deepObject',
            explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
        responses: ok,
      },
    },
  },
};

type Row = {
  name?: string;
  method: string;
  path: string;
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  decision?: string;
};
type Data = {
  tools: Row[];
  notExposed: Row[];
  counts: { operations: number; exposed: number; notExposed: Record<string, number> };
  securitySchemes: {
    name: string;
    type: string;
    deprecated: boolean;
    exposed: number;
    notExposed: number;
  }[];
  securitySchemesDropped?: number;
};

let dir: string;

const toolsData = async (): Promise<Data> => {
  const lines: string[] = [];
  const ctx = testContext({
    lines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: () => Promise.resolve(JSON.stringify(SPEC).length),
    cwd: () => dir,
  });
  const code = await run(ctx, ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'spec.json']);
  expect(code).toBe(EXIT.OK);
  return (JSON.parse(lines[0] as string) as { data: Data }).data;
};

const byPath = (rows: readonly Row[], method: string, path: string): Row => {
  const row = rows.find((candidate) => candidate.method === method && candidate.path === path);
  if (row === undefined) {
    throw new Error(`no row ${method} ${path}`);
  }
  return row;
};

describe('tools --json: what each operation does (issue #76)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-inventory-'));
    await writeFile(join(dir, 'spec.json'), JSON.stringify(SPEC));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives exposed tools their operationId, tags, summary and a bounded description', async () => {
    const data = await toolsData();
    const list = byPath(data.tools, 'GET', '/tickets');
    expect(list).toMatchObject({
      operationId: 'listTickets',
      tags: ['Tickets'],
      summary: 'List tickets',
    });
    expect(list.description?.startsWith('Lists every ticket.')).toBe(true);
    expect(list.description?.length).toBeLessThanOrEqual(1024);
    // No summary in the spec: the field is absent
    expect(byPath(data.tools, 'GET', '/health').summary).toBeUndefined();
  });

  it('gives a write left out by the read-only default its summary', async () => {
    const data = await toolsData();
    expect(byPath(data.notExposed, 'POST', '/tickets')).toMatchObject({
      decision: 'read-only-default',
      summary: 'Create a ticket',
      tags: ['Tickets'],
    });
  });

  it('keeps the security structure: root inherited, overridden, OR and AND, none, optional', async () => {
    const data = await toolsData();
    expect(byPath(data.tools, 'GET', '/tickets').security).toEqual([{ token: [] }]);
    expect(byPath(data.notExposed, 'POST', '/tickets').security).toEqual([
      { token: [] },
      { key: [], oauth: ['tickets:write'] },
    ]);
    expect(byPath(data.tools, 'GET', '/health').security).toEqual([]);
    expect(byPath(data.tools, 'GET', '/public').security).toEqual([{}, { token: [] }]);
  });

  it('keeps what an omitted operation has: facts once its spec operation was read', async () => {
    const data = await toolsData();
    // Omitted while normalizing: no operation record, only its identifiers
    const cookie = byPath(data.notExposed, 'GET', '/cookies');
    expect(cookie.decision).toBe('omitted');
    expect(cookie.summary).toBeUndefined();
    // Omitted while its tool was built: the record exists
    expect(byPath(data.notExposed, 'GET', '/search')).toMatchObject({
      decision: 'omitted',
      summary: 'Omitted while its tool is built',
      security: [{ token: [] }],
    });
  });

  it('leaves out a HEAD whose GET was omitted while tools were built (issue #68)', async () => {
    const data = await toolsData();
    expect(data.tools.some((tool) => tool.path === '/search')).toBe(false);
    expect(byPath(data.notExposed, 'HEAD', '/search')).toMatchObject({
      operationId: 'searchHead',
      decision: 'head-without-get',
    });
    expect(data.counts.notExposed['head-without-get']).toBe(1);
  });

  it('lists the declared schemes with their use, and how many past the cap it left out', async () => {
    const data = await toolsData();
    expect(data.securitySchemes.slice(0, 3)).toEqual([
      { name: 'token', type: 'http', deprecated: false, exposed: 2, notExposed: 2 },
      { name: 'key', type: 'apiKey', deprecated: false, exposed: 0, notExposed: 1 },
      { name: 'oauth', type: 'oauth2', deprecated: true, exposed: 0, notExposed: 1 },
    ]);
    expect(data.securitySchemes).toHaveLength(64);
    expect(data.securitySchemesDropped).toBe(2);
  });

  it('counts every operation once', async () => {
    const data = await toolsData();
    expect(data.counts).toEqual({
      operations: 7,
      exposed: 3,
      notExposed: {
        denied: 0,
        'not-allowed': 0,
        'read-only-default': 1,
        omitted: 2,
        withheld: 0,
        'head-without-get': 1,
      },
    });
    expect(data.counts.operations).toBe(data.tools.length + data.notExposed.length);
  });
});

describe('withFacts', () => {
  const spec = {
    title: 't',
    specVersion: '1',
    openapiVersion: '3.2.0',
    operations: [
      {
        method: 'delete',
        path: '/a',
        operationId: 'removeA',
        tags: [],
        summary: 'Remove A',
        deprecated: false,
        parameters: [],
        responses: {},
      },
    ],
    omitted: [],
  } as unknown as NormalizedSpec;

  it('adds the facts of a withheld operation that has a record, and leaves others as they are', () => {
    const withheld = {
      method: 'DELETE',
      path: '/a',
      tags: [],
      decision: 'withheld' as const,
      reason: 'removed',
    };
    const unknown = {
      method: 'GET',
      path: '/b',
      tags: [],
      decision: 'omitted' as const,
      reason: 'x',
    };
    const [first, second] = withFacts([withheld, unknown], spec);
    expect(first).toMatchObject({ operationId: 'removeA', summary: 'Remove A' });
    expect(first?.security).toBeUndefined();
    expect(second).toEqual(unknown);
  });
});

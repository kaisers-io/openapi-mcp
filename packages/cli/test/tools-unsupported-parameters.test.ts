import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// Issue #67: --omit-unsupported-parameters, through the real CLI (`tools`
// and `check`). Without it nothing changes but a hint; with it the matching
// operations become tools without the optional parameters this server
// cannot send. The filters and the read-only default decide as before.

const ok = { '200': { description: 'ok' } };
// Stripe's `expand`: a deepObject over an array, which OpenAPI leaves undefined
const expand = {
  name: 'expand',
  in: 'query',
  style: 'deepObject',
  explode: true,
  schema: { type: 'array', items: { type: 'string' } },
};
const limit = { name: 'limit', in: 'query', schema: { type: 'integer' } };
const EXPAND_REASON = 'parameter "expand": deepObject requires an object of scalar values';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Unsupported', version: '1' },
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/items': {
      get: { operationId: 'listItems', parameters: [limit, expand], responses: ok },
      post: { operationId: 'createItem', parameters: [expand], responses: ok },
    },
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getItem', parameters: [expand], responses: ok },
      delete: { operationId: 'deleteItem', responses: ok },
    },
    // Required: never left out
    '/reports': {
      get: { operationId: 'getReport', parameters: [{ ...expand, required: true }], responses: ok },
    },
    // A kept exploded object could send `expand` itself
    '/search': {
      get: {
        operationId: 'search',
        parameters: [{ name: 'filter', in: 'query', schema: { type: 'object' } }, expand],
        responses: ok,
      },
    },
  },
};

// 600 reads, every other one with `expand`
const BIG = {
  openapi: '3.1.0',
  info: { title: 'Big', version: '1' },
  servers: [{ url: 'https://api.example.test' }],
  paths: Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [
      `/r${String(index)}`,
      {
        get: {
          operationId: `read${String(index)}`,
          parameters: index % 2 === 0 ? [expand] : [],
          responses: ok,
        },
      },
    ]),
  ),
};

// 512 reads, the budget, and a HEAD whose GET the filters leave out (#68)
const AT_BUDGET = {
  ...BIG,
  paths: {
    ...Object.fromEntries(Object.entries(BIG.paths).slice(0, 512)),
    '/hidden': {
      get: { operationId: 'getHidden', responses: ok },
      head: { operationId: 'headHidden', responses: ok },
    },
  },
};

type Row = { method: string; path: string; name?: string; toolName?: string };
type Data = {
  toolCount: number;
  tools: (Row & { leftOutParameters?: { name: string; in: string; reason: string }[] })[];
  notExposed: (Row & { decision: string; reason: string; omittableParameters?: string[] })[];
  deadPatterns: { raw: string; flag: string }[];
};
type Envelope = {
  ok: boolean;
  data: Data;
  warnings: string[];
  error?: { code: string; message: string };
};

let dir: string;

const cli = async (args: readonly string[], global: readonly string[] = ['--json']) => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const ctx = testContext({
    lines,
    errLines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => dir,
  });
  const code = await run(ctx, ['node', 'openapi-mcp', ...global, ...args]);
  return { code, lines, errLines };
};

const tools = async (...args: string[]) => {
  const result = await cli(['tools', '--spec', 'spec.json', ...args]);
  return { code: result.code, envelope: JSON.parse(result.lines.join('\n')) as Envelope };
};

const names = (data: Data) => data.tools.map((tool) => tool.name);
const notExposed = (data: Data, operationId: string) =>
  data.notExposed.find((row) => row.toolName === operationId);

describe('--omit-unsupported-parameters (issue #67)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-unsupported-'));
    await writeFile(join(dir, 'spec.json'), JSON.stringify(SPEC));
    await writeFile(join(dir, 'big.json'), JSON.stringify(BIG));
    await writeFile(join(dir, 'at-budget.json'), JSON.stringify(AT_BUDGET));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('omits the operations as before without it, and names the flag that builds them', async () => {
    const { code, envelope } = await tools();
    expect(code).toBe(EXIT.OK);
    expect(envelope.data.toolCount).toBe(0);
    expect(notExposed(envelope.data, 'listItems')).toMatchObject({
      decision: 'omitted',
      reason: EXPAND_REASON,
      omittableParameters: ['expand'],
    });
    expect(notExposed(envelope.data, 'getItem')?.omittableParameters).toStrictEqual(['expand']);
    // Required, or sendable by another parameter: no flag would help
    expect(notExposed(envelope.data, 'getReport')?.omittableParameters).toBeUndefined();
    expect(notExposed(envelope.data, 'search')?.omittableParameters).toBeUndefined();
    expect(envelope.warnings).toContain(
      '2 operations are omitted only for optional parameters this server cannot send; --omit-unsupported-parameters <pattern> builds them without those parameters: listItems (expand), getItem (expand)',
    );
  });

  it('builds the matching operations without those parameters, and says so', async () => {
    const { code, envelope } = await tools('--omit-unsupported-parameters', 'method:get');
    expect(code).toBe(EXIT.OK);
    expect(names(envelope.data)).toStrictEqual(['listItems', 'getItem']);
    expect(envelope.data.tools[0]?.leftOutParameters).toStrictEqual([
      { name: 'expand', in: 'query', reason: EXPAND_REASON },
    ]);
    expect(envelope.warnings).toContain(
      '--omit-unsupported-parameters: 2 tools leave out optional parameters the agent cannot set: listItems (expand), getItem (expand); each with its reason: openapi-mcp --json tools',
    );
    expect(notExposed(envelope.data, 'getReport')).toMatchObject({
      decision: 'omitted',
      reason: EXPAND_REASON,
    });
    expect(notExposed(envelope.data, 'search')).toMatchObject({
      decision: 'omitted',
      reason: 'parameter "expand" cannot be left out: the query parameter "filter" could send it',
    });
  });

  it('builds only what the pattern names', async () => {
    const { envelope } = await tools('--omit-unsupported-parameters', 'operationId:getItem');
    expect(names(envelope.data)).toStrictEqual(['getItem']);
    expect(notExposed(envelope.data, 'listItems')?.omittableParameters).toStrictEqual(['expand']);
  });

  it('never exposes what --deny or the read-only default leaves out', async () => {
    const denied = await tools(
      '--omit-unsupported-parameters',
      'path:/**',
      '--deny',
      'operationId:listItems',
    );
    expect(names(denied.envelope.data)).toStrictEqual(['getItem']);
    expect(notExposed(denied.envelope.data, 'listItems')?.decision).toBe('denied');
    // The read-only default still leaves out the POST the pattern names
    expect(notExposed(denied.envelope.data, 'createItem')?.decision).toBe('read-only-default');
    const writes = await tools('--omit-unsupported-parameters', 'method:post');
    expect(names(writes.envelope.data)).toStrictEqual([]);
    expect(writes.envelope.warnings).toContain(
      '--omit-unsupported-parameters "method:post" matches no exposed operation; it names only operations that are filtered out or omitted',
    );
  });

  it('builds a write only when the filters expose it', async () => {
    const { envelope } = await tools(
      '--allow',
      'method:post',
      '--omit-unsupported-parameters',
      'method:post',
    );
    expect(names(envelope.data)).toStrictEqual(['createItem']);
  });

  it('says when a pattern names only operations that leave nothing out', async () => {
    const { envelope } = await tools(
      '--allow',
      'method:delete',
      '--omit-unsupported-parameters',
      'method:delete',
    );
    expect(names(envelope.data)).toStrictEqual(['deleteItem']);
    expect(envelope.warnings).toContain(
      '--omit-unsupported-parameters "method:delete" matches no operation with an optional parameter this server cannot send, so it changes nothing',
    );
  });

  it('refuses a dead pattern under --strict-filters', async () => {
    const { code, envelope } = await tools(
      '--strict-filters',
      '--omit-unsupported-parameters',
      'operationId:nope',
    );
    expect(code).toBe(EXIT.VALIDATION);
    expect(envelope.error?.message).toContain(
      '--omit-unsupported-parameters "operationId:nope" matches no exposed operation',
    );
  });

  it('marks the tools in the human list', async () => {
    const { lines } = await cli(
      ['tools', '--spec', 'spec.json', '--omit-unsupported-parameters', 'operationId:getItem'],
      [],
    );
    expect(lines.find((line) => line.includes('getItem'))).toMatch(
      /GET\s+\/items\/\{id\} \[1 optional parameter left out\]$/u,
    );
  });

  it('counts the tools that are built against the budget, not the operations', async () => {
    // 600 reads pass the filters; 300 are omitted, so 300 tools fit the 512 budget
    const fits = await cli(['tools', '--spec', 'big.json']);
    expect(fits.code).toBe(EXIT.OK);
    expect((JSON.parse(fits.lines.join('\n')) as Envelope).data.toolCount).toBe(300);
    // Built without `expand`, all 600 are tools: over the budget
    const over = await cli([
      'tools',
      '--spec',
      'big.json',
      '--omit-unsupported-parameters',
      'method:get',
    ]);
    expect(over.code).toBe(EXIT.VALIDATION);
    expect((JSON.parse(over.lines.join('\n')) as Envelope).error?.message).toMatch(
      /^600 tools would be exposed after filtering — exceeds the 512-tool budget/u,
    );
  });

  it('does not count a HEAD that no call can pass against the budget', async () => {
    const result = await cli([
      'tools',
      '--spec',
      'at-budget.json',
      '--omit-unsupported-parameters',
      'method:get',
      '--deny',
      'route:GET /hidden',
    ]);
    expect(result.code).toBe(EXIT.OK);
    const { data } = JSON.parse(result.lines.join('\n')) as Envelope;
    expect(data.toolCount).toBe(512);
    expect(
      data.notExposed.find((row) => row.path === '/hidden' && row.method === 'HEAD'),
    ).toMatchObject({ decision: 'head-without-get' });
  });

  it('starts per operation on the tools that are built, and discovers past the budget', async () => {
    const check = async (...args: string[]) => {
      const result = await cli([
        'check',
        '--spec',
        'big.json',
        '--base-url',
        'https://api.example.test',
        ...args,
      ]);
      return JSON.parse(result.lines.join('\n')) as {
        data: {
          startup: { status: string; error?: { message: string } };
          toolMode?: string;
          apis?: { exposed: string[] }[];
        };
      };
    };
    const fits = await check('--tool-mode', 'per-operation');
    expect(fits.data.startup.status).toBe('ok');
    expect(fits.data.apis?.[0]?.exposed).toHaveLength(300);
    const over = await check(
      '--tool-mode',
      'per-operation',
      '--omit-unsupported-parameters',
      'method:get',
    );
    expect(over.data.startup).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/^600 tools would be exposed/u) as string },
    });
    const discover = await check(
      '--tool-mode',
      'auto',
      '--omit-unsupported-parameters',
      'method:get',
    );
    expect(discover.data).toMatchObject({ startup: { status: 'ok' }, toolMode: 'discover' });
    expect(discover.data.apis?.[0]?.exposed).toHaveLength(600);
  });
});

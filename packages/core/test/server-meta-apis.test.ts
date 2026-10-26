import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';
import { createMetaExecutor } from '../src/server/meta.ts';
import { searchOperations } from '../src/server/search-index.ts';

// Issue #16: with several APIs the status tool also reports each one; with a
// single API it is exactly what it was

const pipeline = {
  spec: { title: 'two APIs', specVersion: '1', omitted: [] },
  contentHash: 'combined-hash',
  displaySource: 'github, shop',
  deadPatterns: [],
};
const RLO = String.fromCodePoint(0x20_2e);
const counts = { denied: 1, 'not-allowed': 0, 'read-only-default': 2, omitted: 0, withheld: 0 };
const apis = [
  {
    name: 'github',
    specTitle: `GitHub ${RLO}v3`,
    specVersion: '1.1.4',
    displaySource: 'https://api.example.test/github.json',
    toolCount: 3,
    omittedCount: 1,
    acceptedContentHash: 'github-hash',
    deadPatternCount: 0,
    notExposedCounts: counts,
  },
  {
    name: 'shop',
    specTitle: 'Shop',
    specVersion: '2',
    displaySource: 'shop.yaml',
    toolCount: 5,
    omittedCount: 0,
    acceptedContentHash: 'shop-hash',
    deadPatternCount: 1,
    notExposedCounts: counts,
  },
];

const built = buildTools([], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });

describe('status with several APIs (#16)', () => {
  it('lists each API, sanitized, and validates against its own schema', async () => {
    const snapshot = buildSnapshot(built, { ...pipeline, apis });
    const outcome = await createMetaExecutor()(snapshot, new AbortController().signal);
    const status = outcome.structuredContent as { apis: { name: string; specTitle: string }[] };
    expect(status.apis.map((api) => api.name)).toStrictEqual(['github', 'shop']);
    expect(status.apis[0]?.specTitle).toBe('GitHub v3');
    const validate = compileEnvelopeValidator(
      snapshot.toolsByName['openapi_mcp_status']?.wireTool.outputSchema,
    );
    expect(validate?.(outcome.structuredContent)).toBe(true);
  });

  it('keeps the single-API status and its schema unchanged', async () => {
    const snapshot = buildSnapshot(built, pipeline);
    const outcome = await createMetaExecutor()(snapshot, new AbortController().signal);
    expect(outcome.structuredContent).not.toHaveProperty('apis');
    const schema = snapshot.toolsByName['openapi_mcp_status']?.wireTool.outputSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty('apis');
  });
});

// Issue #16: in discover mode a search can name one API
describe('search with several APIs (#16)', () => {
  const op = (toolName: string): NamedOperation => ({
    toolName,
    operation: {
      method: 'get',
      path: `/${toolName}`,
      tags: [],
      deprecated: false,
      parameters: [],
      responses: { '200': { description: 'ok' } },
    },
  });
  const tools = buildTools(
    [op('github_repos_get'), op('github_issues_get'), op('shop_orders_get')],
    {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    },
  );

  it('filters by API, and offers the filter only with several APIs', () => {
    const several = buildSnapshot(
      tools,
      { ...pipeline, apis },
      {
        toolMode: 'discover',
        apiNames: ['github', 'shop'],
      },
    );
    const search = several.toolsByName['search_operations'];
    expect(JSON.stringify(search?.wireTool.inputSchema)).toContain('"api"');
    expect(search?.inputSchema.safeParse({ api: 'unknown' }).success).toBe(false);
    const single = buildSnapshot(tools, pipeline, { toolMode: 'discover' });
    expect(
      JSON.stringify(single.toolsByName['search_operations']?.wireTool.inputSchema),
    ).not.toContain('"api"');
  });

  it('returns only the operations of the named API', () => {
    const several = buildSnapshot(
      tools,
      { ...pipeline, apis },
      {
        toolMode: 'discover',
        apiNames: ['github', 'shop'],
      },
    );
    const index = several.searchIndex;
    expect(index).toBeDefined();
    const names = (api?: string) => {
      const outcome = searchOperations(index!, {
        detail: 'names',
        ...(api === undefined ? {} : { api }),
      });
      return (outcome.structuredContent as { results: { name: string }[] }).results.map(
        (r) => r.name,
      );
    };
    expect(names('github')).toStrictEqual(['github_issues_get', 'github_repos_get']);
    expect(names('shop')).toStrictEqual(['shop_orders_get']);
    expect(names()).toHaveLength(3);
  });
});

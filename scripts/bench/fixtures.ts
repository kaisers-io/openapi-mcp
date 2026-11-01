// Benchmark fixtures. Everything the default suite (and the CI gate) runs is
// either already in the repository or generated deterministically below, so
// `pnpm bench` needs no network. The large public specs are opt-in
// (`--suite public`): they are downloaded once from commit-pinned URLs and checked
// against a pinned sha256 before use.

import { readFile } from 'node:fs/promises';
import { LARGE_FIXTURES } from './large-fixtures.ts';
import { flatSpec, jsonSpec, layeredSpec } from './specs.ts';
import { publicSpec } from './public-specs.ts';
import { BENCH_CLIENT_ID, BENCH_CLIENT_SECRET, TOKEN_PATH } from './upstream.ts';
import { describedSpec, toYaml } from './yaml-fixture.ts';

export { flatSpec, layeredSpec } from './specs.ts';

export type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
  // What the mock upstream answers to every request for this fixture. It must
  // conform to the tool's output schema, or the call is reported as an error.
  // A function builds a large body only when the fixture runs.
  response: unknown;
};

// One discovery round trip (issue #22): search for `name`, describe it, call
// it. The search must return `name`, or the sample fails.
export type DiscoveryStep = {
  query: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Fixture = {
  name: string;
  description: string;
  // The spec text and the file extension it is written with
  spec: () => Promise<{ text: string; extension: 'json' | 'yaml' }>;
  // Filter flags passed to both `serve` and `tools`
  filterArgs: readonly string[];
  // Flags only `serve` takes, such as `--tool-mode`
  serveArgs?: readonly string[];
  // Omitted for fixtures that only measure startup and tools/list
  call?: ToolCall;
  // Run in the warm session before the calls, under --tool-mode discover
  discovery?: readonly DiscoveryStep[];
  // The mock upstream sends the body in this many chunks, this far apart: a
  // slow producer
  slowBody?: { chunks: number; delayMs: number };
  // Run in the warm session first (scenarios.ts, issue #22)
  scenario?: 'queue' | 'oauth';
  // Added to the environment of `serve`
  env?: Readonly<Record<string, string>>;
  // `ci`: small enough for the per-PR gate (a few seconds per start today).
  // `heavy`: the full-size reproductions from the performance issues, too
  // slow to run 2 x 2 x 6 times per pull request today. `public`: needs a
  // one-time download (--suite public).
  suite: 'ci' | 'heavy' | 'public';
};

const readRepoFile = (relative: string): Promise<string> =>
  readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

const SYNTHETIC_RESPONSE = { id: '1' };

// One operation behind an OAuth2 client-credentials scheme, whose token URL
// resolves against --base-url: the mock upstream's own token endpoint
const oauthSpec = (): Record<string, unknown> => ({
  ...flatSpec(1),
  components: {
    securitySchemes: {
      cc: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: TOKEN_PATH, scopes: {} } } },
    },
  },
  security: [{ cc: [] }],
});

// Ten targets spread over the catalog, each searched by its name
const discoverySteps = (operationCount: number): DiscoveryStep[] =>
  Array.from({ length: 10 }, (_unused, index) => {
    const name = `getItem${String(Math.floor((index * operationCount) / 10) + 7)}`;
    return { query: name, name, arguments: { id: String(index) } };
  });

export const FIXTURES: readonly Fixture[] = [
  {
    name: 'petstore',
    description: 'the CLI test petstore (3 operations): fixed startup cost',
    spec: async () => ({
      text: await readRepoFile('packages/cli/test/fixtures/petstore.json'),
      extension: 'json',
    }),
    filterArgs: [],
    call: { tool: 'listPets', args: {}, response: [{ id: 1, name: 'Rex' }] },
    suite: 'ci',
  },
  {
    name: 'flat-500',
    description: '500 GET operations with trivial schemas: fixed per-tool cost',
    spec: jsonSpec(() => flatSpec(500)),
    filterArgs: [],
    call: { tool: 'getItem0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'ci',
  },
  {
    name: 'layered-100',
    description: '200 schemas x 2 refs x 5 layers, 100 operations: shared nested models',
    spec: jsonSpec(() => layeredSpec({ schemas: 200, refsPerSchema: 2, pathCount: 50, layers: 5 })),
    filterArgs: ['--allow', 'operationId:*'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'ci',
  },
  {
    // The warm start reads an unchanged file: it reuses the cached, already
    // validated document instead of parsing the YAML again
    // (kaisers-io/openapi-mcp-archive#76), so warmStartupMs vs startupMs
    // shows that saving
    name: 'yaml-400',
    description: '400 GET operations without response schemas, as a YAML file',
    spec: () => Promise.resolve({ text: toYaml(describedSpec(400)), extension: 'yaml' }),
    filterArgs: [],
    suite: 'ci',
  },
  {
    name: 'layered-400',
    description:
      '200 schemas x 2 refs x 7 layers, 400 operations (issue kaisers-io/openapi-mcp-archive#89 "wide.json")',
    spec: jsonSpec(() =>
      layeredSpec({ schemas: 200, refsPerSchema: 2, pathCount: 200, layers: 7 }),
    ),
    filterArgs: ['--allow', 'operationId:*'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'heavy',
  },
  {
    name: 'toolgen-500',
    description:
      '200 schemas x 2 refs x 5 layers, 500 operations (issue kaisers-io/openapi-mcp-archive#90)',
    spec: jsonSpec(() =>
      layeredSpec({ schemas: 200, refsPerSchema: 2, pathCount: 250, layers: 5 }),
    ),
    filterArgs: ['--allow', 'operationId:*'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'heavy',
  },
  {
    // Discover mode lifts the 512-tool budget, and its startup must not grow
    // with the operation count (issue #10). The calls go through
    // call_operation, so the first one includes compiling that operation's
    // output validator (issue #8)
    name: 'discover-2000',
    description: '2,000 GET operations with trivial schemas in --tool-mode discover',
    spec: jsonSpec(() => flatSpec(2000)),
    filterArgs: [],
    serveArgs: ['--tool-mode', 'discover'],
    call: {
      tool: 'call_operation',
      args: { name: 'getItem0', arguments: { id: '1' } },
      response: SYNTHETIC_RESPONSE,
    },
    discovery: discoverySteps(2000),
    suite: 'heavy',
  },
  {
    // The workflow an agent runs under discover (issue #22): search,
    // describe, call, each step and the whole round trip
    name: 'discover-500',
    description: '500 GET operations in --tool-mode discover: search, describe, call',
    spec: jsonSpec(() => flatSpec(500)),
    filterArgs: [],
    serveArgs: ['--tool-mode', 'discover'],
    call: {
      tool: 'call_operation',
      args: { name: 'getItem0', arguments: { id: '1' } },
      response: SYNTHETIC_RESPONSE,
    },
    discovery: discoverySteps(500),
    suite: 'ci',
  },
  ...LARGE_FIXTURES,
  {
    // Issue #22: 80 calls fill the 16 slots and the 64-place queue while the
    // upstream holds them, one more is refused, then the queue drains
    name: 'queue-80',
    description: 'a full admission queue (16 in flight, 64 waiting), drained on release',
    spec: jsonSpec(() => flatSpec(1)),
    filterArgs: [],
    serveArgs: ['--rate-limit', '100000/1m', '--request-timeout', '120s'],
    call: { tool: 'getItem0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    scenario: 'queue',
    suite: 'ci',
  },
  {
    // Issue #22: OAuth2 client credentials against the mock's token endpoint
    name: 'oauth',
    description: 'OAuth2: 16 calls wait for one late token, then 16 meet a revoked one',
    spec: jsonSpec(oauthSpec),
    filterArgs: [],
    serveArgs: [
      '--upstream-oauth-client-id-env',
      'OPENAPI_MCP_BENCH_CLIENT_ID',
      '--upstream-oauth-client-secret-env',
      'OPENAPI_MCP_BENCH_CLIENT_SECRET',
      '--allow-private-network',
      '--rate-limit',
      '100000/1m',
    ],
    env: {
      OPENAPI_MCP_BENCH_CLIENT_ID: BENCH_CLIENT_ID,
      OPENAPI_MCP_BENCH_CLIENT_SECRET: BENCH_CLIENT_SECRET,
    },
    call: { tool: 'getItem0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    scenario: 'oauth',
    suite: 'ci',
  },
  {
    name: 'digitalocean',
    description: 'DigitalOcean v2 (APIs-guru, 1.6 MB YAML), every operation',
    spec: publicSpec('digitalocean'),
    filterArgs: ['--allow', 'operationId:*'],
    suite: 'public',
  },
  {
    name: 'github-repos',
    description: 'GitHub REST (13 MB JSON), --allow tag:repos',
    spec: publicSpec('github'),
    filterArgs: ['--allow', 'tag:repos'],
    suite: 'public',
  },
  {
    name: 'github-discover',
    description: 'GitHub REST (13 MB JSON), every operation (1,241) in --tool-mode discover',
    spec: publicSpec('github'),
    filterArgs: ['--allow', 'operationId:*'],
    serveArgs: ['--tool-mode', 'discover'],
    suite: 'public',
  },
  {
    name: 'stripe-customers',
    description: 'Stripe (8 MB JSON), --allow operationId:GetCustomers*',
    spec: publicSpec('stripe'),
    filterArgs: ['--allow', 'operationId:GetCustomers*'],
    suite: 'public',
  },
];

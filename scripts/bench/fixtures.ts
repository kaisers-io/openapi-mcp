// Benchmark fixtures. Everything the default suite (and the CI gate) runs is
// either already in the repository or generated deterministically below, so
// `pnpm bench` needs no network. The large public specs are opt-in
// (`--suite public`): they are downloaded once from commit-pinned URLs and checked
// against a pinned sha256 before use.

import { readFile } from 'node:fs/promises';
import { publicSpec } from './public-specs.ts';
import { describedSpec, toYaml } from './yaml-fixture.ts';

export type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
  // What the mock upstream answers to every request for this fixture. It must
  // conform to the tool's output schema, or the call is reported as an error.
  response: unknown;
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
  // `ci`: small enough for the per-PR gate (a few seconds per start today).
  // `heavy`: the full-size reproductions from the performance issues, too
  // slow to run 2 x 2 x 6 times per pull request today. `public`: needs a
  // one-time download (--suite public).
  suite: 'ci' | 'heavy' | 'public';
};

type LayeredOptions = {
  schemas: number;
  refsPerSchema: number;
  pathCount: number;
  layers: number;
};

// The layered schema graph from issues kaisers-io/openapi-mcp-archive#89 and
// kaisers-io/openapi-mcp-archive#90: `schemas` component schemas split into
// `layers` layers, every schema referencing `refsPerSchema` schemas of the next
// layer, and `pathCount` paths with a GET and a PUT each that reference one
// schema. Acyclic, but each $ref target is reachable through many paths — the
// shape of a real domain model (customer -> address -> ...), and the shape that
// makes per-occurrence dereferencing and per-occurrence schema conversion
// expensive.
export const layeredSpec = (opts: LayeredOptions): Record<string, unknown> => {
  const perLayer = Math.ceil(opts.schemas / opts.layers);
  const schemas: Record<string, unknown> = {};
  for (let index = 0; index < opts.schemas; index += 1) {
    const layer = Math.floor(index / perLayer);
    const properties: Record<string, unknown> = {
      id: { type: 'string' },
      name: { type: 'string', maxLength: 64 },
      count: { type: 'integer', minimum: 0 },
    };
    if (layer < opts.layers - 1) {
      for (let ref = 0; ref < opts.refsPerSchema; ref += 1) {
        const target = Math.min(
          opts.schemas - 1,
          (layer + 1) * perLayer + ((index + ref) % perLayer),
        );
        properties[`rel${String(ref)}`] = { $ref: `#/components/schemas/S${String(target)}` };
      }
    }
    schemas[`S${String(index)}`] = { type: 'object', required: ['id'], properties };
  }
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < opts.pathCount; index += 1) {
    const schema = { $ref: `#/components/schemas/S${String(index % opts.schemas)}` };
    const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
    const ok = { 200: { description: 'ok', content: { 'application/json': { schema } } } };
    paths[`/r${String(index)}/{id}`] = {
      get: { operationId: `get${String(index)}`, parameters: [idParam], responses: ok },
      put: {
        operationId: `put${String(index)}`,
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: ok,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'synthetic', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    components: { schemas },
  };
};

const jsonSpec =
  (build: () => Record<string, unknown>): Fixture['spec'] =>
  () =>
    Promise.resolve({ text: JSON.stringify(build()), extension: 'json' });

const readRepoFile = (relative: string): Promise<string> =>
  readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

// Many operations with trivial schemas: isolates the fixed per-tool cost
// (schema conversion, output-validator compilation) from schema size
export const flatSpec = (operationCount: number): Record<string, unknown> => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < operationCount; index += 1) {
    paths[`/items${String(index)}/{id}`] = {
      get: {
        operationId: `getItem${String(index)}`,
        // Realistic text, so the tools/list size tracks description changes too
        summary: `Get item ${String(index)}`,
        description: `Returns item ${String(index)} by its identifier. Only items visible to the caller are returned.`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'flat', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
  };
};

const SYNTHETIC_RESPONSE = { id: '1' };

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
    suite: 'heavy',
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

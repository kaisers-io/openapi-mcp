// Benchmark fixtures. Everything the default suite (and the CI gate) runs is
// either already in the repository or generated deterministically below, so
// `pnpm bench` needs no network. The large public specs are opt-in
// (`--suite public`): they are downloaded once from commit-pinned URLs and checked
// against a pinned sha256 before use.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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

// The layered schema graph from issues #89 and #90: `schemas` component
// schemas split into `layers` layers, every schema referencing
// `refsPerSchema` schemas of the next layer, and `pathCount` paths with a GET
// and a PUT each that reference one schema. Acyclic, but each $ref target is
// reachable through many paths — the shape of a real domain model
// (customer -> address -> ...), and the shape that makes per-occurrence
// dereferencing and per-occurrence schema conversion expensive.
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

const readIfPresent = async (file: URL): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

const download = async (url: string, file: URL): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching ${url} failed: HTTP ${String(response.status)}`);
  }
  const text = await response.text();
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, text);
  return text;
};

type PublicSource = {
  url: string;
  sha256: string;
  extension: 'json' | 'yaml';
};

// Pinned by commit, so the bytes (and therefore the sha256) never move
const PUBLIC_SOURCES: Record<string, PublicSource> = {
  digitalocean: {
    url: 'https://raw.githubusercontent.com/APIs-guru/openapi-directory/f04b8d0bcd39c52e1cf3ad7a5fe744709832ae49/APIs/digitalocean.com/2.0/openapi.yaml',
    sha256: '5bd3a4800c4396372cb80d99cc82b49463e4a3f136b63d1794c19f13da37cf63',
    extension: 'yaml',
  },
  github: {
    url: 'https://raw.githubusercontent.com/github/rest-api-description/755ee33b4a81d51f6f07a902cce26cbec3b822f2/descriptions/api.github.com/api.github.com.json',
    sha256: '3177ad6a86ca04c57a9bef3fc24e28a339efb8eb040c6f950af3d3ed2fee7fa3',
    extension: 'json',
  },
  stripe: {
    url: 'https://raw.githubusercontent.com/stripe/openapi/f3799ad599a6cf7c76fd94ce72274c0367cc2ba7/openapi/spec3.json',
    sha256: '7cff4cc46d0654101a36a3302f7544640f5f73e4f3cad6f264f0e23c19fa1776',
    extension: 'json',
  },
};

// Downloads into scripts/bench/.cache/ (gitignored) on first use. A sha256
// mismatch is an error, never a silent re-download: the numbers are only
// comparable across runs if the input bytes are the same.
const publicSpec =
  (name: string): Fixture['spec'] =>
  async () => {
    const source = PUBLIC_SOURCES[name];
    if (source === undefined) {
      throw new Error(`unknown public fixture "${name}"`);
    }
    const file = new URL(`.cache/${name}.${source.extension}`, import.meta.url);
    const text = (await readIfPresent(file)) ?? (await download(source.url, file));
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest !== source.sha256) {
      throw new Error(
        `public fixture "${name}" has sha256 ${digest}, expected ${source.sha256} — delete scripts/bench/.cache/ and retry`,
      );
    }
    return { text, extension: source.extension };
  };

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
    filterArgs: ['--allow', '**'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'ci',
  },
  {
    name: 'layered-400',
    description: '200 schemas x 2 refs x 7 layers, 400 operations (issue #89 "wide.json")',
    spec: jsonSpec(() =>
      layeredSpec({ schemas: 200, refsPerSchema: 2, pathCount: 200, layers: 7 }),
    ),
    filterArgs: ['--allow', '**'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'heavy',
  },
  {
    name: 'toolgen-500',
    description: '200 schemas x 2 refs x 5 layers, 500 operations (issue #90)',
    spec: jsonSpec(() =>
      layeredSpec({ schemas: 200, refsPerSchema: 2, pathCount: 250, layers: 5 }),
    ),
    filterArgs: ['--allow', '**'],
    call: { tool: 'get0', args: { id: '1' }, response: SYNTHETIC_RESPONSE },
    suite: 'heavy',
  },
  {
    name: 'digitalocean',
    description: 'DigitalOcean v2 (APIs-guru, 1.6 MB YAML), every operation',
    spec: publicSpec('digitalocean'),
    filterArgs: ['--allow', '**'],
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
    name: 'stripe-customers',
    description: 'Stripe (8 MB JSON), --allow GetCustomers*',
    spec: publicSpec('stripe'),
    filterArgs: ['--allow', 'GetCustomers*'],
    suite: 'public',
  },
];

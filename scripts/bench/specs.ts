// The synthetic specs of the benchmark fixtures, built deterministically

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

export const jsonSpec =
  (build: () => Record<string, unknown>): (() => Promise<{ text: string; extension: 'json' }>) =>
  () =>
    Promise.resolve({ text: JSON.stringify(build()), extension: 'json' });

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

import { describe, expect, it } from 'vitest';
import { buildTools, SYSTEM_HEADERS } from '../src/index.ts';
import type { HttpMethod, NamedOperation } from '../src/index.ts';

const named = (
  toolName: string,
  parameters: readonly Record<string, unknown>[] = [],
  requestBody?: Record<string, unknown>,
): NamedOperation => ({
  toolName,
  operation: {
    method: 'post' as HttpMethod,
    path: '/x',
    tags: [],
    deprecated: false,
    parameters,
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: {},
  },
});

describe('buildTools', () => {
  it('produces a GeneratedTool with schema, wire schema, and mapper', () => {
    const { tools, omitted } = buildTools(
      [
        named('createThing', [
          {
            name: 'id',
            in: 'query',
            required: true,
            schema: { type: 'string', description: 'the id' },
          },
        ]),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(omitted).toEqual([]);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.toolName).toBe('createThing');
    expect(tool.mapper.fields['id']?.destination).toBe('query');
    expect(tool.inputSchema.safeParse({ id: 'a' }).success).toBe(true);
    const wire = tool.wireSchema as {
      properties: Record<string, { description?: string }>;
      required: string[];
      additionalProperties: unknown;
    };
    expect(wire.properties['id']?.description).toBe('the id');
    expect(wire.additionalProperties).toBe(false);
    expect(wire.required).toContain('id');
  });

  it('emits a wire pattern without enforcing it (decision A)', () => {
    const { tools } = buildTools(
      [
        named('p', [
          {
            name: 'code',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: '^[0-9]+$' },
          },
        ]),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const wire = tools[0]!.wireSchema as { properties: Record<string, { pattern?: string }> };
    expect(wire.properties['code']?.pattern).toBe('^[0-9]+$');
    // Not enforced: a non-matching value still validates.
    expect(tools[0]!.inputSchema.safeParse({ code: 'abc' }).success).toBe(true);
  });

  it('omits an operation whose schema is unrepresentable, with a reason', () => {
    const { tools, omitted } = buildTools(
      [named('bad', [{ name: 'q', in: 'query', schema: { not: {} } }])],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(tools).toEqual([]);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ method: 'POST', path: '/x' });
    expect(omitted[0]!.reason).toContain('not');
  });

  it('drops a system-header parameter from the schema', () => {
    const { tools } = buildTools(
      [
        named('h', [
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          { name: 'keep', in: 'query', schema: { type: 'string' } },
        ]),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(Object.keys(tools[0]!.mapper.fields)).toEqual(['keep']);
  });

  it('reserves a mixed-case operator auth header (case-insensitive set contents)', () => {
    // Operator-configured auth-header names are unioned into reservedHeaders;
    // those may be mixed-case. buildTools must lowercase the set contents so the
    // case-insensitive header lookup matches — otherwise the auth header leaks in
    // as a tool input. reservedHeaders here carries the mixed-case 'X-API-Key'.
    const { tools } = buildTools(
      [
        named('h', [
          { name: 'X-API-Key', in: 'header', schema: { type: 'string' } },
          { name: 'keep', in: 'query', schema: { type: 'string' } },
        ]),
      ],
      { reservedHeaders: new Set([...SYSTEM_HEADERS, 'X-API-Key']), openapiVersion: '3.1' },
    );
    expect(Object.keys(tools[0]!.mapper.fields)).toEqual(['keep']);
  });
});

describe('buildTools — wire schema + sanitization', () => {
  it('propagates a body-field description into the wire schema', () => {
    const { tools } = buildTools(
      [
        named('withBody', [], {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { total: { type: 'integer', description: 'line total' } },
                required: ['total'],
              },
            },
          },
        }),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const wire = tools[0]!.wireSchema as { properties: Record<string, { description?: string }> };
    expect(wire.properties['total']?.description).toBe('line total');
  });

  it('sanitizes a hostile property description in .describe() and the wire schema', () => {
    // Build the hostile string at runtime — no raw control/bidi bytes in this file.
    const bel = String.fromCodePoint(0x07);
    const rlo = String.fromCodePoint(0x20_2e);
    const hostile = `evil${bel}${rlo}text`;
    const { tools } = buildTools(
      [
        named('h', [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', description: hostile },
          },
        ]),
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const tool = tools[0]!;
    const wire = tool.wireSchema as { properties: Record<string, { description?: string }> };
    const wireDesc = wire.properties['q']?.description ?? '';
    expect(wireDesc).not.toContain(bel);
    expect(wireDesc).not.toContain(rlo);
    expect(wireDesc).toContain('evil');
    // Zod side: this fixture has a single REQUIRED query param and no optional-body
    // refinement, so inputSchema IS the strict object and `.shape.q` is the bare
    // (un-wrapped) ZodString — its `.describe()` is the same sanitized value the
    // wire schema derives from.
    const { shape } = tool.inputSchema as unknown as {
      shape: Record<string, { description?: string }>;
    };
    const zodDesc = shape['q']?.description ?? '';
    expect(zodDesc).toBe(wireDesc);
    expect(zodDesc).not.toContain(bel);
    expect(zodDesc).not.toContain(rlo);
  });

  it('wires description, annotations, and outputSchema onto every GeneratedTool', () => {
    const built = buildTools(
      [
        {
          toolName: 'getThing',
          operation: {
            method: 'get',
            path: '/things/{id}',
            tags: [],
            summary: 'Get a thing',
            deprecated: false,
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': {
                content: { 'application/json': { schema: { type: 'object', properties: {} } } },
              },
            },
          },
        },
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(built.tools).toHaveLength(1);
    const [tool] = built.tools;
    expect(tool?.description).toBe('Get a thing');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.outputSchema).toBeDefined();
  });
});

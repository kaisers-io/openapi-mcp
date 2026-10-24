import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  OpenapiMcpError,
  openapiVersionOf,
  parseSpecText,
  validateOpenApiDocument,
} from '../src/index.ts';
import {
  GENERATED_FILES,
  generateValidator,
  unwrapDefault,
} from '../src/spec/generate-validators.ts';
import load30 from '../src/spec/generated/openapi-3.0-validator.cjs';
import load31 from '../src/spec/generated/openapi-3.1-validator.cjs';
import load32 from '../src/spec/generated/openapi-3.2-validator.cjs';

const minimal30 = (): Record<string, unknown> => ({
  openapi: '3.0.3',
  info: { title: 'T', version: '1.0.0' },
  paths: {},
});

const minimal31 = (): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'T', version: '1.0.0' },
  paths: {},
});

const minimal32 = (): Record<string, unknown> => ({
  openapi: '3.2.0',
  info: { title: 'T', version: '1.0.0' },
  paths: {},
});

describe('validateOpenApiDocument', () => {
  it('accepts a minimal valid 3.0 document', () => {
    const validated = validateOpenApiDocument(minimal30());
    expect(validated.version).toBe('3.0');
    expect(validated.document['openapi']).toBe('3.0.3');
  });

  it('accepts a minimal valid 3.1 document', () => {
    expect(validateOpenApiDocument(minimal31()).version).toBe('3.1');
  });

  it('rejects a 3.0 document violating the meta-schema with a precise path', () => {
    const doc = minimal30();
    doc['info'] = { title: 'T' };
    try {
      validateOpenApiDocument(doc);
      expect.unreachable('expected a validation error');
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('validation');
      expect((error as OpenapiMcpError).message).toContain('/info');
    }
  });

  it('rejects a 3.1 document violating the meta-schema', () => {
    const doc = minimal31();
    doc['paths'] = { '/pets': { get: { responses: 'not-an-object' } } };
    expect(() => validateOpenApiDocument(doc)).toThrow(OpenapiMcpError);
  });

  it('rejects swagger 2.0 documents with a targeted message', () => {
    expect(() =>
      validateOpenApiDocument({ swagger: '2.0', info: { title: 'T', version: '1' }, paths: {} }),
    ).toThrow(
      'OpenAPI 2.0 (swagger) documents are not supported — provide an OpenAPI 3.0, 3.1 or 3.2 spec',
    );
  });

  it('recognizes a YAML swagger version written without quotes (#11)', () => {
    const document = parseSpecText('swagger: 2.0\ninfo: {title: T, version: "1"}\npaths: {}\n');
    expect(document['swagger']).toBe(2);
    expect(() => validateOpenApiDocument(document)).toThrow(/OpenAPI 2\.0 \(swagger\)/u);
  });

  it.each(['3.2.0', '3.2.1'])('accepts a minimal valid %s document (#33)', (version) => {
    const validated = validateOpenApiDocument({ ...minimal32(), openapi: version });
    expect(validated.version).toBe('3.2');
  });

  it('rejects a 3.2 document violating the meta-schema (#33)', () => {
    // A querystring parameter is defined by `content`, never by `schema`
    const doc = {
      ...minimal32(),
      paths: {
        '/search': {
          get: {
            parameters: [{ name: 'q', in: 'querystring', schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    expect(() => validateOpenApiDocument(doc)).toThrow(
      /spec failed OpenAPI 3\.2\.0 schema validation/u,
    );
  });

  it('sanitizes and caps a declared 3.2 version before echoing it', () => {
    const doc = {
      openapi: `3.2.\u001B]0;X\u0007${'y'.repeat(500)}`,
      info: { title: 'T' },
      paths: {},
    };
    try {
      validateOpenApiDocument(doc);
      expect.unreachable('expected a validation error');
    } catch (error) {
      const { message } = error as OpenapiMcpError;
      expect(message).not.toContain('\u001B');
      expect(message).not.toContain('\u0007');
      expect(message).not.toContain('y'.repeat(40));
    }
  });

  it.each(['4.0.0', '3.20.0', '2.0', 'three'])(
    'rejects unsupported openapi version %s',
    (version) => {
      expect(() =>
        validateOpenApiDocument({
          openapi: version,
          info: { title: 'T', version: '1' },
          paths: {},
        }),
      ).toThrow(/3\.0\.x, 3\.1\.x or 3\.2\.x/u);
    },
  );

  it('rejects a document without an openapi field', () => {
    expect(() => validateOpenApiDocument({ info: { title: 'T' } })).toThrow(
      /3\.0\.x, 3\.1\.x or 3\.2\.x/u,
    );
  });

  it('caps the reported error list at 10 entries', () => {
    const doc = minimal30();
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 15; index += 1) {
      // Each bogus path item yields at least one meta-schema error
      paths[`/p${index}`] = { get: 'bogus' };
    }
    doc['paths'] = paths;
    try {
      validateOpenApiDocument(doc);
      expect.unreachable('expected a validation error');
    } catch (error) {
      const lines = (error as OpenapiMcpError).message.split('\n');
      // Header line + max 10 error lines + optional "and N more" line
      expect(lines.length).toBeLessThanOrEqual(12);
    }
  });

  it('reuses the compiled validator across calls (still correct on second call)', () => {
    expect(validateOpenApiDocument(minimal31()).version).toBe('3.1');
    expect(validateOpenApiDocument(minimal31()).version).toBe('3.1');
  });

  it('does not echo control characters from the declared openapi version', () => {
    // The version gate only checks the "3.x." prefix — the remainder is
    // arbitrary spec content that must not reach stderr unescaped/verbatim
    const doc = {
      openapi: '3.0.\u001B]0;PWNED\u0007',
      info: { title: 'T' },
      paths: {},
    };
    try {
      validateOpenApiDocument(doc);
      expect.unreachable('expected a validation error');
    } catch (error) {
      const { message } = error as OpenapiMcpError;
      expect(message).not.toContain('\u001B');
      expect(message).not.toContain('\u0007');
      expect(message).toContain('3.0.]0;PWNED');
    }
  });

  it('caps an over-long declared openapi version in the error message', () => {
    const doc = { openapi: `3.0.${'x'.repeat(500)}`, info: { title: 'T' }, paths: {} };
    try {
      validateOpenApiDocument(doc);
      expect.unreachable('expected a validation error');
    } catch (error) {
      // 32-char cap on the version fragment, not on the whole message
      expect((error as OpenapiMcpError).message).not.toContain('x'.repeat(40));
    }
  });
});

describe('precompiled meta-schema validators (issue kaisers-io/openapi-mcp-archive#76)', () => {
  it('are exactly what the generator produces from the installed dependencies', () => {
    // Fails after a bump of ajv, ajv-formats, ajv-draft-04 or the schema
    // package until `node scripts/generate-validators.ts` is run
    for (const version of ['3.0', '3.1', '3.2'] as const) {
      const committed = readFileSync(
        new URL(`../src/spec/generated/${GENERATED_FILES[version]}`, import.meta.url),
        'utf8',
      );
      expect(committed).toBe(generateValidator(version));
    }
  });

  it('load each validator once, on first use (#33)', () => {
    expect(load32()).toBe(load32());
    expect(load31()).not.toBe(load32());
  });

  it('take a required module with or without a default export', () => {
    const exported = { compile: 'fn' };
    expect(unwrapDefault({ default: exported })).toBe(exported);
    expect(unwrapDefault(exported)).toBe(exported);
  });

  it('reach the same verdicts and errors as compiling the meta-schema at runtime', async () => {
    // The previous implementation, as the reference
    const require = createRequire(import.meta.url);
    type Compiler = {
      addFormat: (name: string, format: true) => unknown;
      compile: (schema: object) => ValidateFunction;
    };
    const compileAtRuntime = (version: '3.0' | '3.1' | '3.2'): ValidateFunction => {
      const { default: Ctor } = require(
        version === '3.0' ? 'ajv-draft-04' : 'ajv/dist/2020.js',
      ) as { default: new (opts: object) => Compiler };
      const ajv = new Ctor({ strict: false });
      (require('ajv-formats') as { default: (instance: Compiler) => unknown }).default(ajv);
      ajv.addFormat('media-range', true);
      const schema = require(
        `@seriousme/openapi-schema-validator/schemas/v${version}/schema.json`,
      ) as object;
      return ajv.compile(schema);
    };
    const runtime = {
      '3.0': compileAtRuntime('3.0'),
      '3.1': compileAtRuntime('3.1'),
      '3.2': compileAtRuntime('3.2'),
    };
    const precompiled = { '3.0': load30(), '3.1': load31(), '3.2': load32() };
    const fixtures = [
      parseSpecText(await readFile(new URL('fixtures/petstore-3.0.json', import.meta.url), 'utf8')),
      parseSpecText(await readFile(new URL('fixtures/petstore-3.1.yaml', import.meta.url), 'utf8')),
    ];
    const broken: Record<string, unknown>[] = [
      { ...minimal30(), info: { title: 'T' } },
      { ...minimal31(), info: { title: 7, version: '1' } },
      { ...minimal30(), paths: { 'no-slash': {} } },
      { ...minimal31(), paths: { '/x': { get: { responses: 'nope' } } } },
      { ...minimal31(), servers: [{ url: 'https://example.com', variables: { v: {} } }] },
      { ...minimal30(), components: { schemas: { A: { type: 'object', nullable: 'yes' } } } },
      { ...minimal31(), webhooks: { a: { post: { requestBody: { content: { 'x/y': 1 } } } } } },
      minimal32(),
      { ...minimal32(), $self: 'https://example.test/openapi.yaml' },
      { ...minimal32(), info: { title: 7, version: '1' } },
      {
        ...minimal32(),
        paths: { '/x': { query: { responses: { '200': { description: 'ok' } } } } },
      },
      { ...minimal32(), paths: { '/x': { additionalOperations: { LINK: { responses: {} } } } } },
      {
        ...minimal32(),
        paths: { '/x': { get: { parameters: [{ name: 'q', in: 'querystring' }], responses: {} } } },
      },
    ];
    for (const document of [...fixtures, ...broken]) {
      const version = openapiVersionOf(String(document['openapi'])) ?? '3.1';
      expect(precompiled[version](document)).toBe(runtime[version](document));
      expect(precompiled[version].errors).toEqual(runtime[version].errors);
    }
  });
});

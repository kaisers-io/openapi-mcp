import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { OpenapiMcpError, parseSpecText, validateOpenApiDocument } from '../src/index.ts';
import { GENERATED_FILES, generateValidator } from '../src/spec/generate-validators.ts';
import validate30 from '../src/spec/generated/openapi-3.0-validator.cjs';
import validate31 from '../src/spec/generated/openapi-3.1-validator.cjs';

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
    ).toThrow(/OpenAPI 2.0 \(swagger\)/u);
  });

  it.each(['4.0.0', '3.2.0', '2.0', 'three'])(
    'rejects unsupported openapi version %s',
    (version) => {
      expect(() =>
        validateOpenApiDocument({
          openapi: version,
          info: { title: 'T', version: '1' },
          paths: {},
        }),
      ).toThrow(/3\.0\.x or 3\.1\.x/u);
    },
  );

  it('rejects a document without an openapi field', () => {
    expect(() => validateOpenApiDocument({ info: { title: 'T' } })).toThrow(/3\.0\.x or 3\.1\.x/u);
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
    // The version gate only checks the "3.0."/"3.1." prefix — the remainder is
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

describe('precompiled meta-schema validators (issue #76)', () => {
  it('are exactly what the generator produces from the installed dependencies', () => {
    // Fails after a bump of ajv, ajv-formats, ajv-draft-04 or the schema
    // package until `node scripts/generate-validators.ts` is run
    for (const version of ['3.0', '3.1'] as const) {
      const committed = readFileSync(
        new URL(`../src/spec/generated/${GENERATED_FILES[version]}`, import.meta.url),
        'utf8',
      );
      expect(committed).toBe(generateValidator(version));
    }
  });

  it('reach the same verdicts and errors as compiling the meta-schema at runtime', async () => {
    // The previous implementation, as the reference
    const require = createRequire(import.meta.url);
    type Compiler = {
      addFormat: (name: string, format: true) => unknown;
      compile: (schema: object) => ValidateFunction;
    };
    const compileAtRuntime = (version: '3.0' | '3.1'): ValidateFunction => {
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
    const runtime = { '3.0': compileAtRuntime('3.0'), '3.1': compileAtRuntime('3.1') };
    const precompiled = { '3.0': validate30, '3.1': validate31 };
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
    ];
    for (const document of [...fixtures, ...broken]) {
      const version = String(document['openapi']).startsWith('3.0') ? '3.0' : '3.1';
      expect(precompiled[version](document)).toBe(runtime[version](document));
      expect(precompiled[version].errors).toEqual(runtime[version].errors);
    }
  });
});

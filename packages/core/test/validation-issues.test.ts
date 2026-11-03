import { describe, expect, it } from 'vitest';
import type { OpenapiMcpError } from '../src/index.ts';
import { OPENAPI_DIAGNOSERS } from '../src/spec/diagnosers.ts';
import { validateOpenApiDocument, validateSpecDocument } from '../src/spec/validate.ts';
import { OPENAPI_VALIDATORS } from '../src/spec/validators.ts';
import { validationIssues } from '../src/spec/validation-issues.ts';

const OK = {
  '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
};
// `schema` next to `content` in a 3.0 response
const SCHEMA_BESIDE_CONTENT = {
  '200': {
    description: 'ok',
    schema: { example: {} },
    content: { 'application/json': { schema: { type: 'object' } } },
  },
};

const spec30 = (paths: Record<string, unknown>): Record<string, unknown> => ({
  openapi: '3.0.3',
  info: { title: 'Example', version: '1' },
  paths,
});

const failure = (doc: Record<string, unknown>): OpenapiMcpError => {
  try {
    validateOpenApiDocument(doc, OPENAPI_VALIDATORS, OPENAPI_DIAGNOSERS);
  } catch (error) {
    return error as OpenapiMcpError;
  }
  throw new Error('expected a validation error');
};

describe('spec validation reports every failing location (issue #131)', () => {
  it('lists each invalid object once, with its cause and without the oneOf noise', () => {
    const error = failure(
      spec30({
        '/pets': { get: { responses: OK } },
        '/owners': { get: { responses: SCHEMA_BESIDE_CONTENT } },
        '/visits': { get: { responses: SCHEMA_BESIDE_CONTENT } },
        '/pets/{id}': {
          put: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string', examples: { cat: { value: 'Tom' } } } },
                  },
                },
              },
            },
            responses: OK,
          },
        },
      }),
    );
    expect(error.errors).toEqual([
      {
        path: '/paths/~1owners/get/responses/200',
        messages: ['must NOT have additional properties ("schema")'],
      },
      {
        path: '/paths/~1visits/get/responses/200',
        messages: ['must NOT have additional properties ("schema")'],
      },
      {
        path: '/paths/~1pets~1{id}/put/requestBody/content/application~1json/schema/properties/name',
        messages: ['must NOT have additional properties ("examples")'],
      },
    ]);
    expect(error.message).toContain('schema validation at 3 locations:');
    expect(error.message).toContain('docs/overlays.md');
    expect(error.message).not.toContain('oneOf');
  });

  it('keeps the noise when it is all there is at a location', () => {
    expect(
      validationIssues([
        { instancePath: '/x', keyword: 'oneOf', message: 'must match exactly one schema in oneOf' },
      ]),
    ).toEqual([{ path: '/x', messages: ['must match exactly one schema in oneOf'] }]);
  });

  it('drops a parent with only noise, keeps one with its own cause, and keeps a sibling with a shared prefix', () => {
    expect(
      validationIssues([
        { instancePath: '/paths/~1a', keyword: 'oneOf', message: 'noise' },
        { instancePath: '/paths/~1a/get', keyword: 'type', message: 'child' },
        { instancePath: '/paths/~1a-b', keyword: 'type', message: 'sibling' },
        { instancePath: '', keyword: 'required', message: 'root' },
      ]).map((issue) => issue.path),
    ).toEqual(['/paths/~1a/get', '/paths/~1a-b', '/']);
  });

  it('keeps a missing description on a response next to an invalid schema inside it', () => {
    const error = failure(
      spec30({
        '/pets': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { type: 'pet' } } } },
            },
          },
        },
      }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: '/paths/~1pets/get/responses/200',
        messages: ["must have required property 'description'"],
      }),
      expect.objectContaining({
        path: '/paths/~1pets/get/responses/200/content/application~1json/schema/type',
      }),
    ]);
  });

  it('keeps a missing info at the root next to an invalid operation', () => {
    const doc = spec30({ '/pets': { get: { responses: SCHEMA_BESIDE_CONTENT } } });
    delete doc['info'];
    const paths = failure(doc).errors?.map((location) => location.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/paths/~1pets/get/responses/200');
  });

  it('stops collecting at the cap, so a spec failing in 200,000 places is answered at once', async () => {
    const doc = spec30({});
    doc['servers'] = Array.from({ length: 200_000 }, () => ({}));
    const started = performance.now();
    const error = await validateSpecDocument(doc).catch(
      (error_: unknown) => error_ as OpenapiMcpError,
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect((error as OpenapiMcpError).message).toContain('or more locations:');
    expect((error as OpenapiMcpError).message).toContain('… and more locations');
    expect((error as OpenapiMcpError).errors?.length).toBeLessThanOrEqual(1000);
  });

  it('strips control characters from a path and a property name', () => {
    const [issue] = validationIssues([
      {
        instancePath: '/paths/~1a\u001B[31m',
        keyword: 'additionalProperties',
        message: 'must NOT have additional properties',
        params: { additionalProperty: 'x\u0007y' },
      },
    ]);
    expect(issue).toEqual({
      path: '/paths/~1a[31m',
      messages: ['must NOT have additional properties ("xy")'],
    });
  });

  it('groups thousands of failing locations in linear time', () => {
    const errors = Array.from({ length: 20_000 }, (_, index) => ({
      instancePath: `/paths/~1p${String(index)}/get/responses/200`,
      keyword: 'additionalProperties',
      message: 'must NOT have additional properties',
    }));
    const started = performance.now();
    expect(validationIssues(errors)).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

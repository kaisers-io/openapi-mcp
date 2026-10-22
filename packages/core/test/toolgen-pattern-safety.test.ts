import { describe, expect, it } from 'vitest';
import {
  buildTools,
  compileEnvelopeValidator,
  explainOutputSchema,
  hasNestedQuantifier,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { EnvelopeValidator, OperationRecord } from '../src/index.ts';

// #39 / D11: response patterns with nested quantifiers are never handed to Ajv.
describe('hasNestedQuantifier', () => {
  it.each([
    '^(a+)+$',
    '(a*)*',
    '^(\\w+\\s?)*$',
    '(a+){2}',
    '(a?)+',
    '(\\d{1,3})*',
    '(?:x+)+',
    '(?<word>a+)+',
    '((a+))+',
    '(a+)+?',
    '(a{2,})*',
    // Conservative: unambiguous at runtime, but star height 2 all the same.
    '^[a-z]+(-[a-z]+)*$',
  ])('flags %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(true);
  });

  it.each([
    '^[a-z]+$',
    '^\\d{3}-\\d{4}$',
    '^(\\d{1,3}\\.){3}\\d{1,3}$',
    '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',
    '^(abc)+$',
    '^(a|b)*$',
    '(a+)?',
    '[(a+)+]',
    '\\(a+\\)+',
    '\\p{L}+',
    '^x{2}$',
    'a{,5}+',
    '',
  ])('accepts %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(false);
  });
});

const op = (schema: Record<string, unknown>): OperationRecord => ({
  method: 'get',
  path: '/things',
  tags: [],
  deprecated: false,
  parameters: [],
  responses: { '200': { content: { 'application/json': { schema } } } },
});

const unsafe = {
  type: 'object',
  properties: { code: { type: 'string', pattern: '^(a+)+$' } },
};

describe('output schema with an unsafe response pattern (#39)', () => {
  it('withholds the output schema and says why', () => {
    const result = explainOutputSchema(op(unsafe), '3.1');
    expect(result.outputSchema).toBeUndefined();
    expect(result.withheld).toMatch(/nested quantifiers/u);
  });

  it('keeps the tool, without outputSchema, and tells the agent in the description', () => {
    const { tools, omitted } = buildTools(
      [{ toolName: 'getThings', operation: { ...op(unsafe), summary: 'List things' } }],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(omitted).toEqual([]);
    const tool = tools[0]!;
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.outputSchemaWithheld).toMatch(/nested quantifiers/u);
    expect(tool.description).toMatch(/^No output schema: .*text only\. List things$/u);
  });

  it('an ordinary pattern keeps its output schema, with no note', () => {
    const { tools } = buildTools(
      [
        {
          toolName: 'getThings',
          operation: op({ type: 'string', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' }),
        },
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const tool = tools[0]!;
    expect(tool.outputSchema).toBeDefined();
    expect(tool.outputSchemaWithheld).toBeUndefined();
    expect(tool.description).toBe('');
    // The accepted pattern is enforced by the response validator.
    const validate = compileEnvelopeValidator(tool.outputSchema) as EnvelopeValidator;
    const envelope = (data: unknown) => ({ status: 200, contentType: 'application/json', data });
    expect(validate(envelope('10.0.0.1'))).toBe(true);
    expect(validate(envelope('nope'))).toBe(false);
  });

  it('other omissions (no JSON success) stay silent', () => {
    expect(
      explainOutputSchema({ ...op(unsafe), responses: { '204': { description: 'none' } } }, '3.1'),
    ).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildTools,
  compileEnvelopeValidator,
  explainOutputSchema,
  hasNestedQuantifier,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { EnvelopeValidator, OperationRecord } from '../src/index.ts';
import { compileRe2Pattern, isEnforceablePattern } from '../src/toolgen/pattern-safety.ts';

// Issue kaisers-io/openapi-mcp-archive#39: response patterns with nested
// quantifiers are never advertised to the client's backtracking Ajv.
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
    // Bounded on both sides, but with more than 64 ways to split a match
    '^([a-z0-9]{1,63}\\.?){1,8}$',
    '^(a{1,20}){1,20}$',
    '^((a{1,4}){2}){2}$',
    '^(a{1,2}|a){6}$',
    '^((?:a{1,9}){0}a{1,9}){2}$',
    // Conservative too: the dot ends every label, but 63^3 ways all the same
    '^([a-z]{1,63}\\.){3}$',
  ])('flags %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(true);
  });

  it.each([
    '^[a-z]+$',
    '^\\d{3}-\\d{4}$',
    '^(\\d{1,3}\\.){3}\\d{1,3}$',
    '^(a{1,4}){2}$',
    '^(\\d{1,2}|x){3}$',
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
  properties: { code: { type: 'string', pattern: '^(a+)+$' }, id: { type: 'integer' } },
  required: ['id'],
};

type Wire = { properties: Record<string, Record<string, unknown>>; required?: string[] };
const dataOf = (outputSchema: Record<string, unknown> | undefined): Wire =>
  (outputSchema as { oneOf: [{ properties: { data: Wire } }] }).oneOf[0].properties.data;
const envelope = (data: unknown) => ({ status: 200, contentType: 'application/json', data });

// Issue #104: a pattern that is unsafe for a backtracking engine, or that RE2
// cannot run, loses only the `pattern` keyword.
describe('output schema with an unsafe response pattern (issue #104)', () => {
  it('keeps the output schema and moves the pattern into the description', () => {
    const result = explainOutputSchema(op(unsafe), '3.1');
    expect(result.withheld).toBeUndefined();
    const data = dataOf(result.outputSchema);
    expect(data.required).toEqual(['id']);
    expect(data.properties['id']).toMatchObject({ type: 'integer' });
    expect(data.properties['code']).toEqual({
      type: 'string',
      description: 'Pattern (not enforced): ^(a+)+$',
    });
  });

  it('appends the pattern to a description of the node', () => {
    const result = explainOutputSchema(
      op({ type: 'string', description: 'A code.', pattern: '^(?=x)\\w+$' }),
      '3.1',
    );
    expect(dataOf(result.outputSchema)).toEqual({
      type: 'string',
      description: 'A code. — Pattern (not enforced): ^(?=x)\\w+$',
    });
  });

  it('keeps the note under the description of a single-member allOf', () => {
    const result = explainOutputSchema(
      op({
        description: 'A code.',
        allOf: [{ type: 'string', pattern: '^(?=x)x$', minLength: 1, maxLength: 5 }],
      }),
      '3.1',
    );
    expect(dataOf(result.outputSchema)).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 5,
      description: 'A code. — Pattern (not enforced): ^(?=x)x$',
    });
  });

  it('keeps the note through nested single-member allOf wrappers', () => {
    const result = explainOutputSchema(
      op({
        description: 'Outer.',
        allOf: [{ allOf: [{ type: 'string', pattern: '^(?=x)x$' }] }],
      }),
      '3.1',
    );
    expect(dataOf(result.outputSchema)).toEqual({
      type: 'string',
      description: 'Outer. — Pattern (not enforced): ^(?=x)x$',
    });
  });

  it('keeps the tool and its description unchanged', () => {
    const { tools, omitted } = buildTools(
      [{ toolName: 'getThings', operation: { ...op(unsafe), summary: 'List things' } }],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    expect(omitted).toEqual([]);
    const tool = tools[0]!;
    expect(tool.outputSchemaWithheld).toBeUndefined();
    expect(tool.description).toBe('List things');
    const validate = compileEnvelopeValidator(tool.outputSchema) as EnvelopeValidator;
    expect(validate(envelope({ id: 1, code: 'not a match' }))).toBe(true);
    expect(validate(envelope({ code: 'aaa' }))).toBe(false);
  });

  it.each([
    // Lookaround and backreferences: RE2 has neither
    '^(?=.*\\d)\\w+$',
    '(?<!x)y',
    '^(a)\\1$',
    '^(?<c>a)\\k<c>$',
    // Valid JavaScript that RE2 refuses
    '^\\cA$',
    '^[\\b]$',
    '^\\p{Script=Greek}+$',
    // Valid RE2 that means something else: an empty class, a POSIX class
    '^[^][a]$',
    '^[][a]$',
    '^[[:alpha:][x]$',
    // Not a JavaScript `u` pattern, so the client's Ajv cannot compile it
    '(?i)abc',
    '\\Qa.b\\E',
  ])('does not advertise %s', (pattern) => {
    expect(isEnforceablePattern(pattern)).toBe(false);
  });

  it.each([
    '^[a-z]+$',
    '^(\\d{1,3}\\.){3}\\d{1,3}$',
    '^\\p{Lu}\\p{L}*$',
    '^(?<year>\\d{4})-\\d{2}$',
    '^[\\u0041-\\u005A]+$',
    '^\\u{1F600}$',
    '',
  ])('advertises %s', (pattern) => {
    expect(isEnforceablePattern(pattern)).toBe(true);
  });

  it('keeps a pattern with a control or bidi character, so the schema is withheld', () => {
    const result = explainOutputSchema(op({ type: 'string', pattern: '^(a+)+\u202E$' }), '3.1');
    expect(result.outputSchema).toBeUndefined();
    expect(result.withheld).toMatch(/control or bidirectional/u);
  });

  it('request mode keeps advertising an unsafe pattern', () => {
    const { tools } = buildTools(
      [
        {
          toolName: 'createThing',
          operation: {
            ...op({ type: 'object' }),
            method: 'post',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: unsafe } },
            },
          },
        },
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const wire = tools[0]!.wireSchema as Wire;
    expect(wire.properties['code']).toEqual({
      type: 'string',
      pattern: '^(a+)+$',
    });
  });
});

// Issue #104: the server runs response patterns with RE2.
describe('response patterns on the server (issue #104)', () => {
  const validatorFor = (properties: Record<string, unknown>): EnvelopeValidator =>
    compileEnvelopeValidator({
      type: 'object',
      properties: { data: { type: 'object', properties } },
    }) as EnvelopeValidator;

  it('enforces a pattern', () => {
    const validate = validatorFor({ zip: { type: 'string', pattern: '^\\d{5}$' } });
    expect(validate(envelope({ zip: '12345' }))).toBe(true);
    expect(validate(envelope({ zip: '1234x' }))).toBe(false);
  });

  it('enforces two patterns of one schema each with its own source', () => {
    // Ajv caches a compiled pattern by its toString()
    const validate = validatorFor({
      digits: { type: 'string', pattern: '^\\d+$' },
      letters: { type: 'string', pattern: '^[a-z]+$' },
    });
    expect(validate(envelope({ digits: '42', letters: 'abc' }))).toBe(true);
    expect(validate(envelope({ digits: '42', letters: '42' }))).toBe(false);
    expect(validate(envelope({ digits: 'abc', letters: 'abc' }))).toBe(false);
  });

  it('translates unicode escapes', () => {
    const validate = validatorFor({
      upper: { type: 'string', pattern: '^[\\u0041-\\u005A]+$' },
      emoji: { type: 'string', pattern: '^\\u{1F600}\\uD83D\\uDE00$' },
    });
    expect(validate(envelope({ upper: 'ABC', emoji: '\u{1F600}\u{1F600}' }))).toBe(true);
    expect(validate(envelope({ upper: 'abc' }))).toBe(false);
    expect(validate(envelope({ emoji: '\u{1F600}' }))).toBe(false);
  });

  // The client checks structured content against the advertised schema with
  // JavaScript's engine, so the server must accept exactly the same values.
  it.each([
    ['^.*$', ['a\rb', 'a\u2028b', 'a\u2029b', 'a\nb', 'ab']],
    ['^a.b$', ['a\rb', 'axb', 'a\u{1F600}b']],
    ['^\\S+$', ['a\u00A0b', 'a\u3000b', 'a\vb', 'ab']],
    ['^\\s$', ['\v', '\u00A0', '\uFEFF', '\u2028', ' ', 'a']],
    ['^[\\s,]+$', ['\v,', '\u00A0', 'a']],
    ['^[.]+$', ['..', 'a']],
  ])('accepts what JavaScript accepts for %s', (pattern, values) => {
    const validate = validatorFor({ code: { type: 'string', pattern } });
    for (const value of values) {
      expect([value, validate(envelope({ code: value }))]).toEqual([
        value,
        new RegExp(pattern, 'u').test(value),
      ]);
    }
  });

  it('agrees with JavaScript on every BMP code point for \\s and \\S in and outside a class', () => {
    for (const pattern of [
      '^\\s$',
      '^\\S$',
      '^[\\S]$',
      '^[^\\S]$',
      '^[\\s\\S]$',
      '^[a\\S]$',
      '^[^\\S\\n]$',
    ]) {
      const re2 = compileRe2Pattern(pattern) as NonNullable<ReturnType<typeof compileRe2Pattern>>;
      const js = new RegExp(pattern, 'u');
      const differing: number[] = [];
      for (let code = 0; code <= 0xff_ff; code += 1) {
        if (code < 0xd8_00 || code > 0xdf_ff) {
          const value = String.fromCodePoint(code);
          if (re2.test(value) !== js.test(value)) {
            differing.push(code);
          }
        }
      }
      for (const code of [0x1_00_00, 0x1_f6_00, 0x10_ff_ff]) {
        const value = String.fromCodePoint(code);
        if (re2.test(value) !== js.test(value)) {
          differing.push(code);
        }
      }
      expect([pattern, differing]).toEqual([pattern, []]);
    }
  });

  it('matches a catastrophic pattern in linear time', () => {
    const validate = validatorFor({ code: { type: 'string', pattern: '^(a+)+$' } });
    const long = envelope({ code: `${'a'.repeat(100_000)}!` });
    const started = performance.now();
    expect(validate(long)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(validate(envelope({ code: 'aaaa' }))).toBe(true);
  });

  it('refuses at compile a pattern RE2 cannot run', () => {
    expect(() => validatorFor({ code: { type: 'string', pattern: '^(?=a)a$' } })).toThrow(
      /RE2 cannot run/u,
    );
  });
});

describe('output schema with an ordinary response pattern', () => {
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
    expect(validate(envelope('10.0.0.1'))).toBe(true);
    expect(validate(envelope('nope'))).toBe(false);
  });

  it('other omissions (no JSON success) stay silent', () => {
    expect(
      explainOutputSchema({ ...op(unsafe), responses: { '204': { description: 'none' } } }, '3.1'),
    ).toEqual({});
  });
});

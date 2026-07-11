import { describe, expect, it } from 'vitest';
import { OpenapiMcpError, parseSpecText } from '../src/index.ts';

describe('parseSpecText — JSON', () => {
  it('parses a JSON object', () => {
    expect(parseSpecText('{"openapi":"3.1.0"}')).toEqual({ openapi: '3.1.0' });
  });

  it('parses JSON with a UTF-8 BOM', () => {
    expect(parseSpecText('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON with leading whitespace', () => {
    expect(parseSpecText('  \n {"a":1}')).toEqual({ a: 1 });
  });

  it('falls back to YAML for flow-style YAML that is invalid JSON', () => {
    expect(parseSpecText('{a: 1}')).toEqual({ a: 1 });
  });

  it('reports both messages when JSON-looking content is neither valid JSON nor YAML', () => {
    try {
      parseSpecText('{"a": 1,,}');
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('validation');
      expect((err as OpenapiMcpError).message).toContain('JSON');
      expect((err as OpenapiMcpError).message).toContain('YAML');
    }
  });
});

describe('parseSpecText — YAML', () => {
  it('parses a YAML document', () => {
    expect(parseSpecText('openapi: 3.1.0\ninfo:\n  title: T\n')).toEqual({
      openapi: '3.1.0',
      info: { title: 'T' },
    });
  });

  it('resolves a small number of anchors and aliases', () => {
    expect(parseSpecText('a: &x [1, 2]\nb: *x\n')).toEqual({ a: [1, 2], b: [1, 2] });
  });

  it('rejects an alias bomb via the alias budget', () => {
    const aliases = Array.from({ length: 2000 }, () => '*a').join(', ');
    const bomb = `a: &a [1, 2]\nb: [${aliases}]\n`;
    try {
      parseSpecText(bomb);
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('validation');
      expect((err as OpenapiMcpError).message).toContain('alias');
    }
  });

  it('rejects duplicate mapping keys', () => {
    expect(() => parseSpecText('a: 1\na: 2\n')).toThrowError(/unique/iu);
  });

  it('rejects unresolved tags fail-closed', () => {
    expect(() => parseSpecText('a: !!js/function "x"\n')).toThrowError(OpenapiMcpError);
  });

  it('rejects multi-document streams', () => {
    expect(() => parseSpecText('a: 1\n---\nb: 2\n')).toThrowError(OpenapiMcpError);
  });

  it('rejects invalid YAML with the parser message', () => {
    expect(() => parseSpecText('a: [unclosed\n')).toThrowError(/YAML/u);
  });
});

describe('parseSpecText — structure budgets', () => {
  it('rejects nesting beyond the parse-depth budget', () => {
    const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;
    // Array root would also be rejected, but depth fails first
    expect(() => parseSpecText(deep)).toThrowError(/depth/u);
  });

  it('rejects extreme nesting via the iterative depth walker (V8 JSON.parse no longer recurses)', () => {
    const extreme = `${'['.repeat(100_000)}1${']'.repeat(100_000)}`;
    try {
      parseSpecText(extreme);
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('validation');
      expect((err as OpenapiMcpError).message).toContain('deep');
    }
  });

  it('accepts nesting inside the budget', () => {
    const nested = { a: { b: { c: { d: 1 } } } };
    expect(parseSpecText(JSON.stringify(nested))).toEqual(nested);
  });

  it.each(['[1, 2]', '"scalar"', '42', 'true'])('rejects non-object root %s', (raw) => {
    expect(() => parseSpecText(raw)).toThrowError(/object/u);
  });

  it('rejects an empty document', () => {
    expect(() => parseSpecText('   \n')).toThrowError(/empty/u);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UNSAFE_PATTERN_REASON, convertSchema, MAX_CONVERT_DEPTH } from '../src/index.ts';
import type { SchemaResult } from '../src/index.ts';

const ok = (r: SchemaResult): z.ZodType => {
  if (!('ok' in r)) {
    throw new Error(`expected ok, got unrepresentable: ${r.unrepresentable}`);
  }
  return r.ok;
};

// Read the wire-format pattern a schema advertises (decision A: advertised, not enforced).
const wirePattern = (r: SchemaResult): string | undefined => {
  const js = z.toJSONSchema(ok(r)) as { pattern?: string };
  return js.pattern;
};

describe('convertSchema — scalars', () => {
  it('maps a plain string', () => {
    const s = ok(convertSchema({ type: 'string' }));
    expect(s.safeParse('x').success).toBe(true);
    expect(s.safeParse(1).success).toBe(false);
  });

  it('enforces minLength/maxLength by code point (not UTF-16) and advertises them', () => {
    const s = ok(convertSchema({ type: 'string', minLength: 2, maxLength: 3 }));
    expect(s.safeParse('ab').success).toBe(true);
    expect(s.safeParse('a').success).toBe(false);
    expect(s.safeParse('abcd').success).toBe(false);
    // Code-point counting: "😀" is ONE character, so minLength:2 must REJECT it.
    // Zod's UTF-16 `.min(2)` would wrongly ACCEPT it (JS length 2) — a widening.
    expect(s.safeParse('😀').success).toBe(false);
    // Two astral chars = 2 code points → within [2,3].
    expect(s.safeParse('😀😀').success).toBe(true);
    // Advertised in the wire schema (enforced by refine, opaque to z.toJSONSchema).
    const wire = z.toJSONSchema(s) as { minLength?: number; maxLength?: number };
    expect(wire.minLength).toBe(2);
    expect(wire.maxLength).toBe(3);
  });

  it('advertises pattern WITHOUT enforcing it (no live RegExp)', () => {
    const s = ok(convertSchema({ type: 'string', pattern: '^[a-z]+$' }));
    // Not enforced: a non-matching value still parses (ReDoS avoidance, decision A).
    expect(s.safeParse('ABC').success).toBe(true);
  });

  it('advertises format in the wire schema WITHOUT enforcing it', () => {
    // Advertise, not enforce (2026-07-23): Zod format validators diverge from the
    // spec (z.iso.datetime rejects valid numeric offsets), so we never enforce.
    const s = ok(convertSchema({ type: 'string', format: 'date-time' }));
    // A valid RFC-3339 offset datetime (which z.iso.datetime would reject) passes,
    // and so does a plain string — validation never runs the format.
    expect(s.safeParse('2026-07-22T12:00:00+02:00').success).toBe(true);
    expect(s.safeParse('anything').success).toBe(true);
    // Advertised: the wire schema carries the format keyword.
    expect((z.toJSONSchema(s) as { format?: string }).format).toBe('date-time');
  });

  it('advertises an unknown format too (uniform, not enforced)', () => {
    const s = ok(convertSchema({ type: 'string', format: 'phone' }));
    expect(s.safeParse('anything').success).toBe(true);
    expect((z.toJSONSchema(s) as { format?: string }).format).toBe('phone');
  });

  it('handles 3.1 numeric and 3.0 boolean exclusive bounds', () => {
    // The numeric form is the 3.1 dialect (default version); the boolean modifier
    // form is 3.0-only, so it MUST pass '3.0' — under 3.1 a boolean exclusive bound
    // is malformed for the dialect and omits (fail-closed decision).
    const numeric = ok(convertSchema({ type: 'number', exclusiveMinimum: 0 }, '3.1'));
    expect(numeric.safeParse(0).success).toBe(false);
    expect(numeric.safeParse(0.1).success).toBe(true);
    const boolForm = ok(
      convertSchema({ type: 'integer', minimum: 0, exclusiveMinimum: true }, '3.0'),
    );
    expect(boolForm.safeParse(0).success).toBe(false);
    expect(boolForm.safeParse(1).success).toBe(true);
    const inclusive = ok(convertSchema({ type: 'integer', minimum: 0 }));
    expect(inclusive.safeParse(0).success).toBe(true);
  });

  it('enforces multipleOf exactly (not Zod epsilon) and advertises it', () => {
    const i = ok(convertSchema({ type: 'integer', multipleOf: 2 }));
    expect(i.safeParse(4).success).toBe(true);
    expect(i.safeParse(3).success).toBe(false);
    expect(i.safeParse(2.5).success).toBe(false);
    // Zod's epsilon .multipleOf(2) WRONGLY accepts MAX_SAFE_INTEGER (odd); the
    // remainder refinement rejects it.
    expect(i.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    expect((z.toJSONSchema(i) as { multipleOf?: number }).multipleOf).toBe(2);
    // Large magnitude: `Number.isInteger(1e20 / 3)` is WRONGLY true (the quotient
    // exceeds 2^53, so it is an integer-valued double), but `1e20 % 3` is 1. Use
    // type:'number', NOT 'integer': Zod's `.int()` checks isSafeInteger and rejects
    // BOTH 1e20 and 6e19 (they exceed MAX_SAFE_INTEGER) before the refine runs, so an
    // integer schema could not isolate the remainder guard (verified on Zod 4.4.3:
    // z.number().int().safeParse(6e19) is false). On z.number() the remainder guard
    // rejects 1e20 and accepts the real multiple 6e19 (= 3·2e19); the buggy
    // `Number.isInteger(v/3)` would instead ACCEPT 1e20 — the widening (l) restores.
    const three = ok(convertSchema({ type: 'number', multipleOf: 3 }));
    expect(three.safeParse(1e20).success).toBe(false);
    expect(three.safeParse(6e19).success).toBe(true);
  });

  it('maps boolean', () => {
    expect(ok(convertSchema({ type: 'boolean' })).safeParse(true).success).toBe(true);
  });

  it('maps a typeless schema to unknown (open, representable)', () => {
    expect(ok(convertSchema({})).safeParse({ anything: 1 }).success).toBe(true);
  });

  it('attaches a sanitized description', () => {
    expect(ok(convertSchema({ type: 'string', description: 'a name' })).description).toBe('a name');
  });
});

describe('convertSchema — enum, const, null', () => {
  it('maps a string enum', () => {
    const s = ok(convertSchema({ type: 'string', enum: ['a', 'b'] }));
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse('c').success).toBe(false);
  });

  it('maps a mixed-primitive enum to a literal union', () => {
    const s = ok(convertSchema({ enum: ['a', 1, true] }));
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse(1).success).toBe(true);
    expect(s.safeParse(2).success).toBe(false);
  });

  it('omits when an enum has a non-primitive value', () => {
    expect('unrepresentable' in convertSchema({ enum: [{ a: 1 }] })).toBe(true);
  });

  it('omits an enum with duplicate values', () => {
    // Non-unique enum is malformed (meta-schema uniqueItems); omit (fail-closed),
    // consistent with the type/required uniqueness gates.
    expect('unrepresentable' in convertSchema({ enum: ['a', 'a'] })).toBe(true);
    expect('unrepresentable' in convertSchema({ enum: [1, 1] })).toBe(true);
    expect('ok' in convertSchema({ enum: ['a', 'b'] })).toBe(true);
  });

  it('omits a non-finite enum or const number (NaN/Infinity are not valid JSON)', () => {
    // YAML 1.2 parses `.nan`/`.inf` to NaN/Infinity; z.literal(NaN) would validate NaN
    // while z.toJSONSchema emits const:null — a wire/validator divergence. Omit
    // (fail-closed). Build the values numerically (no raw literals).
    expect('unrepresentable' in convertSchema({ enum: [Number.NaN] })).toBe(true);
    expect('unrepresentable' in convertSchema({ enum: [1, Number.POSITIVE_INFINITY] })).toBe(true);
    expect('unrepresentable' in convertSchema({ const: Number.POSITIVE_INFINITY })).toBe(true);
    expect('unrepresentable' in convertSchema({ const: Number.NaN })).toBe(true);
  });

  it('maps const to a literal', () => {
    const s = ok(convertSchema({ const: 'fixed' }));
    expect(s.safeParse('fixed').success).toBe(true);
    expect(s.safeParse('other').success).toBe(false);
  });

  it('maps pure null (3.1), nullable (3.0 only), and [T,null] (3.1)', () => {
    expect(ok(convertSchema({ type: 'null' })).safeParse(null).success).toBe(true);
    // nullable:true is honoured ONLY under 3.0 (pass the version explicitly).
    const n30 = ok(convertSchema({ type: 'string', nullable: true }, '3.0'));
    expect(n30.safeParse(null).success).toBe(true);
    expect(n30.safeParse('x').success).toBe(true);
    // In 3.1, nullable is not a JSON Schema keyword — ignored, so null is rejected.
    const n31ignored = ok(convertSchema({ type: 'string', nullable: true }, '3.1'));
    expect(n31ignored.safeParse(null).success).toBe(false);
    // 3.1 nullability via the type union works in either version.
    expect(ok(convertSchema({ type: ['string', 'null'] })).safeParse(null).success).toBe(true);
  });

  it('omits a malformed keyword value (validator does not check Schema Object values)', () => {
    expect('unrepresentable' in convertSchema({ type: 'string', minLength: 'wrong' })).toBe(true);
    expect('unrepresentable' in convertSchema({ type: 'string', enum: 'wrong' })).toBe(true);
    expect('unrepresentable' in convertSchema({ type: 'integer', multipleOf: 0 })).toBe(true);
    expect('unrepresentable' in convertSchema({ type: 'integer', minimum: Infinity })).toBe(true);
  });

  it('omits an empty type array (degenerate, matches no type)', () => {
    // `type: []` is unsatisfiable; it must omit, not become z.null(). A pure-null
    // `type: ['null']` is still fine (covered by the pure-null test above).
    expect('unrepresentable' in convertSchema({ type: [] })).toBe(true);
    expect(ok(convertSchema({ type: ['null'] })).safeParse(null).success).toBe(true);
  });

  it('omits an empty type array even with a sibling 3.0 nullable flag', () => {
    // `type: []` matches no type regardless of `nullable: true` — the 3.0 flag
    // widens an existing type, it cannot conjure one. Only an explicit 'null'
    // member may collapse the array to z.null(); the empty array stays omitted.
    expect('unrepresentable' in convertSchema({ type: [], nullable: true }, '3.0')).toBe(true);
  });

  it('omits a type array with duplicate entries', () => {
    // JSON Schema requires unique `type` elements; a duplicate omits even though it
    // would collapse to a valid shape (fail-closed). The accepted unique
    // [T,'null'] normalization is unaffected.
    expect('unrepresentable' in convertSchema({ type: ['null', 'null'] })).toBe(true);
    expect('unrepresentable' in convertSchema({ type: ['string', 'null', 'null'] })).toBe(true);
    expect(ok(convertSchema({ type: ['string', 'null'] })).safeParse(null).success).toBe(true);
  });

  it('preserves integer-ness through a [type, null] union (does not widen to number)', () => {
    // numberSchema must read the NORMALIZED type, not node.type: for
    // type:['integer','null'] node.type is the array, so a naive `node.type ===
    // 'integer'` widens to a plain number that accepts 1.5. The nullable integer must
    // still reject 1.5.
    const s = ok(convertSchema({ type: ['integer', 'null'] }, '3.1'));
    expect(s.safeParse(1).success).toBe(true);
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse(1.5).success).toBe(false);
    // The single-element array form normalizes the same way.
    expect(ok(convertSchema({ type: ['integer'] })).safeParse(1.5).success).toBe(false);
  });

  it('keeps the 3.0 nullable flag when type is an array without a null member', () => {
    // type:['string'] (a single-element array, no 'null' member) plus a sibling
    // 3.0 nullable:true must still admit null. The array branch's nullable
    // must OR in the 3.0 nodeNullable flag, not derive solely from whether
    // 'null' appears among the array's own elements.
    const s = ok(convertSchema({ type: ['string'], nullable: true }, '3.0'));
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse('x').success).toBe(true);
  });

  // The `required` element/uniqueness gate lives inside malformedKeyword, which
  // also handles the scalar keyword misuse checked above; its object-path
  // falsification (a non-string or duplicate `required` element) is tested
  // separately below (`omits a required array …`), alongside the
  // nullable-composition guard's own dedicated test.

  it('omits a wrong-version exclusive bound (form is version-gated)', () => {
    // 3.1 requires the NUMERIC form; a boolean exclusiveMinimum is malformed there.
    expect(
      'unrepresentable' in convertSchema({ type: 'number', exclusiveMinimum: true }, '3.1'),
    ).toBe(true);
    // 3.0 requires the BOOLEAN modifier form; a numeric exclusiveMinimum is
    // malformed there (do not silently reinterpret it as a 3.1 bound).
    expect('unrepresentable' in convertSchema({ type: 'number', exclusiveMinimum: 5 }, '3.0')).toBe(
      true,
    );
    // The right-version forms remain representable.
    expect('ok' in convertSchema({ type: 'number', exclusiveMinimum: 5 }, '3.1')).toBe(true);
    expect(
      'ok' in convertSchema({ type: 'number', minimum: 5, exclusiveMinimum: true }, '3.0'),
    ).toBe(true);
  });

  it('omits a 3.0 boolean exclusive bound without its paired minimum/maximum', () => {
    // In the 3.0/draft-4 dialect the boolean exclusiveMinimum/Maximum is a modifier
    // that REQUIRES its paired minimum/maximum; without the pair it is malformed and
    // would leave the number unconstrained (a widening) — omit instead.
    expect(
      'unrepresentable' in convertSchema({ type: 'number', exclusiveMinimum: true }, '3.0'),
    ).toBe(true);
    expect(
      'unrepresentable' in convertSchema({ type: 'number', exclusiveMaximum: true }, '3.0'),
    ).toBe(true);
    // With the pair present it is representable.
    expect(
      'ok' in convertSchema({ type: 'number', minimum: 0, exclusiveMinimum: true }, '3.0'),
    ).toBe(true);
  });

  it('omits a multi-type schema beyond [T, null]', () => {
    expect('unrepresentable' in convertSchema({ type: ['string', 'number'] })).toBe(true);
  });

  it('does NOT let a sibling nullable widen an enum that excludes null', () => {
    // {type:string, nullable:true, enum:['a']} must reject null — the enum is
    // authoritative; a .nullable() wrapper would silently admit null. Pass '3.0'
    // so the boolean `nullable` is ACTIVE (under the default '3.1' it is ignored
    // globally, so the test would pass vacuously and the 7(c) sabotage would not
    // bind). Under 3.0 nullable is true, and the enum branch must STILL reject
    // null — proving determiners ignore a sibling nullable rather than wrapping it.
    const s = ok(convertSchema({ type: 'string', nullable: true, enum: ['a'] }, '3.0'));
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse(null).success).toBe(false);
  });

  it('accepts null only when it is an enumerated value', () => {
    const s = ok(convertSchema({ enum: ['a', null] }));
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse('b').success).toBe(false);
  });

  it('does NOT let a sibling nullable widen a const', () => {
    // Pass '3.0' so `nullable` is active (see the enum sibling test above); under
    // 3.0 nullable is true and the const branch must still reject null.
    const s = ok(convertSchema({ const: 'a', nullable: true }, '3.0'));
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse(null).success).toBe(false);
  });

  it('maps const: null to z.null()', () => {
    const s = ok(convertSchema({ const: null }));
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse('a').success).toBe(false);
  });

  it('omits a nullable composition', () => {
    // The nullable-composition guard is reachable ONLY under 3.0: the boolean
    // `nullable` is honoured only there (build gates it on version === '3.0'), and
    // a 3.1 `[T,'null']`-union combined with oneOf is caught earlier by the
    // conflict gate. Pass '3.0' explicitly so nullable is true and the guard fires;
    // with the default '3.1', nullable is ignored and the node is a plain
    // (representable) oneOf, so this test would wrongly expect unrepresentable. The
    // 3.1-representable case is asserted separately, in the companion test below
    // ('represents a 3.1 nullable-composition node...').
    expect(
      'unrepresentable' in convertSchema({ nullable: true, oneOf: [{ type: 'string' }] }, '3.0'),
    ).toBe(true);
  });
});

describe('convertSchema — keyword allowlist (fail-closed)', () => {
  it.each([
    ['uniqueItems', { type: 'array', items: { type: 'string' }, uniqueItems: true }],
    ['not', { not: { type: 'string' } }],
    ['patternProperties', { type: 'object', patternProperties: {} }],
    // oxlint-disable-next-line unicorn/no-thenable -- `then:` here is a literal JSON-Schema if/then keyword fixture, not a thenable
    ['if', { if: { type: 'string' }, then: {} }],
    ['prefixItems', { prefixItems: [{ type: 'string' }] }],
    ['minProperties', { type: 'object', minProperties: 2 }],
    ['contains', { type: 'array', contains: { type: 'string' } }],
    ['$ref', { $ref: '#/x' }],
  ])('omits on the unsupported keyword %s', (_label, node) => {
    expect('unrepresentable' in convertSchema(node)).toBe(true);
  });

  it('allows x-* vendor extensions', () => {
    expect('ok' in convertSchema({ type: 'string', 'x-internal': true })).toBe(true);
  });

  it('exports the depth budget (the recursive-depth test lives with the array branch below)', () => {
    // A real recursive-depth test needs the array branch (see 'guards against
    // pathological structural depth' below); this test only asserts the budget
    // constant itself is exported.
    expect(typeof MAX_CONVERT_DEPTH).toBe('number');
  });
});

describe('convertSchema — sibling-assertion conflicts (fail-closed)', () => {
  it('omits enum combined with a sibling constraint', () => {
    // The real schema {type:string, enum:['a'], minLength:2} is unsatisfiable;
    // dropping minLength would widen it. Omit instead.
    expect('unrepresentable' in convertSchema({ type: 'string', enum: ['a'], minLength: 2 })).toBe(
      true,
    );
  });

  it('omits const combined with a sibling constraint', () => {
    expect('unrepresentable' in convertSchema({ const: 'a', minLength: 2 })).toBe(true);
  });

  it('omits enum whose values are incompatible with the sibling type', () => {
    // enum values are numbers but type says string — the branches ignore type,
    // so this would widen. Omit.
    expect('unrepresentable' in convertSchema({ type: 'string', enum: [1] })).toBe(true);
  });

  it('omits when two shape-determiners co-occur', () => {
    expect('unrepresentable' in convertSchema({ enum: ['a'], const: 'a' })).toBe(true);
  });

  it('still allows a compatible enum + type (no conflict)', () => {
    expect('ok' in convertSchema({ type: 'string', enum: ['a', 'b'] })).toBe(true);
  });

  it('advertises pattern in the wire schema without enforcing it, across branches', () => {
    // pattern is advisory (decision A): it does not conflict with a determiner and
    // is emitted into the wire schema on every branch, but never enforced.
    expect(wirePattern(convertSchema({ type: 'string', pattern: '^a$' }))).toBe('^a$');
    expect(wirePattern(convertSchema({ type: 'string', enum: ['a'], pattern: '^a$' }))).toBe('^a$');
    expect(wirePattern(convertSchema({ pattern: '^a$' }))).toBe('^a$'); // typeless → advertised on unknown
    // Not enforced: a value that violates the pattern still parses.
    expect(
      ok(convertSchema({ type: 'string', pattern: '^[0-9]+$' })).safeParse('abc').success,
    ).toBe(true);
  });
});

describe('convertSchema — composites', () => {
  it('maps a strict object and rejects unknown keys', () => {
    const s = ok(
      convertSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
        required: ['a'],
      }),
    );
    expect(s.safeParse({ a: 'x' }).success).toBe(true);
    expect(s.safeParse({ a: 'x', b: 1 }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false);
  });

  it('maps an object with absent additionalProperties as strict', () => {
    const s = ok(convertSchema({ type: 'object', properties: { a: { type: 'string' } } }));
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(false);
  });

  it('maps additionalProperties:true as an open object', () => {
    const s = ok(
      convertSchema({
        type: 'object',
        additionalProperties: true,
        properties: { a: { type: 'string' } },
      }),
    );
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(true);
  });

  it('enforces a schema-valued additionalProperties via catchall', () => {
    const s = ok(
      convertSchema({
        type: 'object',
        additionalProperties: { type: 'number' },
        properties: { a: { type: 'string' } },
      }),
    );
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(true);
    expect(s.safeParse({ a: 'x', extra: 'y' }).success).toBe(false);
  });

  it('maps arrays with item bounds', () => {
    const s = ok(
      convertSchema({ type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 }),
    );
    expect(s.safeParse([1]).success).toBe(true);
    expect(s.safeParse([]).success).toBe(false);
    expect(s.safeParse([1, 2, 3]).success).toBe(false);
    expect(s.safeParse(['x']).success).toBe(false);
  });

  it('merges allOf of disjoint objects', () => {
    const s = ok(
      convertSchema({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
        ],
      }),
    );
    expect(s.safeParse({ a: 'x', b: 1 }).success).toBe(true);
    expect(s.safeParse({ a: 'x' }).success).toBe(false);
  });

  it('omits allOf with overlapping properties', () => {
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [
            { type: 'object', properties: { id: { type: 'string' } } },
            { type: 'object', properties: { id: { type: 'integer' } } },
          ],
        }),
    ).toBe(true);
  });

  it('omits an allOf with a non-object member (single or multi)', () => {
    // Every allOf member must be an object; the merge produces one object.
    expect(
      'unrepresentable' in convertSchema({ allOf: [{ type: 'object' }, { type: 'string' }] }),
    ).toBe(true);
    expect('unrepresentable' in convertSchema({ allOf: [{ type: 'string' }] })).toBe(true);
  });

  it('omits an allOf whose outer type contradicts an object merge', () => {
    // {type:'object', allOf:[{type:'string'}]} must omit — special-casing a
    // single-member allOf would drop the outer type and return a string instead.
    expect(
      'unrepresentable' in convertSchema({ type: 'object', allOf: [{ type: 'string' }] }),
    ).toBe(true);
  });

  it('merges a single-member object allOf', () => {
    const s = ok(
      convertSchema({
        allOf: [
          { type: 'object', properties: { a: { type: 'string', minLength: 2 } }, required: ['a'] },
        ],
      }),
    );
    expect(s.safeParse({ a: 'ab' }).success).toBe(true);
    expect(s.safeParse({ a: 'x' }).success).toBe(false);
    expect(s.safeParse({ a: 'ab', extra: 1 }).success).toBe(false);
  });

  it('maps oneOf/anyOf to a plain union', () => {
    const s = ok(convertSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }] }));
    expect(s.safeParse('x').success).toBe(true);
    expect(s.safeParse(3).success).toBe(true);
    expect(s.safeParse(true).success).toBe(false);
  });

  it('omits when a union member is unrepresentable', () => {
    expect('unrepresentable' in convertSchema({ anyOf: [{ type: 'string' }, { not: {} }] })).toBe(
      true,
    );
  });

  it('omits a property whose schema is unrepresentable', () => {
    expect(
      'unrepresentable' in convertSchema({ type: 'object', properties: { bad: { not: {} } } }),
    ).toBe(true);
  });

  it('omits a multi-member allOf with additionalProperties:false', () => {
    // Member 1 forbids member 2's properties, so the composed schema is far
    // stricter than the merged property set — not faithfully mergeable.
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        }),
    ).toBe(true);
  });

  it('omits a required name that is not a declared property', () => {
    expect(
      'unrepresentable' in
        convertSchema({ type: 'object', required: ['token'], additionalProperties: true }),
    ).toBe(true);
  });

  it('omits a required array with a non-string or duplicate element', () => {
    // The frozen validator does not check Schema Object VALUES, so required:[123]
    // or required:['a','a'] reaches the converter; merely filtering non-strings (as
    // objectSchema would) silently accepts an invalid Schema Object. malformedKeyword
    // omits it (fail-closed). This is the only place that falsifies the object path
    // of the required element/uniqueness gate referenced above.
    expect(
      'unrepresentable' in
        convertSchema({ type: 'object', properties: { x: { type: 'string' } }, required: [123] }),
    ).toBe(true);
    expect(
      'unrepresentable' in
        convertSchema({
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a', 'a'],
        }),
    ).toBe(true);
    // A well-formed required is still accepted (proves the gate is not over-broad).
    expect(
      'ok' in
        convertSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }),
    ).toBe(true);
  });

  it('allows a declared required property alongside additionalProperties:true', () => {
    const s = ok(
      convertSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: true,
      }),
    );
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(true);
    expect(s.safeParse({ extra: 9 }).success).toBe(false);
  });

  it('omits a property named __proto__ (prototype hazard)', () => {
    expect(
      'unrepresentable' in
        convertSchema({ type: 'object', properties: { ['__proto__']: { type: 'string' } } }),
    ).toBe(true);
  });

  it('omits an allOf property named __proto__', () => {
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { ['__proto__']: { type: 'string' } } },
          ],
        }),
    ).toBe(true);
  });

  it('omits any allOf member declaring additionalProperties (fail-closed, cannot merge)', () => {
    // Single-member with AP:true → omit (not silently strict, not silently open).
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [
            { type: 'object', additionalProperties: true, properties: { a: { type: 'string' } } },
          ],
        }),
    ).toBe(true);
    // Multi-member with any declared AP → omit.
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        }),
    ).toBe(true);
  });

  it('omits an allOf member with a malformed required array', () => {
    // mergeAllOf processes members without convertSchema, so it must re-check a
    // member's `required` as an array of unique strings; a non-string or duplicate
    // element would otherwise be silently filtered/deduped (fail-closed).
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: [123] }],
        }),
    ).toBe(true);
    expect(
      'unrepresentable' in
        convertSchema({
          allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] }],
        }),
    ).toBe(true);
  });

  it('omits an allOf member with non-record properties', () => {
    // A non-record `properties` on a member would be silently skipped, producing a
    // strictObject({}) instead of omitting (fail-closed).
    expect(
      'unrepresentable' in convertSchema({ allOf: [{ type: 'object', properties: 'wrong' }] }),
    ).toBe(true);
  });

  it('omits allOf combined with sibling properties (conflict gate)', () => {
    expect(
      'unrepresentable' in
        convertSchema({ allOf: [{ type: 'object' }], properties: { a: { type: 'string' } } }),
    ).toBe(true);
  });

  it('omits oneOf combined with a sibling type (conflict gate)', () => {
    expect(
      'unrepresentable' in
        convertSchema({ type: 'string', oneOf: [{ type: 'string' }, { type: 'number' }] }),
    ).toBe(true);
  });

  it('allows allOf with a redundant type:object sibling', () => {
    const s = ok(
      convertSchema({
        type: 'object',
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'integer' } } },
        ],
      }),
    );
    expect(s.safeParse({ a: 'x', b: 1 }).success).toBe(true);
  });

  it('omits an empty allOf', () => {
    expect('unrepresentable' in convertSchema({ allOf: [] })).toBe(true);
  });

  it('omits an allOf member with no object evidence', () => {
    // Each of these accepts any value; merging as z.strictObject({}) would narrow.
    expect('unrepresentable' in convertSchema({ allOf: [{}] })).toBe(true);
    expect('unrepresentable' in convertSchema({ allOf: [{ description: 'x' }] })).toBe(true);
    expect('unrepresentable' in convertSchema({ allOf: [{ properties: {} }] })).toBe(true);
    expect('unrepresentable' in convertSchema({ allOf: [{ required: [] }] })).toBe(true);
  });

  it('maps a typeless NON-EMPTY properties-only object as a strict object', () => {
    const s = ok(convertSchema({ properties: { a: { type: 'string' } }, required: ['a'] }));
    expect(s.safeParse({ a: 'x' }).success).toBe(true);
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false);
  });

  it('omits a typeless EMPTY properties object (no constraint)', () => {
    expect('unrepresentable' in convertSchema({ properties: {} })).toBe(true);
  });

  it('maps type:object with an empty properties map as a free-form object (#35); only additionalProperties:false closes it', () => {
    // Absent additionalProperties allows any extra property (JSON Schema Core
    // 2020-12 §10.3.2.3); an empty `properties` declares nothing to close over.
    const s = ok(convertSchema({ type: 'object', properties: {} }));
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ a: 1 }).success).toBe(true);
    const closed = ok(
      convertSchema({ type: 'object', properties: {}, additionalProperties: false }),
    );
    expect(closed.safeParse({ a: 1 }).success).toBe(false);
  });

  it('maps a 3.1 nullable array (type [array, null]) as a nullable array, not an object', () => {
    const s = ok(convertSchema({ type: ['array', 'null'], items: { type: 'string' } }));
    expect(s.safeParse(['a']).success).toBe(true);
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse('x').success).toBe(false);
  });

  it('maps a nullable object (3.0 nullable:true, version passed explicitly)', () => {
    const s = ok(
      convertSchema(
        { type: 'object', nullable: true, properties: { a: { type: 'string' } }, required: ['a'] },
        '3.0',
      ),
    );
    expect(s.safeParse({ a: 'x' }).success).toBe(true);
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse({ a: 'x', extra: 9 }).success).toBe(false);
  });

  it('represents a 3.1 nullable-composition node as a plain union (nullable ignored, not widened)', () => {
    // Companion to 'omits a nullable composition' (which uses '3.0'): under 3.1 the
    // boolean `nullable` is not a keyword, so {nullable:true, oneOf:[...]} is a plain
    // oneOf and IS representable — convertComposite really builds the union.
    // Crucially, the result still REJECTS null — nullable is ignored, never widened
    // to admit null.
    const s = ok(convertSchema({ nullable: true, oneOf: [{ type: 'string' }] }, '3.1'));
    expect(s.safeParse('x').success).toBe(true);
    expect(s.safeParse(null).success).toBe(false);
  });

  it('advertises pattern on composite branches (wire keyword, not enforced)', () => {
    // Pattern is attached uniformly in convertSchema, so allOf/oneOf/const also
    // carry it into the wire schema. z is imported at the top of this file.
    const oneOfWire = z.toJSONSchema(
      ok(convertSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }], pattern: '^x$' })),
    ) as { pattern?: string };
    expect(oneOfWire.pattern).toBe('^x$');
    const constWire = z.toJSONSchema(ok(convertSchema({ const: 'a', pattern: '^a$' }))) as {
      pattern?: string;
    };
    expect(constWire.pattern).toBe('^a$');
  });

  it('carries format + pattern + minLength together in the wire schema', () => {
    const wire = z.toJSONSchema(
      ok(convertSchema({ type: 'string', format: 'email', pattern: '^x', minLength: 2 })),
    ) as {
      format?: string;
      pattern?: string;
      minLength?: number;
    };
    expect(wire).toMatchObject({ format: 'email', pattern: '^x', minLength: 2 });
  });

  it('keeps enum + format representable (format is advisory, no conflict)', () => {
    const s = ok(convertSchema({ type: 'string', enum: ['a', 'b'], format: 'uuid' }));
    expect(s.safeParse('a').success).toBe(true);
    expect(s.safeParse('c').success).toBe(false);
    expect((z.toJSONSchema(s) as { format?: string }).format).toBe('uuid');
  });

  it('merges an allOf that includes an explicit-empty-object member (type:object, properties:{})', () => {
    // The explicit-empty member has type:'object' evidence and contributes no
    // properties; the merge is the other member as a strict object.
    const s = ok(
      convertSchema({
        allOf: [
          { type: 'object', properties: {} },
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        ],
      }),
    );
    expect(s.safeParse({ a: 'x' }).success).toBe(true);
    expect(s.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
  });

  it('omits a typeless schema carrying an assertion', () => {
    expect('unrepresentable' in convertSchema({ minLength: 2 })).toBe(true);
  });

  it('guards against pathological structural depth', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i <= MAX_CONVERT_DEPTH + 1; i += 1) {
      node = { type: 'array', items: node };
    }
    expect('unrepresentable' in convertSchema(node)).toBe(true);
  });
});

// #35: `{type:'object'}` with no declared properties and no
// additionalProperties is a FREE-FORM object in JSON Schema (absent
// additionalProperties = any extra property allowed, JSON Schema 2020-12
// Core §10.3.2.3), not "exactly {}".
describe('convertSchema — free-form objects (#35)', () => {
  it('accepts any object for a bare {type:object}, still rejecting non-objects', () => {
    const s = ok(convertSchema({ type: 'object' }));
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ env: 'prod', n: 1 }).success).toBe(true);
    expect(s.safeParse('x').success).toBe(false);
    expect(s.safeParse([]).success).toBe(false);
    expect(s.safeParse(null).success).toBe(false);
  });

  it('treats an EMPTY properties map like no properties (free-form, not strictObject({}))', () => {
    const s = ok(convertSchema({ type: 'object', properties: {} }));
    expect(s.safeParse({ env: 'prod' }).success).toBe(true);
  });

  it('keeps an explicit additionalProperties:false empty object closed (only {})', () => {
    const s = ok(convertSchema({ type: 'object', additionalProperties: false }));
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ a: 1 }).success).toBe(false);
  });

  it('honours a 3.0 nullable free-form object', () => {
    const s = ok(convertSchema({ type: 'object', nullable: true }, '3.0'));
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse({ a: 1 }).success).toBe(true);
    expect(s.safeParse('x').success).toBe(false);
  });

  it('advertises an open object on the wire (no additionalProperties:false)', () => {
    const wire = z.toJSONSchema(ok(convertSchema({ type: 'object' }))) as Record<string, unknown>;
    expect(wire['type']).toBe('object');
    expect(wire['additionalProperties']).not.toBe(false);
  });

  it('rejects a top-level "__proto__" key instead of silently dropping it, and passes nested ones through as plain data', () => {
    const s = ok(convertSchema({ type: 'object' }));
    // JSON.parse creates an OWN "__proto__" key; Zod's record/loose parsers skip
    // it silently, so without a guard the key would vanish from the request.
    expect(s.safeParse(JSON.parse('{"__proto__":{"polluted":true},"a":1}')).success).toBe(false);
    const nested = s.safeParse(JSON.parse('{"a":{"__proto__":{"polluted":true}}}'));
    expect(nested.success).toBe(true);
    expect(JSON.stringify(nested.data)).toBe('{"a":{"__proto__":{"polluted":true}}}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// #33 / #47: one direction-aware `mode` drives both open response objects and
// readOnly/writeOnly handling.
describe('convertSchema — request/response mode (#33, #47)', () => {
  const user = {
    type: 'object',
    required: ['id', 'name', 'password'],
    properties: {
      id: { type: 'string', readOnly: true },
      name: { type: 'string' },
      password: { type: 'string', writeOnly: true },
    },
  };

  it('defaults to request mode: an object with declared properties stays strict', () => {
    const s = ok(convertSchema({ type: 'object', properties: { a: { type: 'string' } } }));
    expect(s.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
    const wire = z.toJSONSchema(s) as Record<string, unknown>;
    expect(wire['additionalProperties']).toBe(false);
  });

  it('response mode: absent additionalProperties opens the object', () => {
    const s = ok(
      convertSchema(
        { type: 'object', properties: { id: { type: 'string' } } },
        '3.1',
        0,
        'response',
      ),
    );
    expect(s.safeParse({ id: 'a', created: 1 }).success).toBe(true);
    expect(s.safeParse({ id: 1 }).success).toBe(false);
    const wire = z.toJSONSchema(s) as Record<string, unknown>;
    expect(wire['additionalProperties']).not.toBe(false);
  });

  it('response mode: an explicit additionalProperties:false stays closed', () => {
    const s = ok(
      convertSchema(
        { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
        '3.1',
        0,
        'response',
      ),
    );
    expect(s.safeParse({ id: 'a', created: 1 }).success).toBe(false);
  });

  it('response mode propagates to nested objects, array items and union members', () => {
    const s = ok(
      convertSchema(
        {
          type: 'object',
          properties: {
            owner: { type: 'object', properties: { id: { type: 'string' } } },
            items: {
              type: 'array',
              items: { type: 'object', properties: { n: { type: 'integer' } } },
            },
            pet: {
              oneOf: [
                { type: 'object', properties: { bark: { type: 'boolean' } }, required: ['bark'] },
                { type: 'object', properties: { meow: { type: 'boolean' } }, required: ['meow'] },
              ],
            },
            merged: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
          },
        },
        '3.1',
        0,
        'response',
      ),
    );
    expect(
      s.safeParse({
        owner: { id: 'o', extra: 1 },
        items: [{ n: 1, extra: 2 }],
        pet: { bark: true, extra: 3 },
        merged: { a: 'x', extra: 4 },
      }).success,
    ).toBe(true);
  });

  it('request mode: drops a readOnly property from the shape AND from required', () => {
    const s = ok(convertSchema(user));
    expect(s.safeParse({ name: 'x', password: 'p' }).success).toBe(true);
    // Sending the server-assigned id is rejected by the strict object.
    expect(s.safeParse({ id: '1', name: 'x', password: 'p' }).success).toBe(false);
    // writeOnly is a REQUEST property — still required in a request.
    expect(s.safeParse({ name: 'x' }).success).toBe(false);
    const wire = z.toJSONSchema(s) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(wire.properties)).toEqual(['name', 'password']);
    expect(wire.required).toEqual(['name', 'password']);
  });

  it('request mode: drops nested readOnly properties too', () => {
    const s = ok(
      convertSchema({ type: 'object', required: ['owner'], properties: { owner: user } }),
    );
    expect(s.safeParse({ owner: { name: 'x', password: 'p' } }).success).toBe(true);
    expect(s.safeParse({ owner: { id: '1', name: 'x', password: 'p' } }).success).toBe(false);
  });

  it('response mode: an open object drops a writeOnly property; readOnly stays required', () => {
    const s = ok(convertSchema(user, '3.1', 0, 'response'));
    expect(s.safeParse({ id: 'a', name: 'x' }).success).toBe(true);
    expect(s.safeParse({ name: 'x' }).success).toBe(false);
    // A server that does echo the writeOnly value is still schema-valid.
    expect(s.safeParse({ id: 'a', name: 'x', password: 'p' }).success).toBe(true);
    const wire = z.toJSONSchema(s) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(wire.properties)).toEqual(['id', 'name']);
    expect(wire.required).toEqual(['id', 'name']);
  });

  it('response mode: a closed object keeps a writeOnly property, optional, so an echo stays valid', () => {
    const s = ok(convertSchema({ ...user, additionalProperties: false }, '3.1', 0, 'response'));
    expect(s.safeParse({ id: 'a', name: 'x' }).success).toBe(true);
    expect(s.safeParse({ id: 'a', name: 'x', password: 'p' }).success).toBe(true);
    expect(s.safeParse({ id: 'a', name: 'x', password: 1 }).success).toBe(false);
    const wire = z.toJSONSchema(s) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(wire.properties)).toEqual(['id', 'name', 'password']);
    expect(wire.required).toEqual(['id', 'name']);
  });

  it('request mode: a readOnly property inside an allOf member is dropped as well', () => {
    const s = ok(
      convertSchema({
        allOf: [
          {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', readOnly: true } },
          },
          { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        ],
      }),
    );
    expect(s.safeParse({ name: 'x' }).success).toBe(true);
    expect(s.safeParse({ id: '1', name: 'x' }).success).toBe(false);
  });
});

// #39 / D11: a response `pattern` with nested quantifiers is unrepresentable.
describe('convertSchema — response pattern safety (#39)', () => {
  it('response mode: a nested-quantifier pattern is unrepresentable', () => {
    const result = convertSchema(
      { type: 'object', properties: { v: { type: 'string', pattern: '^(a+)+$' } } },
      '3.1',
      0,
      'response',
    );
    expect(result).toEqual({
      unrepresentable: `property "v": ${UNSAFE_PATTERN_REASON}`,
    });
  });

  it('request mode keeps advertising the same pattern (never executed there)', () => {
    const s = ok(convertSchema({ type: 'string', pattern: '^(a+)+$' }));
    expect((z.toJSONSchema(s) as Record<string, unknown>)['pattern']).toBe('^(a+)+$');
  });

  it('response mode: an ordinary pattern is still advertised', () => {
    const s = ok(
      convertSchema(
        { type: 'string', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' },
        '3.1',
        0,
        'response',
      ),
    );
    expect((z.toJSONSchema(s) as Record<string, unknown>)['pattern']).toBe(
      '^(\\d{1,3}\\.){3}\\d{1,3}$',
    );
  });
});

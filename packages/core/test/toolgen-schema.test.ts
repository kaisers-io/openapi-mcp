import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { convertSchema, MAX_CONVERT_DEPTH, type SchemaResult } from '../src/index.ts';

const ok = (r: SchemaResult): z.ZodType => {
  if (!('ok' in r)) throw new Error(`expected ok, got unrepresentable: ${r.unrepresentable}`);
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
    // is malformed for the dialect and omits (round-12 fail-closed decision).
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
    // Non-unique enum is malformed (meta-schema uniqueItems); omit (fail-closed,
    // round-13), consistent with the type/required uniqueness gates.
    expect('unrepresentable' in convertSchema({ enum: ['a', 'a'] })).toBe(true);
    expect('unrepresentable' in convertSchema({ enum: [1, 1] })).toBe(true);
    expect('ok' in convertSchema({ enum: ['a', 'b'] })).toBe(true);
  });

  it('omits a non-finite enum or const number (NaN/Infinity are not valid JSON)', () => {
    // YAML 1.2 parses `.nan`/`.inf` to NaN/Infinity; z.literal(NaN) would validate NaN
    // while z.toJSONSchema emits const:null — a wire/validator divergence. Omit
    // (fail-closed, round-14). Build the values numerically (no raw literals).
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

  it('omits a type array with duplicate entries', () => {
    // JSON Schema requires unique `type` elements; a duplicate omits even though it
    // would collapse to a valid shape (fail-closed, round-13). The accepted unique
    // [T,'null'] normalization is unaffected.
    expect('unrepresentable' in convertSchema({ type: ['null', 'null'] })).toBe(true);
    expect('unrepresentable' in convertSchema({ type: ['string', 'null', 'null'] })).toBe(true);
    expect(ok(convertSchema({ type: ['string', 'null'] })).safeParse(null).success).toBe(true);
  });

  it('preserves integer-ness through a [type, null] union (does not widen to number)', () => {
    // numberSchema must read the NORMALIZED type, not node.type: for
    // type:['integer','null'] node.type is the array, so a naive `node.type ===
    // 'integer'` widens to a plain number that accepts 1.5. The nullable integer must
    // still reject 1.5 (round-14).
    const s = ok(convertSchema({ type: ['integer', 'null'] }, '3.1'));
    expect(s.safeParse(1).success).toBe(true);
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse(1.5).success).toBe(false);
    // The single-element array form normalizes the same way.
    expect(ok(convertSchema({ type: ['integer'] })).safeParse(1.5).success).toBe(false);
  });

  // The `required` element/uniqueness gate (also in malformedKeyword) can only be
  // FALSIFIED against the object path, which is a placeholder at Task 1 — so the
  // test + falsification live in Task 2 (`omits a required array …`), like the
  // nullable-composition guard. malformedKeyword still runs at Task 1; it just
  // cannot be distinguished from the placeholder here.

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
    // would leave the number unconstrained (a widening) — omit instead (round-13).
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
    // (representable) oneOf, so this test would wrongly expect unrepresentable. Do
    // NOT assert the 3.1-representable case here: at Task 1 the convertComposite
    // placeholder returns unrepresentable for ANY composite regardless of version,
    // so only the 3.0 guard path is stable across Task 1 and Task 2.
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

  it('exports the depth budget (structural depth is falsified in Task 2)', () => {
    // A real recursive-depth test needs the array branch (Task 2); at Task 1 only
    // assert the budget is exported. Do not build a Task-1 node that cannot bind.
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

import { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';

// Structural nesting guard, tied to the existing parse-depth budget (spec §4.1)
// — not a new budget. The document is already dereferenced (cycle-safe) upstream,
// so this only backstops pathological depth.
export const MAX_CONVERT_DEPTH = SPEC_BUDGETS.maxParseDepth;

export type SchemaResult = { ok: z.ZodType } | { unrepresentable: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Field names that corrupt a plain-object accumulator (`obj[name] = …`) or that
// Zod's object model cannot faithfully represent (a `__proto__` key is dropped
// by z.strictObject). Any tool field or nested property with one of these names
// omits the operation (fail-closed) — verified: z.strictObject cannot carry a
// `__proto__` field, and `obj['__proto__'] = x` on a `{}` literal creates no own
// key, so the field would silently vanish.
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const isDangerousKey = (name: string): boolean => DANGEROUS_KEYS.has(name);

// The frozen OpenAPI validator does NOT validate Schema Object keyword VALUES
// (the 3.1 meta-schema accepts `minLength:"wrong"`, `enum:"wrong"`, …). The
// converter would then silently ignore the malformed value and emit an
// unconstrained schema — a widening. Gate every keyword we enforce to its value
// domain; a malformed value omits the operation (fail-closed, owner decision
// 2026-07-23). `version` gates the exclusive-bound FORM: OAS 3.0 uses the boolean
// modifier, 3.1/JSON-Schema-2020-12 the numeric form; a wrong-version form is
// malformed and omits (owner decision 2026-07-23, round 12). Returns the
// offending keyword, or undefined.
const nonNegInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

const malformedKeyword = (
  node: Record<string, unknown>,
  version: OpenapiVersion,
): string | undefined => {
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (k in node && !nonNegInt(node[k])) {
      return k;
    }
  }
  for (const k of ['minimum', 'maximum']) {
    if (k in node && !finite(node[k])) {
      return k;
    }
  }
  for (const k of ['exclusiveMinimum', 'exclusiveMaximum']) {
    // Version-gated: 3.1 uses the numeric form; 3.0/draft-4 uses the boolean
    // modifier form, which per draft-4 REQUIRES its paired `minimum`/`maximum`.
    // A wrong-version form (numeric under 3.0, boolean under 3.1) OR a 3.0 boolean
    // bound with no pair is malformed and omits (fail-closed) rather than being
    // silently reinterpreted or ignored. A pairless boolean would leave the number
    // unconstrained — a silent widening (round-13 review).
    if (k in node) {
      const pair = k === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      const wellFormed =
        version === '3.0' ? typeof node[k] === 'boolean' && pair in node : finite(node[k]);
      if (!wellFormed) {
        return k;
      }
    }
  }
  if (
    'multipleOf' in node &&
    (!finite(node['multipleOf']) || (node['multipleOf'] as number) <= 0)
  ) {
    return 'multipleOf';
  }
  if ('pattern' in node && typeof node['pattern'] !== 'string') {
    return 'pattern';
  }
  if ('format' in node && typeof node['format'] !== 'string') {
    return 'format';
  }
  for (const k of ['enum', 'allOf', 'oneOf', 'anyOf', 'required']) {
    if (k in node && !Array.isArray(node[k])) {
      return k;
    }
  }
  // `required` must be an array of UNIQUE strings (JSON Schema meta-schema
  // `items:{type:string}` + `uniqueItems:true`). A non-string element or a
  // duplicate is a malformed value → omit (fail-closed). Merely FILTERING the
  // non-strings, as objectSchema/bodyFields would, silently accepts an invalid
  // Schema Object — the fail-open the round-12 review caught.
  if (Array.isArray(node['required'])) {
    const req = node['required'];
    if (!req.every((k) => typeof k === 'string') || new Set(req).size !== req.length) {
      return 'required';
    }
  }
  if ('properties' in node && !isRecord(node['properties'])) {
    return 'properties';
  }
  if ('items' in node && node['items'] !== undefined && !isRecord(node['items'])) {
    return 'items';
  }
  return undefined;
};

// Every schema keyword the converter is aware of. A node carrying ANY other
// keyword (uniqueItems, contains, not, if/then/else, patternProperties,
// prefixItems, minProperties, dependentSchemas, $ref, ...) is a profile
// violation → the operation is omitted (fail-closed). Vendor `x-*` extensions
// are always allowed. Unlike hey-api (unknown keyword → z.unknown()), we refuse.
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'allOf',
  'oneOf',
  'anyOf',
  'nullable',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'additionalProperties',
  // Benign metadata (no validation effect):
  'title',
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  '$comment',
  '$schema',
  'discriminator',
]);

const unknownKeyword = (node: Record<string, unknown>): string | undefined => {
  for (const key of Object.keys(node)) {
    if (!key.startsWith('x-') && !KNOWN_KEYWORDS.has(key)) {
      return key;
    }
  }
  return undefined;
};

// A "shape-determiner" fixes the whole shape; the branches that handle it do not
// honor sibling assertion keywords, so combining one with any sibling constraint
// would silently drop that constraint (widening). Fail closed instead.
const SHAPE_DETERMINERS = ['const', 'enum', 'allOf', 'oneOf', 'anyOf'] as const;

// Enforced assertion keywords a shape-determiner branch would silently drop.
// `pattern` AND `format` are excluded — both are advertised, not enforced
// (decision A / the 2026-07-23 format decision), so they never narrow and
// combining them with a determiner introduces no widening.
const ASSERTION_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'additionalProperties',
]);

const valueMatchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'string': {
      return typeof value === 'string';
    }
    case 'number': {
      return typeof value === 'number';
    }
    case 'integer': {
      return typeof value === 'number' && Number.isInteger(value);
    }
    case 'boolean': {
      return typeof value === 'boolean';
    }
    case 'null': {
      return value === null;
    }
    case 'array': {
      return Array.isArray(value);
    }
    case 'object': {
      return isRecord(value);
    }
    default: {
      return false;
    }
  }
};

const conflictingCombination = (node: Record<string, unknown>): string | undefined => {
  const determiners = SHAPE_DETERMINERS.filter((k) => node[k] !== undefined);
  if (determiners.length > 1) {
    return `multiple shape-determining keywords (${determiners.join(', ')})`;
  }
  if (determiners.length === 0) {
    return undefined;
  }
  const determiner = determiners[0] as (typeof SHAPE_DETERMINERS)[number];
  const extra = Object.keys(node).find((k) => ASSERTION_KEYWORDS.has(k));
  if (extra !== undefined) {
    return `"${determiner}" combined with the sibling constraint "${extra}"`;
  }
  // A sibling `type` narrows the determiner but the branches ignore it, so verify
  // compatibility (enum/const values match the type, allOf is an object) or omit.
  const { type } = node;
  if (type === undefined) {
    return undefined;
  }
  if (typeof type !== 'string') {
    return `"${determiner}" combined with a multi-type "type"`;
  }
  if (determiner === 'enum') {
    const values = Array.isArray(node['enum']) ? node['enum'] : [];
    return values.every((v) => valueMatchesType(v, type))
      ? undefined
      : `"enum" values incompatible with the sibling type "${type}"`;
  }
  if (determiner === 'const') {
    return valueMatchesType(node['const'], type)
      ? undefined
      : `"const" incompatible with the sibling type "${type}"`;
  }
  if (determiner === 'allOf') {
    return type === 'object' ? undefined : `"allOf" combined with a non-object type "${type}"`;
  }
  // oneOf / anyOf + type: cannot faithfully intersect the type across branches.
  return `"${determiner}" combined with a sibling "type"`;
};

// Property descriptions in the dereferenced document are raw; sanitized here
// before entering model context via .describe() (spec §6.4). `format` and
// `pattern` are surfaced through the wire schema (via .meta in convertSchema),
// not here; enum values surface through z.enum. So the human hint is the
// description plus example only.
const describeText = (node: Record<string, unknown>): string | undefined => {
  const parts: string[] = [];
  if (typeof node['description'] === 'string') {
    parts.push(node['description']);
  }
  if (node['example'] !== undefined) {
    parts.push(`example: ${JSON.stringify(node['example'])}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const text = sanitizeSpecText(parts.join(' — '), SPEC_BUDGETS.maxTextLength);
  return text === '' ? undefined : text;
};

const withDescription = (schema: z.ZodType, node: Record<string, unknown>): z.ZodType => {
  const text = describeText(node);
  return text === undefined ? schema : schema.describe(text);
};

const stringSchema = (node: Record<string, unknown>): SchemaResult => {
  // `format` and `pattern` are advertised via .meta in convertSchema (advertise,
  // not enforce). Length IS enforced here, but by CODE POINT, not Zod's UTF-16
  // `.min`/`.max`: `z.string().min(2)` accepts "😀" (JS length 2) even though JSON
  // Schema counts one character, so `.min` would silently ACCEPT an invalid value
  // (widening). A code-point refinement counts correctly; `minLength`/`maxLength`
  // are advertised into the wire via .meta in convertSchema.
  let s: z.ZodType = z.string();
  const min = node['minLength'];
  const max = node['maxLength'];
  if (typeof min === 'number') {
    s = s.refine((v) => [...(v as string)].length >= min, {
      message: `must be at least ${min} character(s)`,
    });
  }
  if (typeof max === 'number') {
    s = s.refine((v) => [...(v as string)].length <= max, {
      message: `must be at most ${max} character(s)`,
    });
  }
  return { ok: s };
};

const numberSchema = (node: Record<string, unknown>, isInteger: boolean): z.ZodType => {
  // Use the NORMALIZED integer-ness, not node['type']: for a `[type,'null']` union
  // (or any array form) node['type'] is the array, so `node['type'] === 'integer'`
  // is false and `type:['integer','null']` would WIDEN to a plain number that
  // accepts 1.5 (round-14 review). buildTyped passes the resolved typeValue.
  let base = isInteger ? z.number().int() : z.number();
  const exclMin = node['exclusiveMinimum'];
  const exclMax = node['exclusiveMaximum'];
  if (typeof node['minimum'] === 'number') {
    base = exclMin === true ? base.gt(node['minimum']) : base.min(node['minimum']);
  }
  if (typeof exclMin === 'number') {
    base = base.gt(exclMin);
  }
  if (typeof node['maximum'] === 'number') {
    base = exclMax === true ? base.lt(node['maximum']) : base.max(node['maximum']);
  }
  if (typeof exclMax === 'number') {
    base = base.lt(exclMax);
  }
  const { multipleOf } = node;
  if (typeof multipleOf === 'number' && multipleOf !== 0) {
    // Zod's `.multipleOf` uses an epsilon float comparison that WIDENS. Enforce with
    // the REMAINDER, not `Number.isInteger(v / m)`: for a large `v` (e.g. 1e20,
    // multipleOf 3) `v / m` exceeds 2^53, so every quotient is an integer-valued
    // double and `Number.isInteger` wrongly ACCEPTS — a widening (round-15 review,
    // verified on Node: `Number.isInteger(1e20/3)` is true but `1e20 % 3` is 1).
    // `v % m === 0` uses IEEE fmod, which is EXACT for integer `m` at any magnitude
    // and a narrowing (fail-safe) for float `m` where the remainder is imprecise.
    // multipleOf is advertised via .meta in convertSchema.
    return base.refine((v) => v % multipleOf === 0, {
      message: `must be a multiple of ${multipleOf}`,
    });
  }
  return base;
};

const constSchema = (value: unknown): SchemaResult => {
  if (value === null) {
    return { ok: z.null() };
  }
  // A non-finite number (NaN/Infinity — YAML 1.2 parses `.nan`/`.inf`, and the
  // frozen validator accepts them) is not a valid JSON value: z.literal(NaN) would
  // validate NaN while z.toJSONSchema emits `const: null`, a wire/validator
  // divergence. Omit (fail-closed, round-14).
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { unrepresentable: 'a non-finite const number' };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { ok: z.literal(value) };
  }
  return { unrepresentable: 'a non-primitive const' };
};

const enumSchema = (values: readonly unknown[]): SchemaResult => {
  for (const value of values) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      return { unrepresentable: 'an enum with a non-primitive value' };
    }
    // A non-finite number (NaN/Infinity via YAML 1.2 `.nan`/`.inf`) is not valid
    // JSON: z.literal(NaN) validates NaN while z.toJSONSchema emits `const: null`.
    // Omit (fail-closed, round-14), matching constSchema.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { unrepresentable: 'an enum with a non-finite number' };
    }
  }
  if (values.length === 0) {
    return { unrepresentable: 'an empty enum' };
  }
  // JSON Schema requires unique enum values (meta-schema `uniqueItems:true`). All
  // members are primitives (checked above), so SameValueZero identity via Set is
  // exact; a duplicate is malformed and omits (fail-closed, round-13), consistent
  // with the `type`/`required` uniqueness gates.
  if (new Set(values).size !== values.length) {
    return { unrepresentable: 'an enum with duplicate values' };
  }
  if (values.every((v) => typeof v === 'string')) {
    return { ok: z.enum(values as [string, ...string[]]) };
  }
  const members = values.map((v) =>
    v === null ? z.null() : z.literal(v as string | number | boolean),
  );
  if (members.length === 1) {
    return { ok: members[0] as z.ZodType };
  }
  return { ok: z.union(members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) };
};

// Composite branches (object/array/allOf/oneOf/anyOf) are added in Task 2.
const convertComposite = (
  _node: Record<string, unknown>,
  _depth: number,
  _version: OpenapiVersion,
): SchemaResult => ({
  unrepresentable: 'an unsupported composite schema',
});

// The scalar/object/array dispatch. A sibling `nullable` wraps THIS result (a
// nullable string/object/array is faithful); determiners are handled separately
// in build because a `.nullable()` wrapper around an enum/const/composition would
// admit null the enumerated values or members exclude.
const buildTyped = (
  typeValue: unknown,
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  if (typeValue === 'null') {
    return { ok: z.null() };
  }
  if (typeValue === 'string') {
    return stringSchema(node);
  }
  if (typeValue === 'number' || typeValue === 'integer') {
    return { ok: numberSchema(node, typeValue === 'integer') };
  }
  if (typeValue === 'boolean') {
    return { ok: z.boolean() };
  }
  if (typeValue === 'array' || typeValue === 'object') {
    // Pass the NORMALIZED type so convertComposite's array/object split is correct
    // even when the source used a `[type,'null']` union (typeValue is the non-null
    // member). Without this, `type:['array','null']` would be misdispatched as an
    // object — accepting `{}`/null and rejecting valid arrays.
    return convertComposite({ ...node, type: typeValue }, depth, version);
  }
  if (isRecord(node['properties']) && Object.keys(node['properties']).length > 0) {
    // A typeless node with NON-EMPTY properties is treated as an object (the common
    // authoring intent). An EMPTY `properties: {}` carries no constraint and must
    // not narrow to strictObject({}) — it falls through to the typeless-orphan
    // check below, which omits (properties is an assertion keyword).
    return convertComposite(node, depth, version);
  }
  if (typeValue === undefined) {
    // A typeless node carrying an assertion we cannot attach to a type must not
    // widen to `unknown` — omit. (Object roots via `properties` already routed
    // above; a bare `{}` or a description-only node stays `unknown`.)
    const orphan = Object.keys(node).find((k) => ASSERTION_KEYWORDS.has(k));
    return orphan === undefined
      ? { ok: z.unknown() }
      : { unrepresentable: `the constraint "${orphan}" on a typeless schema` };
  }
  return { unrepresentable: `the unsupported type "${String(typeValue)}"` };
};

const build = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  const rawType = node['type'];
  // `nullable` is a 3.0-only keyword. In 3.1 it is not a JSON Schema keyword —
  // honouring it there would ADMIT null the standard 3.1 dialect excludes
  // (widening). 3.1 nullability comes only from a `[type, 'null']` union below.
  let nullable = version === '3.0' && node['nullable'] === true;
  let typeValue: unknown = rawType;
  if (Array.isArray(rawType)) {
    // JSON Schema requires `type` array elements to be UNIQUE. A duplicate (e.g.
    // ['null','null'] or ['string','null','null']) is malformed and omits, even
    // though it would collapse to a valid single-or-null shape (fail-closed,
    // round-13). The accepted unique `[T,'null']` normalization is unaffected.
    if (new Set(rawType).size !== rawType.length) {
      return { unrepresentable: 'a "type" array with duplicate entries' };
    }
    const nonNull = rawType.filter((t) => t !== 'null');
    if (rawType.includes('null')) {
      nullable = true;
    }
    if (nonNull.length === 0) {
      // `['null']` (or repeated 'null') is the pure-null type. An EMPTY `type: []`
      // array is degenerate (unsatisfiable — it matches no type) and must omit,
      // not silently become `z.null()` (fail-closed, round-12 review).
      return rawType.includes('null')
        ? { ok: z.null() }
        : { unrepresentable: 'an empty "type" array' };
    }
    if (nonNull.length !== 1) {
      return { unrepresentable: 'a multi-type schema beyond [type, null]' };
    }
    [typeValue] = nonNull;
  }
  // Determiners carry their own nullability through the enumerated values or
  // members — a `.nullable()` wrapper would admit null they exclude (OAS 3.0:
  // other constraints may disallow null). const/enum therefore IGNORE a sibling
  // `nullable` (null is allowed only if it is itself an enumerated value); a
  // nullable composition is not faithfully representable and omits.
  if ('const' in node && node['const'] !== undefined) {
    return constSchema(node['const']);
  }
  if (Array.isArray(node['enum'])) {
    return enumSchema(node['enum']);
  }
  if (
    Array.isArray(node['allOf']) ||
    Array.isArray(node['oneOf']) ||
    Array.isArray(node['anyOf'])
  ) {
    if (nullable) {
      return { unrepresentable: 'a nullable composition (allOf/oneOf/anyOf combined with null)' };
    }
    return convertComposite(node, depth, version);
  }
  const base = buildTyped(typeValue, node, depth, version);
  if (!('ok' in base)) {
    return base;
  }
  return nullable ? { ok: base.ok.nullable() } : base;
};

export const convertSchema = (
  node: unknown,
  version: OpenapiVersion = '3.1',
  depth = 0,
): SchemaResult => {
  if (depth > MAX_CONVERT_DEPTH) {
    return { unrepresentable: 'schema nesting exceeds the depth budget' };
  }
  if (!isRecord(node)) {
    return { unrepresentable: 'a non-object schema node' };
  }
  const bad = unknownKeyword(node);
  if (bad !== undefined) {
    return { unrepresentable: `the unsupported keyword "${bad}"` };
  }
  const malformed = malformedKeyword(node, version);
  if (malformed !== undefined) {
    return { unrepresentable: `a malformed "${malformed}" value` };
  }
  const conflict = conflictingCombination(node);
  if (conflict !== undefined) {
    return { unrepresentable: conflict };
  }
  const built = build(node, depth, version);
  if (!('ok' in built)) {
    return built;
  }
  // Advertise `pattern` and `format` uniformly (decision A / 2026-07-23 format
  // decision): attach them as wire metadata on whatever the branch produced —
  // string, enum, const, composite, or a typeless z.unknown() — so z.toJSONSchema
  // emits the keywords WITHOUT enforcing them (no live RegExp; no divergent format
  // validator). The model sees them; validation never runs them.
  const meta: Record<string, unknown> = {};
  if (typeof node['pattern'] === 'string') {
    meta['pattern'] = node['pattern'];
  }
  if (typeof node['format'] === 'string') {
    meta['format'] = node['format'];
  }
  // String length and numeric multipleOf are ENFORCED exactly by code point /
  // exact division in stringSchema/numberSchema (via .refine, opaque to
  // z.toJSONSchema), so the wire keywords are advertised here.
  if (typeof node['minLength'] === 'number') {
    meta['minLength'] = node['minLength'];
  }
  if (typeof node['maxLength'] === 'number') {
    meta['maxLength'] = node['maxLength'];
  }
  if (typeof node['multipleOf'] === 'number') {
    meta['multipleOf'] = node['multipleOf'];
  }
  const advertised = Object.keys(meta).length > 0 ? built.ok.meta(meta) : built.ok;
  return { ok: withDescription(advertised, node) };
};

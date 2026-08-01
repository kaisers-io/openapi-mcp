import { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';

// Structural nesting guard, tied to the existing parse-depth budget — not a new
// budget. The document is already dereferenced (cycle-safe) upstream, so this
// only backstops pathological depth.
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
// domain; a malformed value omits the operation (fail-closed). `version` gates
// the exclusive-bound FORM: OAS 3.0 uses the boolean modifier, 3.1/
// JSON-Schema-2020-12 the numeric form; a wrong-version form is malformed and
// omits (fail-closed). Returns the offending keyword, or undefined.
const nonNegInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

const malformedKeyword = (
  node: Record<string, unknown>,
  version: OpenapiVersion,
): string | undefined => {
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (keyword in node && !nonNegInt(node[keyword])) {
      return keyword;
    }
  }
  for (const keyword of ['minimum', 'maximum']) {
    if (keyword in node && !finite(node[keyword])) {
      return keyword;
    }
  }
  for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum']) {
    // Version-gated: 3.1 uses the numeric form; 3.0/draft-4 uses the boolean
    // modifier form, which per draft-4 REQUIRES its paired `minimum`/`maximum`.
    // A wrong-version form (numeric under 3.0, boolean under 3.1) OR a 3.0 boolean
    // bound with no pair is malformed and omits (fail-closed) rather than being
    // silently reinterpreted or ignored. A pairless boolean would leave the number
    // unconstrained — a silent widening.
    if (keyword in node) {
      const pair = keyword === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      const wellFormed =
        version === '3.0'
          ? typeof node[keyword] === 'boolean' && pair in node
          : finite(node[keyword]);
      if (!wellFormed) {
        return keyword;
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
  for (const keyword of ['enum', 'allOf', 'oneOf', 'anyOf', 'required']) {
    if (keyword in node && !Array.isArray(node[keyword])) {
      return keyword;
    }
  }
  // `required` must be an array of UNIQUE strings (JSON Schema meta-schema
  // `items:{type:string}` + `uniqueItems:true`). A non-string element or a
  // duplicate is a malformed value → omit (fail-closed). Merely FILTERING the
  // non-strings, as objectSchema/bodyFields would, silently accepts an invalid
  // Schema Object — a fail-open this gate exists to prevent.
  if (Array.isArray(node['required'])) {
    const req = node['required'];
    if (!req.every((name) => typeof name === 'string') || new Set(req).size !== req.length) {
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
// `pattern` AND `format` are excluded — both are advertised, not enforced, so
// they never narrow and combining them with a determiner introduces no
// widening.
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
  const determiners = SHAPE_DETERMINERS.filter((keyword) => node[keyword] !== undefined);
  if (determiners.length > 1) {
    return `multiple shape-determining keywords (${determiners.join(', ')})`;
  }
  if (determiners.length === 0) {
    return undefined;
  }
  const determiner = determiners[0] as (typeof SHAPE_DETERMINERS)[number];
  const extra = Object.keys(node).find((keyword) => ASSERTION_KEYWORDS.has(keyword));
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
    return values.every((value) => valueMatchesType(value, type))
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
// before entering model context via .describe(). `format` and
// `pattern` are surfaced through the wire schema (via .meta in convertSchema),
// not here; enum values surface through z.enum. So the human hint is the
// description plus example only.
const describeText = (node: Record<string, unknown>): string | undefined => {
  const parts = [
    typeof node['description'] === 'string' ? node['description'] : undefined,
    node['example'] === undefined ? undefined : `example: ${JSON.stringify(node['example'])}`,
  ].filter((part): part is string => part !== undefined);
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
  const base: z.ZodType = z.string();
  const min = node['minLength'];
  const max = node['maxLength'];
  const withMin =
    typeof min === 'number'
      ? base.refine((value) => [...(value as string)].length >= min, {
          message: `must be at least ${min} character(s)`,
        })
      : base;
  const withMax =
    typeof max === 'number'
      ? withMin.refine((value) => [...(value as string)].length <= max, {
          message: `must be at most ${max} character(s)`,
        })
      : withMin;
  return { ok: withMax };
};

// 3.0's boolean exclusiveMinimum/exclusiveMaximum modifies the paired
// minimum/maximum bound rather than standing alone (see malformedKeyword's
// version-gated pairing check) — these two helpers apply that modifier.
const applyLowerBound = (base: z.ZodNumber, bound: number, exclusive: boolean): z.ZodNumber =>
  exclusive ? base.gt(bound) : base.min(bound);

const applyUpperBound = (base: z.ZodNumber, bound: number, exclusive: boolean): z.ZodNumber =>
  exclusive ? base.lt(bound) : base.max(bound);

const numberSchema = (node: Record<string, unknown>, isInteger: boolean): z.ZodType => {
  // Use the NORMALIZED integer-ness, not node['type']: for a `[type,'null']` union
  // (or any array form) node['type'] is the array, so `node['type'] === 'integer'`
  // is false and `type:['integer','null']` would WIDEN to a plain number that
  // accepts 1.5. buildTyped passes the resolved typeValue.
  const base = isInteger ? z.number().int() : z.number();
  const exclMin = node['exclusiveMinimum'];
  const exclMax = node['exclusiveMaximum'];
  const { minimum, maximum } = node;
  const withMin =
    typeof minimum === 'number' ? applyLowerBound(base, minimum, exclMin === true) : base;
  const withExclMin = typeof exclMin === 'number' ? withMin.gt(exclMin) : withMin;
  const withMax =
    typeof maximum === 'number'
      ? applyUpperBound(withExclMin, maximum, exclMax === true)
      : withExclMin;
  const withExclMax = typeof exclMax === 'number' ? withMax.lt(exclMax) : withMax;
  const { multipleOf } = node;
  if (typeof multipleOf === 'number' && multipleOf !== 0) {
    // Zod's `.multipleOf` uses an epsilon float comparison that WIDENS. Enforce with
    // the REMAINDER, not `Number.isInteger(v / m)`: for a large `v` (e.g. 1e20,
    // multipleOf 3) `v / m` exceeds 2^53, so every quotient is an integer-valued
    // double and `Number.isInteger` wrongly ACCEPTS — a widening (e.g.
    // `Number.isInteger(1e20/3)` is true but `1e20 % 3` is 1).
    // `v % m === 0` uses IEEE fmod, which is EXACT for integer `m` at any magnitude
    // and a narrowing (fail-safe) for float `m` where the remainder is imprecise.
    // multipleOf is advertised via .meta in convertSchema.
    return withExclMax.refine((value) => value % multipleOf === 0, {
      message: `must be a multiple of ${multipleOf}`,
    });
  }
  return withExclMax;
};

const constSchema = (value: unknown): SchemaResult => {
  if (value === null) {
    return { ok: z.null() };
  }
  // A non-finite number (NaN/Infinity — YAML 1.2 parses `.nan`/`.inf`, and the
  // frozen validator accepts them) is not a valid JSON value: z.literal(NaN) would
  // validate NaN while z.toJSONSchema emits `const: null`, a wire/validator
  // divergence. Omit (fail-closed).
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
    // Omit (fail-closed), matching constSchema.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { unrepresentable: 'an enum with a non-finite number' };
    }
  }
  if (values.length === 0) {
    return { unrepresentable: 'an empty enum' };
  }
  // JSON Schema requires unique enum values (meta-schema `uniqueItems:true`). All
  // members are primitives (checked above), so SameValueZero identity via Set is
  // exact; a duplicate is malformed and omits (fail-closed), consistent
  // with the `type`/`required` uniqueness gates.
  if (new Set(values).size !== values.length) {
    return { unrepresentable: 'an enum with duplicate values' };
  }
  if (values.every((value) => typeof value === 'string')) {
    return { ok: z.enum(values as [string, ...string[]]) };
  }
  const members = values.map((value) =>
    value === null ? z.null() : z.literal(value as string | number | boolean),
  );
  if (members.length === 1) {
    return { ok: members[0] as z.ZodType };
  }
  return { ok: z.union(members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) };
};

// allOf members may carry only object-schema keywords (no combinators/not/etc);
// a member outside this set, a non-object member, or an overlapping property name
// omits the operation (a strict tool cannot faithfully intersect strict objects,
// unlike hey-api's loose z.intersection).
const ALLOF_MEMBER_KEYS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  'example',
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

// Merges every allOf member (any count) into one object schema. Each member must
// be an object; a member declaring additionalProperties (false/true/schema) omits
// the operation (false would forbid the other members' properties; true/schema
// would need cross-member intersection). The `isDangerousKey` check must precede
// the plain-object assignment, or a `__proto__` property would pollute the
// accumulator and vanish before objectSchema could reject it.
const mergeAllOf = (
  parts: readonly unknown[],
): Record<string, unknown> | { unrepresentable: string } => {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const seen = new Set<string>();
  // Imperative on purpose: any single non-conforming allOf member (wrong
  // keyword, non-object, malformed `required`, overlapping property name)
  // aborts the WHOLE merge (fail-closed) before later members are even
  // inspected — `parts` is spec-controlled (a hostile document can declare
  // arbitrarily many allOf members). `seen`/`properties`/`required`
  // accumulate across members in encounter order, so a member's overlap
  // check depends on every prior member having already run; a map/filter
  // restatement would need the same shared, order-dependent state.
  for (const part of parts) {
    if (!isRecord(part)) {
      return { unrepresentable: 'an allOf member that is not an object schema' };
    }
    for (const key of Object.keys(part)) {
      if (!key.startsWith('x-') && !ALLOF_MEMBER_KEYS.has(key)) {
        return { unrepresentable: `an allOf member using "${key}"` };
      }
    }
    if (part['type'] !== undefined && part['type'] !== 'object') {
      return { unrepresentable: 'an allOf member that is not an object' };
    }
    // mergeAllOf processes members structurally WITHOUT running convertSchema on
    // them, so it must re-apply the value-domain gates a member would otherwise get:
    // a non-record `properties`, or a `required` that is not an array of UNIQUE
    // strings, omits (fail-closed) — otherwise a malformed member (e.g.
    // `properties:'wrong'` or `required:[123]`) would be silently skipped/filtered.
    if (part['properties'] !== undefined && !isRecord(part['properties'])) {
      return { unrepresentable: 'an allOf member with a non-record "properties"' };
    }
    if (
      part['required'] !== undefined &&
      (!Array.isArray(part['required']) ||
        !part['required'].every((name) => typeof name === 'string') ||
        new Set(part['required']).size !== part['required'].length)
    ) {
      return { unrepresentable: 'an allOf member with a malformed "required" array' };
    }
    // A member must carry object evidence; an empty or metadata-only member
    // (`{}`, `{description:…}`, `{properties:{}}`, 3.1 `{required:[]}`) accepts any
    // value, so merging it as a strict object would narrow the composition. Empty
    // `properties`/`required` are NOT evidence — only an explicit `type:'object'`
    // or a NON-empty properties/required set (object keywords do not implicitly
    // constrain the instance type in JSON Schema / OAS 3.1).
    const hasObjectEvidence =
      part['type'] === 'object' ||
      (isRecord(part['properties']) && Object.keys(part['properties']).length > 0) ||
      (Array.isArray(part['required']) && part['required'].length > 0);
    if (!hasObjectEvidence) {
      return {
        unrepresentable: 'an allOf member with no object evidence (empty or metadata-only)',
      };
    }
    if (part['additionalProperties'] !== undefined) {
      return { unrepresentable: 'a multi-member allOf whose member declares additionalProperties' };
    }
    if (isRecord(part['properties'])) {
      for (const [key, child] of Object.entries(part['properties'])) {
        if (isDangerousKey(key)) {
          return { unrepresentable: `an allOf property named "${key}"` };
        }
        if (seen.has(key)) {
          return { unrepresentable: `an allOf with the overlapping property "${key}"` };
        }
        seen.add(key);
        properties[key] = child;
      }
    }
    if (Array.isArray(part['required'])) {
      for (const key of part['required']) {
        if (typeof key === 'string') {
          required.add(key);
        }
      }
    }
  }
  return { type: 'object', properties, required: [...required] };
};

const objectSchema = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  const properties = isRecord(node['properties']) ? node['properties'] : {};
  const required = new Set(
    Array.isArray(node['required'])
      ? node['required'].filter((name): name is string => typeof name === 'string')
      : [],
  );
  const shape: Record<string, z.ZodType> = {};
  // Imperative on purpose: any single dangerous-key or unrepresentable
  // property aborts the WHOLE object (fail-closed) before later properties
  // are even converted. `properties` is spec-controlled (a hostile document
  // can declare many properties, each with a deeply nested schema) —
  // converting every property first and checking afterward would turn this
  // short-circuit into forced recursive conversion work for every property
  // on hostile input, even past the first failure.
  for (const [key, child] of Object.entries(properties)) {
    if (isDangerousKey(key)) {
      return { unrepresentable: `a property named "${key}"` };
    }
    const conv = convertSchema(child, version, depth + 1);
    if (!('ok' in conv)) {
      return { unrepresentable: `property "${key}": ${conv.unrepresentable}` };
    }
    shape[key] = required.has(key) ? conv.ok : conv.ok.optional();
  }
  // A required name with no declared property cannot be enforced (there is no
  // schema for it) — omit rather than silently accept its absence. Object.hasOwn,
  // not `in`, so an inherited name like `toString` is not treated as declared.
  for (const name of required) {
    if (!Object.hasOwn(shape, name)) {
      return { unrepresentable: `the required property "${name}" is not declared in properties` };
    }
  }
  const ap = node['additionalProperties'];
  if (ap === undefined || ap === false) {
    return { ok: z.strictObject(shape) };
  }
  if (ap === true) {
    return { ok: z.object(shape).loose() };
  }
  const apConv = convertSchema(ap, version, depth + 1);
  if (!('ok' in apConv)) {
    return { unrepresentable: `additionalProperties: ${apConv.unrepresentable}` };
  }
  return { ok: z.object(shape).catchall(apConv.ok) };
};

const arraySchema = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  const item = convertSchema(node['items'] ?? {}, version, depth + 1);
  if (!('ok' in item)) {
    return { unrepresentable: `array items: ${item.unrepresentable}` };
  }
  const base = z.array(item.ok);
  const withMin = typeof node['minItems'] === 'number' ? base.min(node['minItems']) : base;
  const withMax = typeof node['maxItems'] === 'number' ? withMin.max(node['maxItems']) : withMin;
  return { ok: withMax };
};

const unionSchema = (
  variants: readonly unknown[],
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  const members: z.ZodType[] = [];
  // Imperative on purpose: any single unrepresentable variant aborts the
  // WHOLE union (fail-closed) before later variants are even converted.
  // `variants` (oneOf/anyOf) is spec-controlled and can be arbitrarily long
  // with deeply nested members — converting every variant first and
  // checking afterward would turn this short-circuit into forced recursive
  // conversion work for every variant on hostile input.
  for (const variant of variants) {
    const conv = convertSchema(variant, version, depth + 1);
    if (!('ok' in conv)) {
      return { unrepresentable: `union member: ${conv.unrepresentable}` };
    }
    members.push(conv.ok);
  }
  if (members.length === 0) {
    return { unrepresentable: 'an empty union' };
  }
  if (members.length === 1) {
    return { ok: members[0] as z.ZodType };
  }
  return { ok: z.union(members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) };
};

const convertComposite = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  if (Array.isArray(node['allOf'])) {
    if (node['allOf'].length === 0) {
      // An empty allOf constrains nothing; do not invent an empty object.
      return { unrepresentable: 'an empty allOf' };
    }
    // Every allOf member must be an object; the merge produces one object schema.
    // A member declaring additionalProperties (false/true/schema) omits the
    // operation — it cannot be faithfully merged. Single-member allOf is NOT
    // special-cased: doing so dropped an outer `type` constraint
    // (`{type:'object', allOf:[{type:'string'}]}` must omit, not become a string).
    // An outer `type:'object'` (the only type the conflict gate allows here) is
    // redundant with the object merge.
    const merged = mergeAllOf(node['allOf']);
    // `mergeAllOf`'s return type unions a plain `Record<string, unknown>` with
    // `{ unrepresentable: string }`; because the Record side has an open index
    // signature, `'unrepresentable' in merged` cannot narrow it away (the Record
    // could itself carry that key), so TS2322 fires on the bare ternary under
    // strictest. The cast is behavior-preserving — the runtime check is unchanged.
    return 'unrepresentable' in merged
      ? (merged as { unrepresentable: string })
      : objectSchema(merged, depth, version);
  }
  if (Array.isArray(node['oneOf'])) {
    return unionSchema(node['oneOf'], depth, version);
  }
  if (Array.isArray(node['anyOf'])) {
    return unionSchema(node['anyOf'], depth, version);
  }
  if (node['type'] === 'array') {
    return arraySchema(node, depth, version);
  }
  return objectSchema(node, depth, version);
};

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
    const orphan = Object.keys(node).find((keyword) => ASSERTION_KEYWORDS.has(keyword));
    return orphan === undefined
      ? { ok: z.unknown() }
      : { unrepresentable: `the constraint "${orphan}" on a typeless schema` };
  }
  return { unrepresentable: `the unsupported type "${String(typeValue)}"` };
};

type TypeNormalization = { typeValue: unknown; nullable: boolean };

// Pulls `type` (scalar or `[T, 'null']` union) and 3.0's `nullable` keyword
// into one normalized shape, or a terminal SchemaResult for the malformed/
// degenerate array cases. Order of checks matches the original inline
// control flow exactly (duplicate check, then empty-array check, then
// multi-type check). The array branch preserves BOTH nullability sources:
// an explicit 'null' member and (on 3.0) the node's nullable flag.
const normalizeType = (
  rawType: unknown,
  version: OpenapiVersion,
  nodeNullable: boolean,
): TypeNormalization | SchemaResult => {
  if (!Array.isArray(rawType)) {
    // `nullable` is a 3.0-only keyword. In 3.1 it is not a JSON Schema keyword —
    // honouring it there would ADMIT null the standard 3.1 dialect excludes
    // (widening). 3.1 nullability comes only from a `[type, 'null']` union below.
    return { typeValue: rawType, nullable: version === '3.0' && nodeNullable };
  }
  // JSON Schema requires `type` array elements to be UNIQUE. A duplicate (e.g.
  // ['null','null'] or ['string','null','null']) is malformed and omits, even
  // though it would collapse to a valid single-or-null shape (fail-closed).
  // The accepted unique `[T,'null']` normalization is unaffected.
  if (new Set(rawType).size !== rawType.length) {
    return { unrepresentable: 'a "type" array with duplicate entries' };
  }
  const nonNull = rawType.filter((typeName) => typeName !== 'null');
  const nullable = rawType.includes('null') || (version === '3.0' && nodeNullable);
  if (nonNull.length === 0) {
    // `['null']` (or repeated 'null') is the pure-null type. An EMPTY `type: []`
    // array is degenerate (unsatisfiable — it matches no type) and must omit,
    // not silently become `z.null()` (fail-closed).
    return nullable ? { ok: z.null() } : { unrepresentable: 'an empty "type" array' };
  }
  if (nonNull.length !== 1) {
    return { unrepresentable: 'a multi-type schema beyond [type, null]' };
  }
  return { typeValue: nonNull[0], nullable };
};

const build = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
): SchemaResult => {
  const normalized = normalizeType(node['type'], version, node['nullable'] === true);
  if ('ok' in normalized || 'unrepresentable' in normalized) {
    return normalized;
  }
  const { typeValue, nullable } = normalized;
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
  // Advertise `pattern` and `format` uniformly: attach them as wire metadata on
  // whatever the branch produced — string, enum, const, composite, or a
  // typeless z.unknown() — so z.toJSONSchema emits the keywords WITHOUT
  // enforcing them (no live RegExp; no divergent format validator). The model
  // sees them; validation never runs them.
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

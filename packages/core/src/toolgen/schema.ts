import { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { hasNestedQuantifier } from './pattern-safety.ts';

// Structural nesting guard, tied to the existing parse-depth budget — not a new
// budget. The document is already dereferenced (cycle-safe) upstream, so this
// only backstops pathological depth.
export const MAX_CONVERT_DEPTH = SPEC_BUDGETS.maxParseDepth;

export type SchemaResult = { ok: z.ZodType } | { unrepresentable: string };

// The unrepresentable reason for a response `pattern` with nested quantifiers
// (kaisers-io/openapi-mcp-archive#39). Output-schema derivation looks for it to
// tell the agent why a tool has no output schema.
export const UNSAFE_PATTERN_REASON =
  'a "pattern" with nested quantifiers (unbounded regex matching cost)';

// Which side of the HTTP exchange a schema describes. The same Schema Object
// is routinely shared between a request body and a response (`User` with a
// server-assigned `id`), but the two directions need different contracts:
//   - 'request' — what the MODEL may send. Strict and fail-closed: an object
//     that declares properties but no `additionalProperties` is CLOSED (the
//     project's deliberate strict-input choice), and a `readOnly: true`
//     property is dropped from both the shape and `required` (OAS 3.0.3
//     §4.7.24.2 "readOnly … SHOULD NOT be sent as part of the request … the
//     required will take effect on the response only"; JSON Schema
//     Validation 2020-12 §9.4, which OAS 3.1.1 §4.8.24 adopts).
//   - 'response' — what the UPSTREAM returns, described by the outputSchema.
//     An absent `additionalProperties` keeps its JSON Schema meaning (any
//     extra property allowed; JSON Schema Core 2020-12 §10.3.2.3, OAS 3.0.3
//     §4.7.24.1 "additionalProperties defaults to true"), so a
//     provider adding a field does not break the tool; only an EXPLICIT
//     `additionalProperties: false` closes the object. A `writeOnly: true`
//     property is never required (it "MAY be sent as part of a request but
//     SHOULD NOT be sent as part of the response", OAS 3.0.3 §4.7.24.2), and
//     an open object leaves it out of the shape entirely.
export type SchemaMode = 'request' | 'response';

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
  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ]) {
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
  if ('uniqueItems' in node && typeof node['uniqueItems'] !== 'boolean') {
    return 'uniqueItems';
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
  'uniqueItems',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
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
  'uniqueItems',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
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

const conflictingCombination = (
  node: Record<string, unknown>,
  version: OpenapiVersion,
): string | undefined => {
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
  if (determiner === 'enum' || determiner === 'const') {
    // enum/const fully determine the value set, so a sibling `type` — a single
    // type OR a 3.1 type array such as the canonical nullable enum
    // `{type:['string','null'], enum:['a', null]}`
    // (kaisers-io/openapi-mcp-archive#41) — only has to admit every listed
    // value (JSON Schema Validation 2020-12 §6.1.1: an instance matches a type
    // array if it matches ANY listed type). A malformed type array (empty,
    // duplicate or non-string entries) still omits.
    const types = typeof type === 'string' ? [type] : type;
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      !types.every((name) => typeof name === 'string') ||
      new Set(types).size !== types.length
    ) {
      return `"${determiner}" combined with a malformed "type"`;
    }
    // A 3.0 `nullable: true` adds null to the sibling type, so the
    // OAS 3.0.3-blessed nullable enum `{type:'string', nullable:true,
    // enum:['a', null]}` is consistent, not a conflict.
    const admitted = version === '3.0' && node['nullable'] === true ? [...types, 'null'] : types;
    const enumValues = Array.isArray(node['enum']) ? node['enum'] : [];
    const values: readonly unknown[] = determiner === 'enum' ? enumValues : [node['const']];
    return values.every((value) => admitted.some((name) => valueMatchesType(value, name)))
      ? undefined
      : `"${determiner}" values incompatible with the sibling type ${JSON.stringify(type)}`;
  }
  if (typeof type !== 'string') {
    return `"${determiner}" combined with a multi-type "type"`;
  }
  if (determiner === 'allOf') {
    return type === 'object' ? undefined : `"allOf" combined with a non-object type "${type}"`;
  }
  // oneOf / anyOf + type: cannot faithfully intersect the type across branches.
  return `"${determiner}" combined with a sibling "type"`;
};

// `{type: T, oneOf|anyOf: [...]}` (issue #20). JSON Schema applies sibling
// keywords together, so the node is the union of its branches each
// intersected with `type: T` (JSON Schema Core 2020-12 §10.2). Where every
// branch is a schema object that declares no `type` or exactly `T`, that
// intersection is the branch with `type: T`, and the sibling moves into the
// branches. A branch `T` contradicts (an enum of strings under `type:
// 'object'`) then fails its own conflict check, so nothing is widened. Any
// other shape (a type array, a branch of another type, or a 3.0 `nullable`
// on the node or on a branch, which would admit the null the sibling type
// rejects) keeps the conflict, and the operation stays omitted. A nested
// union is checked the same way when its branch is converted.
// One typed copy per branch and type, so the conversion memo, which is keyed
// by node identity, still converts a shared branch once.
const typedBranches = new WeakMap<Record<string, unknown>, Map<string, Record<string, unknown>>>();

const typedBranch = (branch: Record<string, unknown>, type: string): Record<string, unknown> => {
  if (branch['type'] === type) {
    return branch;
  }
  const byType = typedBranches.get(branch) ?? new Map<string, Record<string, unknown>>();
  typedBranches.set(branch, byType);
  const cached = byType.get(type);
  if (cached !== undefined) {
    return cached;
  }
  const typed = { ...branch, type };
  byType.set(type, typed);
  return typed;
};

const typeMovedIntoBranches = (
  node: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const { type } = node;
  if (typeof type !== 'string' || node['nullable'] !== undefined) {
    return undefined;
  }
  const determiners = SHAPE_DETERMINERS.filter((keyword) => node[keyword] !== undefined);
  const [determiner] = determiners;
  if (determiners.length !== 1 || (determiner !== 'oneOf' && determiner !== 'anyOf')) {
    return undefined;
  }
  const branches = node[determiner];
  if (
    !Array.isArray(branches) ||
    !branches.every(
      (branch) =>
        isRecord(branch) &&
        branch['nullable'] === undefined &&
        (branch['type'] === undefined || branch['type'] === type),
    )
  ) {
    return undefined;
  }
  const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'type'));
  return {
    ...rest,
    [determiner]: branches.map((branch) => typedBranch(branch as Record<string, unknown>, type)),
  };
};

// Keys a `required`-only anyOf branch may carry besides `required`.
const REQUIRED_BRANCH_ANNOTATIONS: ReadonlySet<string> = new Set(['title', 'description']);

// `{type: 'object', properties, anyOf: [{required: [a]}, {required: [b]}]}`
// (issue #20): at least one of these key sets must be present, the way
// GitHub's REST description words partial updates. The branches only add
// `required` lists to the sibling object, so the node is that object plus
// the condition that one list is complete. Every name must be a declared
// property that is neither readOnly nor writeOnly, so each alternative can
// actually be satisfied; anything else keeps the conflict.
const requiredAlternatives = (
  node: Record<string, unknown>,
): readonly (readonly string[])[] | undefined => {
  const { anyOf, properties } = node;
  if (
    !Array.isArray(anyOf) ||
    anyOf.length === 0 ||
    !isRecord(properties) ||
    (node['type'] !== undefined && node['type'] !== 'object') ||
    node['nullable'] !== undefined ||
    SHAPE_DETERMINERS.some((keyword) => keyword !== 'anyOf' && node[keyword] !== undefined)
  ) {
    return undefined;
  }
  const alternatives: string[][] = [];
  for (const branch of anyOf) {
    if (
      !isRecord(branch) ||
      !Object.keys(branch).every(
        (key) => key === 'required' || key.startsWith('x-') || REQUIRED_BRANCH_ANNOTATIONS.has(key),
      )
    ) {
      return undefined;
    }
    const names: unknown = branch['required'];
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      new Set(names).size !== names.length ||
      !names.every(
        (name) =>
          typeof name === 'string' &&
          Object.hasOwn(properties, name) &&
          !isAccessOnly(properties[name], 'readOnly') &&
          !isAccessOnly(properties[name], 'writeOnly'),
      )
    ) {
      return undefined;
    }
    alternatives.push(names as string[]);
  }
  return alternatives;
};

const alternativesMessage = (alternatives: readonly (readonly string[])[]): string =>
  `must include ${alternatives
    .map((names) => names.map((name) => JSON.stringify(name)).join(' and '))
    .join(', or ')}`;

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

// `readOnly`/`writeOnly` are only meaningful on a property's own schema (OAS
// 3.0.3 §4.7.24.2 "Relevant only for Schema properties definitions"); only an
// explicit boolean `true` counts.
const isAccessOnly = (child: unknown, keyword: 'readOnly' | 'writeOnly'): boolean =>
  isRecord(child) && child[keyword] === true;

// An object that admits undeclared keys (loose/catchall). Zod's object and
// record parsers SKIP an own `__proto__` key silently (assigning it to the
// parsed plain object would replace its prototype), so a request value like
// `{"__proto__": …}` from the model would vanish from the outgoing body
// without an error. In request mode reject it explicitly instead — the same
// fail-closed stance DANGEROUS_KEYS takes for spec-declared names. Nested
// values are `unknown` and pass through untouched as plain JSON data. The
// guard is a refinement on the raw input, piped into the object schema, so
// the wire schema (z.toJSONSchema, output side of the pipe) is unchanged.
// Response schemas are validated by ajv against that wire schema, never by
// Zod, so the guard is request-only.
const openObject = (schema: z.ZodType, mode: SchemaMode): z.ZodType =>
  mode === 'request'
    ? z
        .unknown()
        .refine((value) => !(isRecord(value) && Object.hasOwn(value, '__proto__')), {
          message: 'the key "__proto__" is not allowed',
        })
        .pipe(schema)
    : schema;

const ownPropertyCount = (value: unknown): number =>
  Object.keys(value as Record<string, unknown>).length;

// minProperties / maxProperties (JSON Schema Validation 2020-12 §6.5.1-2)
// count the instance's own properties — exactly, by refinement on the parsed
// object (absent optional properties are not materialized by Zod, and a
// strict object has already rejected undeclared ones). Advertised via .meta in
// convertSchema.
const objectSchema = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
): SchemaResult => {
  const base = objectShapeSchema(node, depth, version, mode);
  if (!('ok' in base)) {
    return base;
  }
  const min = node['minProperties'];
  const max = node['maxProperties'];
  const withMin =
    typeof min === 'number'
      ? base.ok.refine((value) => ownPropertyCount(value) >= min, {
          message: `must have at least ${min} propert${min === 1 ? 'y' : 'ies'}`,
        })
      : base.ok;
  const withMax =
    typeof max === 'number'
      ? withMin.refine((value) => ownPropertyCount(value) <= max, {
          message: `must have at most ${max} propert${max === 1 ? 'y' : 'ies'}`,
        })
      : withMin;
  return { ok: withMax };
};

const objectShapeSchema = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
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
  const droppedReadOnly = new Set<string>();
  // A writeOnly property SHOULD NOT appear in a response (OAS 3.0.3 §4.7.24.2),
  // so in response mode it is left out of the advertised shape — the model is
  // never shown a field the upstream does not return (FastMCP's
  // `remove_write_only`). Only an OPEN object drops it: an undeclared key is
  // still allowed there, so a server that does echo it stays valid. A closed
  // object (`additionalProperties: false` or a schema) keeps it as optional,
  // or an echo would fail output validation.
  const ap = node['additionalProperties'];
  const dropsWriteOnly = mode === 'response' && (ap === undefined || ap === true);
  const droppedWriteOnly = new Set<string>();
  for (const [key, child] of Object.entries(properties)) {
    if (isDangerousKey(key)) {
      return { unrepresentable: `a property named "${key}"` };
    }
    // A readOnly property is not part of the request contract at all: drop it
    // (and, below, its `required` entry) so the model is never asked to invent
    // a server-assigned value, and a strict object rejects it if sent. It is
    // not converted either — its schema only matters for the response side,
    // which converts it in response mode.
    if (mode === 'request' && isAccessOnly(child, 'readOnly')) {
      droppedReadOnly.add(key);
      continue;
    }
    if (dropsWriteOnly && isAccessOnly(child, 'writeOnly')) {
      droppedWriteOnly.add(key);
      continue;
    }
    const conv = convertSchema(child, version, depth + 1, mode);
    if (!('ok' in conv)) {
      return { unrepresentable: `property "${key}": ${conv.unrepresentable}` };
    }
    // In a closed response object a writeOnly property is kept but never
    // required: `required` on it applies to requests only.
    const requiredHere =
      required.has(key) && !(mode === 'response' && isAccessOnly(child, 'writeOnly'));
    shape[key] = requiredHere ? conv.ok : conv.ok.optional();
  }
  // A required name with no declared property cannot be enforced (there is no
  // schema for it) — omit rather than silently accept its absence. Object.hasOwn,
  // not `in`, so an inherited name like `toString` is not treated as declared.
  for (const name of required) {
    if (!Object.hasOwn(shape, name) && !droppedReadOnly.has(name) && !droppedWriteOnly.has(name)) {
      return { unrepresentable: `the required property "${name}" is not declared in properties` };
    }
  }
  if (ap === false) {
    return { ok: z.strictObject(shape) };
  }
  if (ap === undefined) {
    // Absent additionalProperties means "any extra property allowed" (JSON
    // Schema Core 2020-12 §10.3.2.3). Responses keep that meaning
    // (kaisers-io/openapi-mcp-archive#33). A request object that DECLARES
    // properties stays closed — the strict-input design — but one that declares
    // none is a free-form object (`metadata`, `labels`, …;
    // kaisers-io/openapi-mcp-archive#35): closing it would accept only `{}`, a
    // narrower contract than the spec states. An empty `properties: {}`
    // declares nothing, the same rule mergeAllOf/buildTyped apply ("empty
    // properties is not object evidence"). `droppedReadOnly` counts as
    // declared: an object whose properties are all readOnly accepts only `{}`
    // in a request. (A response object is open here regardless, so a dropped
    // writeOnly changes nothing.)
    const declaresProperties = Object.keys(properties).length > 0;
    return mode === 'request' && declaresProperties
      ? { ok: z.strictObject(shape) }
      : { ok: openObject(z.object(shape).loose(), mode) };
  }
  if (ap === true) {
    return { ok: openObject(z.object(shape).loose(), mode) };
  }
  const apConv = convertSchema(ap, version, depth + 1, mode);
  if (!('ok' in apConv)) {
    return { unrepresentable: `additionalProperties: ${apConv.unrepresentable}` };
  }
  return { ok: openObject(z.object(shape).catchall(apConv.ok), mode) };
};

// JSON instance equality (JSON Schema Core 2020-12 §4.2.2): object member
// order is irrelevant and numbers compare mathematically. A canonical
// encoding with sorted object keys makes equal instances encode identically
// (JSON.stringify already maps 1 and 1.0 — the same JS number — alike).
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

// O(n) over the encoded items. A pathological input that cannot be encoded
// (nesting deep enough to overflow the stack) fails validation closed instead
// of throwing past Zod — with its own message, so the caller is not told
// about duplicates that may not exist.
const uniquenessIssue = (items: readonly unknown[]): string | undefined => {
  try {
    return new Set(items.map((item) => canonicalJson(item))).size === items.length
      ? undefined
      : 'items must be unique';
  } catch {
    return 'items are nested too deeply to check that they are unique (uniqueItems); send a flatter value';
  }
};

const arraySchema = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
): SchemaResult => {
  const item = convertSchema(node['items'] ?? {}, version, depth + 1, mode);
  if (!('ok' in item)) {
    return { unrepresentable: `array items: ${item.unrepresentable}` };
  }
  const base = z.array(item.ok);
  const withMin = typeof node['minItems'] === 'number' ? base.min(node['minItems']) : base;
  const withMax = typeof node['maxItems'] === 'number' ? withMin.max(node['maxItems']) : withMin;
  // uniqueItems is enforced exactly (refine, opaque to z.toJSONSchema) and
  // advertised via .meta in convertSchema.
  return node['uniqueItems'] === true
    ? {
        ok: withMax.superRefine((items, ctx) => {
          const message = uniquenessIssue(items);
          if (message !== undefined) {
            ctx.addIssue({ code: 'custom', message });
          }
        }),
      }
    : { ok: withMax };
};

// --- Static disjointness of oneOf branches (kaisers-io/openapi-mcp-archive#43) ---
// Every helper is conservative: "unknown" never proves anything. A branch is
// summarised by what it admits, as far as enforced keywords tell: a finite
// list of values (const/enum), a set of JSON types, or unknown. `nullable`
// records a 3.0 `nullable: true`, which admits null as well.
type BranchShape =
  | { kind: 'values'; values: readonly unknown[]; nullable: boolean }
  | { kind: 'types'; types: readonly string[] }
  | { kind: 'unknown' };

// More branches than this are not compared pairwise (O(n²) on a
// spec-controlled list); the union stays inclusive.
const MAX_DISJOINT_BRANCHES = 32;

const propertiesOf = (node: Record<string, unknown>): Record<string, unknown> =>
  isRecord(node['properties']) ? node['properties'] : {};

const requiredOf = (node: Record<string, unknown>): readonly string[] =>
  Array.isArray(node['required'])
    ? node['required'].filter((name): name is string => typeof name === 'string')
    : [];

const declaredTypes = (node: Record<string, unknown>): readonly string[] | undefined => {
  const { type } = node;
  if (typeof type === 'string') {
    return [type];
  }
  if (Array.isArray(type) && type.every((name) => typeof name === 'string')) {
    return type;
  }
  // A typeless node with non-empty properties converts as an object.
  if (type === undefined && Object.keys(propertiesOf(node)).length > 0) {
    return ['object'];
  }
  return undefined;
};

const branchShape = (node: unknown, version: OpenapiVersion): BranchShape => {
  if (!isRecord(node)) {
    return { kind: 'unknown' };
  }
  const nullable = version === '3.0' && node['nullable'] === true;
  if ('const' in node && node['const'] !== undefined) {
    return { kind: 'values', values: [node['const']], nullable };
  }
  if (Array.isArray(node['enum'])) {
    return { kind: 'values', values: node['enum'], nullable };
  }
  if (['allOf', 'oneOf', 'anyOf'].some((keyword) => node[keyword] !== undefined)) {
    return { kind: 'unknown' };
  }
  const types = declaredTypes(node);
  if (types === undefined) {
    return { kind: 'unknown' };
  }
  return { kind: 'types', types: nullable ? [...types, 'null'] : types };
};

// `integer` values are `number` values too.
const typesOverlap = (left: string, right: string): boolean =>
  left === right ||
  (left === 'integer' && right === 'number') ||
  (left === 'number' && right === 'integer');

const admitsNull = (shape: BranchShape): boolean => {
  if (shape.kind === 'values') {
    return shape.nullable || shape.values.some((value) => value === null);
  }
  return shape.kind === 'unknown' || shape.types.includes('null');
};

const admitsValue = (shape: BranchShape, value: unknown): boolean => {
  if (shape.kind === 'values') {
    return shape.values.includes(value) || (value === null && shape.nullable);
  }
  if (shape.kind === 'types') {
    return shape.types.some((name) => valueMatchesType(value, name));
  }
  return true;
};

const shapesDisjoint = (left: BranchShape, right: BranchShape): boolean => {
  if (left.kind === 'unknown' || right.kind === 'unknown') {
    return false;
  }
  if (left.kind === 'values') {
    // Every value `left` admits (null included when nullable) is refused by `right`.
    return (
      left.values.every((value) => !admitsValue(right, value)) &&
      !(left.nullable && admitsNull(right))
    );
  }
  if (right.kind === 'values') {
    return shapesDisjoint(right, left);
  }
  return left.types.every((name) => !right.types.some((other) => typesOverlap(name, other)));
};

// A request-mode object that can never carry an undeclared key: explicit
// `additionalProperties: false`, or declared properties with no
// `additionalProperties` (the strict-input rule in objectSchema).
const isClosedRequestObject = (node: Record<string, unknown>): boolean =>
  node['additionalProperties'] === false ||
  (node['additionalProperties'] === undefined && Object.keys(propertiesOf(node)).length > 0);

// A property both branches require (and the request still carries — not
// readOnly) whose enforced value sets are disjoint: a discriminator with a
// `const`/`enum` per branch.
const discriminatedBy = (
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  version: OpenapiVersion,
): boolean => {
  const secondRequired = new Set(requiredOf(second));
  return requiredOf(first).some((name) => {
    const left = propertiesOf(first)[name];
    const right = propertiesOf(second)[name];
    return (
      secondRequired.has(name) &&
      !isAccessOnly(left, 'readOnly') &&
      !isAccessOnly(right, 'readOnly') &&
      shapesDisjoint(branchShape(left, version), branchShape(right, version))
    );
  });
};

// `first` requires a key that the closed object `second` does not declare.
const requiresKeyClosedTo = (
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): boolean =>
  isClosedRequestObject(second) &&
  requiredOf(first).some(
    (name) =>
      !Object.hasOwn(propertiesOf(second), name) &&
      !isAccessOnly(propertiesOf(first)[name], 'readOnly'),
  );

const isPlainObjectBranch = (
  node: unknown,
  version: OpenapiVersion,
): node is Record<string, unknown> => {
  const shape = branchShape(node, version);
  return shape.kind === 'types' && shape.types.length === 1 && shape.types[0] === 'object';
};

const pairDisjoint = (first: unknown, second: unknown, version: OpenapiVersion): boolean => {
  if (shapesDisjoint(branchShape(first, version), branchShape(second, version))) {
    return true;
  }
  if (!isPlainObjectBranch(first, version) || !isPlainObjectBranch(second, version)) {
    return false;
  }
  return (
    discriminatedBy(first, second, version) ||
    requiresKeyClosedTo(first, second) ||
    requiresKeyClosedTo(second, first)
  );
};

const branchesDisjoint = (variants: readonly unknown[], version: OpenapiVersion): boolean =>
  variants.length <= MAX_DISJOINT_BRANCHES &&
  variants.every((first, index) =>
    variants.slice(index + 1).every((second) => pairDisjoint(first, second, version)),
  );

const unionSchema = (
  variants: readonly unknown[],
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
  // `oneOf` (exclusive) vs `anyOf` (inclusive).
  exclusive: boolean,
): SchemaResult => {
  const members: z.ZodType[] = [];
  // Imperative on purpose: any single unrepresentable variant aborts the
  // WHOLE union (fail-closed) before later variants are even converted.
  // `variants` (oneOf/anyOf) is spec-controlled and can be arbitrarily long
  // with deeply nested members — converting every variant first and
  // checking afterward would turn this short-circuit into forced recursive
  // conversion work for every variant on hostile input.
  for (const variant of variants) {
    const conv = convertSchema(variant, version, depth + 1, mode);
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
  // `oneOf` passes only if EXACTLY one subschema matches (JSON Schema Core
  // 2020-12 §10.2.1.3); `anyOf` if at least one does (§10.2.1.2).
  // z.xor (emitted as `oneOf` on the wire, kaisers-io/openapi-mcp-archive#43)
  // is used only where it cannot reject a value the spec allows:
  //   - response mode: always the inclusive z.union. Response objects are
  //     open (kaisers-io/openapi-mcp-archive#33), so a discriminator-mapping
  //     `oneOf` (Cat/Dog without a `const` on the discriminator) would match a
  //     valid payload twice and fail output validation.
  //   - request mode: z.xor only when the branches are pairwise disjoint by
  //     keywords this converter ENFORCES (see branchesDisjoint). `pattern` and
  //     `format` are advertised, not enforced, so branches that differ only
  //     by them would make z.xor reject every value — an uncallable tool.
  //     Otherwise the inclusive union: the tool stays callable and the
  //     upstream remains the authority on exclusivity.
  // With disjoint branches xor and union accept the same values; the
  // difference is that the wire then says `oneOf`, as the spec does.
  const tuple = members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]];
  const xor = exclusive && mode === 'request' && branchesDisjoint(variants, version);
  return { ok: xor ? z.xor(tuple) : z.union(tuple) };
};

const convertComposite = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
): SchemaResult => {
  if (Array.isArray(node['allOf'])) {
    if (node['allOf'].length === 0) {
      // An empty allOf constrains nothing; do not invent an empty object.
      return { unrepresentable: 'an empty allOf' };
    }
    // Every allOf member must be an object; the merge produces one object schema.
    // A member declaring additionalProperties (false/true/schema) omits the
    // operation — it cannot be faithfully merged. A single-member allOf reaches
    // here only when it has a non-annotation sibling (see isAllOfWrapper in
    // build): passing the member through then would drop that sibling, e.g. an
    // outer `type` (`{type:'object', allOf:[{type:'string'}]}` must omit, not
    // become a string).
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
      : objectSchema(merged, depth, version, mode);
  }
  if (Array.isArray(node['oneOf'])) {
    return unionSchema(node['oneOf'], depth, version, mode, true);
  }
  if (Array.isArray(node['anyOf'])) {
    return unionSchema(node['anyOf'], depth, version, mode, false);
  }
  if (node['type'] === 'array') {
    return arraySchema(node, depth, version, mode);
  }
  return objectSchema(node, depth, version, mode);
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
  mode: SchemaMode,
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
    return convertComposite({ ...node, type: typeValue }, depth, version, mode);
  }
  if (isRecord(node['properties']) && Object.keys(node['properties']).length > 0) {
    // A typeless node with NON-EMPTY properties is treated as an object (the common
    // authoring intent). An EMPTY `properties: {}` carries no constraint and must
    // not narrow to strictObject({}) — it falls through to the typeless-orphan
    // check below, which omits (properties is an assertion keyword).
    return convertComposite(node, depth, version, mode);
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
    // `['null']` is the pure-null type. An EMPTY `type: []` array is degenerate
    // (unsatisfiable — it matches no type) and must omit, not silently become
    // `z.null()` (fail-closed) — even when a sibling 3.0 `nullable: true` is
    // present, since that flag widens an existing type rather than conjuring one.
    return rawType.includes('null')
      ? { ok: z.null() }
      : { unrepresentable: 'an empty "type" array' };
  }
  if (nonNull.length !== 1) {
    return { unrepresentable: 'a multi-type schema beyond [type, null]' };
  }
  return { typeValue: nonNull[0], nullable };
};

// Keywords that may sit next to a single-member `allOf` without changing what
// it validates: annotations only, plus 3.0 `nullable` (handled in build).
const ALLOF_WRAPPER_SIBLINGS: ReadonlySet<string> = new Set([
  'allOf',
  'nullable',
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
]);

// `{description: '…', allOf: [{$ref: …}]}` is the OAS 3.0 idiom for
// annotating a $ref (3.0 ignores siblings of $ref), emitted by FastAPI,
// Spring and many hand-written specs — and the referenced schema is often NOT
// an object (an enum, a string, an integer). `allOf` with ONE subschema
// validates exactly what that subschema validates (JSON Schema Core 2020-12
// §10.2.1.1), so with only annotation siblings the member converts as-is and
// the outer description is attached by convertSchema. Any other sibling
// (notably `type`: `{type:'object', allOf:[{type:'string'}]}` must still omit)
// keeps the object-merge path.
const isAllOfWrapper = (
  node: Record<string, unknown>,
): node is Record<string, unknown> & { allOf: [unknown] } =>
  Array.isArray(node['allOf']) &&
  node['allOf'].length === 1 &&
  Object.keys(node).every((key) => key.startsWith('x-') || ALLOF_WRAPPER_SIBLINGS.has(key));

// Admits null next to a determiner's own values (see build).
const withNull = (result: SchemaResult, admitNull: boolean): SchemaResult =>
  admitNull && 'ok' in result ? { ok: result.ok.nullable() } : result;

const build = (
  node: Record<string, unknown>,
  depth: number,
  version: OpenapiVersion,
  mode: SchemaMode,
): SchemaResult => {
  // const/enum are handled BEFORE type normalization: the value list alone
  // fixes the value set, and conflictingCombination has already checked every
  // value against a sibling `type` — including a 3.1 type array like
  // `['string','integer']` that normalizeType would reject as multi-type.
  //
  // Nullability (kaisers-io/openapi-mcp-archive#41): wherever the spec marks a
  // value nullable, null is admitted in BOTH directions. A 3.0 `nullable: true`
  // next to an enum/const that does not list null (`{type:'string',
  // nullable:true, enum:['a']}`, as older Swashbuckle/NSwag emit) admits null
  // too. OAS 3.0.3 §4.7.24.2 says such an enum "may disallow" null, but the
  // author's intent is plain, a PATCH needs it to clear a field, and a response
  // carrying null must not fail the call. The 3.1 dialect has no `nullable`:
  // there an enum admits null only if it lists it.
  const nullable30 = version === '3.0' && node['nullable'] === true;
  if ('const' in node && node['const'] !== undefined) {
    return withNull(constSchema(node['const']), nullable30 && node['const'] !== null);
  }
  if (Array.isArray(node['enum'])) {
    return withNull(
      enumSchema(node['enum']),
      nullable30 && !node['enum'].some((value) => value === null),
    );
  }
  const normalized = normalizeType(node['type'], version, node['nullable'] === true);
  if ('ok' in normalized || 'unrepresentable' in normalized) {
    return normalized;
  }
  const { typeValue, nullable } = normalized;
  if (
    Array.isArray(node['allOf']) ||
    Array.isArray(node['oneOf']) ||
    Array.isArray(node['anyOf'])
  ) {
    const composed = isAllOfWrapper(node)
      ? convertSchema(node['allOf'][0], version, depth + 1, mode)
      : convertComposite(node, depth, version, mode);
    if (!('ok' in composed) || !nullable) {
      return composed;
    }
    // A 3.0 `nullable: true` beside a composition (the NSwag / Swashbuckle /
    // drf-spectacular idiom for a nullable $ref,
    // kaisers-io/openapi-mcp-archive#41). OAS 3.0.3 §4.7.24.2 reads nullable
    // strictly ("only if `type` is explicitly defined", and the members "may
    // disallow" null), but every generator emitting this idiom means "this
    // reference may be null". Null is admitted in BOTH directions — a request
    // can clear the field (`"manager": null` in a PATCH), and a response
    // carrying null does not fail the call. Every non-null value is still
    // checked against the composition.
    return { ok: composed.ok.nullable() };
  }
  const base = buildTyped(typeValue, node, depth, version, mode);
  if (!('ok' in base)) {
    return base;
  }
  return nullable ? { ok: base.ok.nullable() } : base;
};

// Per-build memoization (issue kaisers-io/openapi-mcp-archive#90).
// Dereferencing shares one output object per $ref target
// (kaisers-io/openapi-mcp-archive#89), so the schema a GET, PUT and POST all
// return is the SAME node, and converting it once per build is enough. The memo
// is keyed by node identity, version and mode, lives only for one
// withConvertMemo call (one buildTools run, so nothing leaks across specs), and
// caches unrepresentable results too, so a hostile spec cannot force the same
// failing work twice.
//
// Depth is the one input besides the node: a nested conversion past
// MAX_CONVERT_DEPTH is unrepresentable. Each entry therefore records its
// height (how far below its own depth the conversion reached); it is reused
// at another depth only if it stays within the budget there, and an entry
// whose conversion hit the budget is not cached at all — so every result is
// exactly what an uncached conversion at that depth returns.
type ConvertMemoEntry = { result: SchemaResult; height: number };

type BuildScope = {
  // Per node: one entry per `${version}/${mode}` (see memoKey).
  converted: WeakMap<object, Partial<Record<string, ConvertMemoEntry>>>;
  // Keyed by Zod schema identity; undefined records a failed emission
  jsonSchemas: WeakMap<z.ZodType, Record<string, unknown> | undefined>;
};

// The key must cover EVERY input that changes a conversion's result: node,
// version, the request/response mode (kaisers-io/openapi-mcp-archive#33 and
// kaisers-io/openapi-mcp-archive#47: readOnly/writeOnly handling, open response
// objects, inclusive response oneOf, and the kaisers-io/openapi-mcp-archive#39
// response-only pattern gate all depend on it) and, via height, depth. A new
// conversion parameter has to join the key, or the first conversion of a shared
// node would decide the result for every later use — e.g. a `User` schema
// shared by a request body and a response would get the request's strict shape.
const memoKey = (version: OpenapiVersion, mode: SchemaMode): string => `${version}/${mode}`;
//
// Imperative on purpose: the scope and the deepest depth reached are ambient
// state of the current synchronous conversion, threaded implicitly so the
// recursive converters keep their signatures. Both are only ever set inside
// withConvertMemo / convertSchema and restored before they return. That is
// sound only because conversion never awaits: convertSchema and everything
// it calls must stay synchronous, or another build could observe the scope.
let activeScope: BuildScope | undefined;
let deepestDepth = 0;

export const withConvertMemo = <Value>(run: () => Value): Value => {
  const previous = activeScope;
  activeScope = { converted: new WeakMap(), jsonSchemas: new WeakMap() };
  try {
    return run();
  } finally {
    activeScope = previous;
  }
};

// z.toJSONSchema of one Zod schema instance, once per build. Callers must not
// mutate the result: it is shared by every tool whose schema converted to the
// same instance (the server snapshot freezes it).
export const memoizedJsonSchema = (
  schema: z.ZodType,
  emit: (schema: z.ZodType) => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const scope = activeScope;
  if (scope === undefined) {
    return emit(schema);
  }
  if (scope.jsonSchemas.has(schema)) {
    return scope.jsonSchemas.get(schema);
  }
  const emitted = emit(schema);
  scope.jsonSchemas.set(schema, emitted);
  return emitted;
};

export const convertSchema = (
  node: unknown,
  version: OpenapiVersion = '3.1',
  depth = 0,
  // The direction the converted schema validates. `'request'` (the default:
  // tool inputs, parameters, request bodies) stays strict and drops readOnly
  // properties; `'response'` (output schemas) leaves undeclared properties
  // open and drops (open object) or relaxes (closed object) writeOnly
  // properties. Propagated unchanged to
  // every nested schema. See SchemaMode.
  mode: SchemaMode = 'request',
): SchemaResult => {
  const scope = activeScope;
  if (scope === undefined || !isRecord(node)) {
    return convertUncached(node, version, depth, mode);
  }
  const key = memoKey(version, mode);
  const byKey = scope.converted.get(node);
  const cached = byKey?.[key];
  if (cached !== undefined && depth + cached.height <= MAX_CONVERT_DEPTH) {
    deepestDepth = Math.max(deepestDepth, depth + cached.height);
    return cached.result;
  }
  const outer = deepestDepth;
  deepestDepth = depth;
  const result = convertUncached(node, version, depth, mode);
  const reached = deepestDepth;
  deepestDepth = Math.max(outer, reached);
  if (reached <= MAX_CONVERT_DEPTH) {
    scope.converted.set(node, { ...byKey, [key]: { result, height: reached - depth } });
  }
  return result;
};

const convertUncached = (
  node: unknown,
  version: OpenapiVersion,
  depth: number,
  mode: SchemaMode,
): SchemaResult => {
  deepestDepth = Math.max(deepestDepth, depth);
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
  // kaisers-io/openapi-mcp-archive#39: a response schema is compiled by Ajv,
  // which RUNS `pattern` on upstream data synchronously. A pattern with nested
  // quantifiers can backtrack catastrophically, so it makes the output schema
  // unrepresentable (fail-closed; the tool falls back to text). Request mode
  // only advertises `pattern` and never executes it, so it is unaffected. See
  // pattern-safety.ts.
  if (
    mode === 'response' &&
    typeof node['pattern'] === 'string' &&
    hasNestedQuantifier(node['pattern'])
  ) {
    return { unrepresentable: UNSAFE_PATTERN_REASON };
  }
  // Two compositions with sibling keywords that convert faithfully once
  // rewritten (issue #20); every other combination is checked as written.
  const alternatives = requiredAlternatives(node);
  const effective =
    alternatives === undefined
      ? (typeMovedIntoBranches(node) ?? node)
      : Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'anyOf'));
  const conflict = conflictingCombination(effective, version);
  if (conflict !== undefined) {
    return { unrepresentable: conflict };
  }
  const converted = build(effective, depth, version, mode);
  if (!('ok' in converted)) {
    return converted;
  }
  // Enforced on the parsed object (a request; absent keys are not
  // materialized), advertised as the spec's own `anyOf` below (Ajv enforces
  // that on a response).
  const built =
    alternatives === undefined
      ? converted
      : {
          ok: converted.ok.refine(
            (value) =>
              isRecord(value) &&
              alternatives.some((names) => names.every((name) => Object.hasOwn(value, name))),
            { message: alternativesMessage(alternatives) },
          ),
        };
  // Advertise `pattern` and `format` uniformly: attach them as wire metadata on
  // whatever the branch produced — string, enum, const, composite, or a
  // typeless z.unknown() — so z.toJSONSchema emits the keywords WITHOUT Zod
  // enforcing them (no live RegExp; no divergent format validator). For a
  // request the model sees them and nothing runs them. For a response the
  // output schema IS compiled by Ajv, which runs `pattern` on upstream data —
  // hence the nested-quantifier gate above (kaisers-io/openapi-mcp-archive#39).
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
  // Enforced by refinement in arraySchema / objectSchema, advertised here.
  if (node['uniqueItems'] === true) {
    meta['uniqueItems'] = true;
  }
  if (typeof node['minProperties'] === 'number') {
    meta['minProperties'] = node['minProperties'];
  }
  if (typeof node['maxProperties'] === 'number') {
    meta['maxProperties'] = node['maxProperties'];
  }
  if (alternatives !== undefined) {
    meta['anyOf'] = alternatives.map((names) => ({ required: [...names] }));
  }
  const advertised = Object.keys(meta).length > 0 ? built.ok.meta(meta) : built.ok;
  return { ok: withDescription(advertised, node) };
};

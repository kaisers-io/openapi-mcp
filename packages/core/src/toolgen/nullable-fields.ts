// --nullable-response-fields (issue #3): every value under an object's
// `properties` in a derived response (`data`) schema also admits null.
//
// Why: OAS 3.0.3 §4.7.24.1 defaults `nullable` to false, and several
// generators (springdoc, for one) leave it out unless a field is annotated,
// while the server serializes every unset field as null. The strict output
// schema then rejects a usable 200 because of a single null. In the same
// specs "required" means "the key is always serialized", not "never null":
// presence and a null-admitting type are independent (JSON Schema Validation
// 2020-12 §6.5.3 and §6.1.1, which OAS 3.1.1 §4.8.24 adopts).
//
// A pure transform of the EMITTED JSON Schema, not a conversion option:
// response schemas are validated by ajv against exactly this wire schema
// (never by Zod, see openObject in schema.ts), so widening it here is what
// the runtime enforces, and convertSchema and its memo keys stay untouched.
// Copy-on-write: the input is the build-wide memoized object
// (memoizedJsonSchema), shared by every tool returning the same schema and
// frozen by the server snapshot, so it is never mutated. Results are cached
// per source node, so operations sharing a data schema share one widened
// object too, as they do without the option.
//
// Widened: each value of a `properties` map, at every depth — inside nested
// objects, array items, additionalProperties values, composition members and
// `$defs` alike. Not widened: `required`, array items, additionalProperties
// values and the root value themselves. `not`, `if`/`then`/`else`,
// `contains`, `propertyNames` and `dependentSchemas` are left alone:
// admitting more inside them would make the outer schema narrower. Response
// mode emits unions as `anyOf` (inclusive, see unionSchema in schema.ts), so
// widening a member cannot make a valid instance match two `oneOf` branches.
//
// Scope `optional` (issue #17) widens only the properties their own object
// schema does not list in `required`. For generators that derive `required`
// from "never null" (springdoc: `@NotNull`, `@NotBlank`,
// `requiredMode = REQUIRED`), a null in a required property then still
// fails, while unset optional fields serialized as null pass. A property
// required only by a sibling `allOf` member counts as optional: the scope
// errs toward admitting null, never toward a narrower schema than `all`.

type JsonSchemaNode = Record<string, unknown>;

// `all`: every value under `properties`; `optional`: only those not listed in
// the same schema's `required`.
export type NullableFieldScope = 'all' | 'optional';

const NULL_TYPE = 'null';

const isRecord = (value: unknown): value is JsonSchemaNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Keywords that only describe, never constrain.
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$comment',
  '$schema',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

// Keywords that constrain every instance type, null included: adding 'null'
// to a sibling `type` would not admit null past them, so a schema carrying
// one is wrapped in an `anyOf` instead.
const TYPE_INDEPENDENT_KEYWORDS: readonly string[] = [
  '$ref',
  'allOf',
  'anyOf',
  'const',
  'enum',
  'if',
  'not',
  'oneOf',
];

const hasAny = (schema: JsonSchemaNode, keywords: readonly string[]): boolean =>
  keywords.some((keyword) => Object.hasOwn(schema, keyword));

const isNull = (value: unknown): boolean => value === null;

const typeAdmitsNull = (type: unknown): boolean =>
  type === NULL_TYPE || (Array.isArray(type) && type.includes(NULL_TYPE));

// Conservative: true only where null is plainly admitted already — a 3.0
// `nullable: true` or a 3.1 `type: [T, 'null']` as Zod emits them, a
// null-admitting `anyOf`, or an unconstrained schema — so such a property is
// emitted unchanged. Anything else is wrapped, which at worst repeats a null
// that was already admitted, never a narrowing.
const admitsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return schema === true;
  }
  if (Object.keys(schema).every((key) => ANNOTATION_KEYWORDS.has(key))) {
    return true;
  }
  const { enum: values, type, anyOf } = schema;
  if (Array.isArray(values) && !values.some((value) => isNull(value))) {
    return false;
  }
  if (Object.hasOwn(schema, 'const') && !isNull(schema['const'])) {
    return false;
  }
  if (hasAny(schema, ['$ref', 'allOf', 'oneOf', 'not', 'if'])) {
    return false;
  }
  if (type !== undefined) {
    return typeAdmitsNull(type) && anyOf === undefined;
  }
  if (Array.isArray(anyOf)) {
    return anyOf.some((member) => admitsNull(member));
  }
  return Object.hasOwn(schema, 'const') || Array.isArray(values);
};

// Null admitted beside an already widened schema.
const withNull = (inner: JsonSchemaNode): JsonSchemaNode => {
  const { type } = inner;
  const typed = typeof type === 'string' || Array.isArray(type);
  if (!typed || hasAny(inner, TYPE_INDEPENDENT_KEYWORDS)) {
    return { anyOf: [inner, { type: NULL_TYPE }] };
  }
  // The compact form for a plain typed schema: every other keyword the
  // converter emits (format, pattern, bounds, properties, required, items,
  // ...) applies to its own instance type only, so null passes it (JSON
  // Schema Validation 2020-12 §6).
  return { ...inner, type: [...(Array.isArray(type) ? type : [type]), NULL_TYPE] };
};

// One pair of caches per scope: the same source node widens differently in
// each.
const caches: Record<
  NullableFieldScope,
  {
    widened: WeakMap<JsonSchemaNode, JsonSchemaNode>;
    nullAdmitting: WeakMap<JsonSchemaNode, JsonSchemaNode>;
  }
> = {
  all: { widened: new WeakMap(), nullAdmitting: new WeakMap() },
  optional: { widened: new WeakMap(), nullAdmitting: new WeakMap() },
};

// Undefined when nothing changed, so an untouched subtree keeps its identity.
const mapValues = (
  record: JsonSchemaNode,
  map: (value: unknown, key: string) => unknown,
): JsonSchemaNode | undefined => {
  const entries = Object.entries(record).map(([key, value]) => [key, map(value, key)] as const);
  const changed = entries.some(([key, value]) => value !== record[key]);
  return changed ? Object.fromEntries(entries) : undefined;
};

const mapItems = (
  items: readonly unknown[],
  map: (value: unknown) => unknown,
): unknown[] | undefined => {
  const mapped = items.map((item) => map(item));
  const changed = mapped.some((item, index) => item !== items[index]);
  return changed ? mapped : undefined;
};

// One property value: widened inside, then null admitted beside it.
const admitNull = (schema: unknown, scope: NullableFieldScope): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  const cached = caches[scope].nullAdmitting.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const inner = admitNullProperties(schema, scope);
  const result = admitsNull(schema) ? inner : withNull(inner);
  caches[scope].nullAdmitting.set(schema, result);
  return result;
};

// Maps one value of `schema.properties`: under `optional`, a key `schema`
// requires is widened inside but gains no null beside it; every other key
// gains null.
const propertyValue = (
  schema: JsonSchemaNode,
  scope: NullableFieldScope,
): ((value: unknown, name: string) => unknown) => {
  const { required } = schema;
  const requiredNames = new Set(
    scope === 'optional' && Array.isArray(required)
      ? required.filter((name) => typeof name === 'string')
      : [],
  );
  return (value, name) =>
    requiredNames.has(name) ? subschema(value, scope) : admitNull(value, scope);
};

const subschema = (value: unknown, scope: NullableFieldScope): unknown =>
  isRecord(value) ? admitNullProperties(value, scope) : value;

// The structure-preserving walk: only `properties` values gain null.
export const admitNullProperties = (
  schema: JsonSchemaNode,
  scope: NullableFieldScope = 'all',
): JsonSchemaNode => {
  const cached = caches[scope].widened.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const changes: JsonSchemaNode = {};
  const record = (keyword: string, value: unknown): void => {
    if (value !== undefined) {
      changes[keyword] = value;
    }
  };
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const value = schema[keyword];
    if (isRecord(value)) {
      record(
        keyword,
        mapValues(
          value,
          keyword === 'properties'
            ? propertyValue(schema, scope)
            : (entry: unknown) => subschema(entry, scope),
        ),
      );
    }
  }
  for (const keyword of ['items', 'additionalProperties']) {
    const value = schema[keyword];
    if (isRecord(value)) {
      const mapped = admitNullProperties(value, scope);
      record(keyword, mapped === value ? undefined : mapped);
    } else if (Array.isArray(value)) {
      record(
        keyword,
        mapItems(value, (entry) => subschema(entry, scope)),
      );
    }
  }
  for (const keyword of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
    const value = schema[keyword];
    if (Array.isArray(value)) {
      record(
        keyword,
        mapItems(value, (entry) => subschema(entry, scope)),
      );
    }
  }
  const result = Object.keys(changes).length === 0 ? schema : { ...schema, ...changes };
  caches[scope].widened.set(schema, result);
  return result;
};

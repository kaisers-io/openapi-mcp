import type { QueryStyle } from './layout.ts';

// Typing of pagination hint values: which kind of value a tool field
// takes (from its declared input schema and query style), and decoding a
// body cursor or a next link's query parameter into exactly that kind, so
// `pagination.next` can be passed back to the tool as arguments.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ScalarKind = 'string' | 'number' | 'boolean';

// The raw (decoded) character that joins a non-exploded array's items in
// the query, per style: `form` uses a comma, the delimited styles their
// own delimiter (OAS 3.1.1 §4.8.12.4).
export type ArrayDelimiter = ',' | ' ' | '|';

// How a hint value for a tool field is decoded, from the field's declared
// input schema and query style: a scalar; an array of scalars (`explode`
// repeats the key per item, otherwise one value joined by `delimiter`); a
// deepObject's object of scalars (`name[key]=value`, only the keys its
// schema declares, each with its own kind); or something a hint cannot
// carry (a nested object, a mixed type, a delimited object, ...).
export type PaginationField =
  | { field: string; kind: ScalarKind }
  | { field: string; kind: 'array'; items: ScalarKind; explode: boolean; delimiter: ArrayDelimiter }
  | { field: string; kind: 'object'; properties: Readonly<Record<string, ScalarKind>> }
  | { field: string; kind: 'unsupported' };

// The JSON types a schema admits, null excluded; a nullable composition
// (`anyOf: [X, {type: null}]`, as zod emits it) is unwrapped to X.
const schemaTypes = (schema: unknown): readonly unknown[] | undefined => {
  if (!isRecord(schema)) {
    return undefined;
  }
  const { anyOf, type } = schema;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter((branch) => !(isRecord(branch) && branch['type'] === 'null'));
    return branches.length === 1 ? schemaTypes(branches[0]) : undefined;
  }
  if (type === undefined) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).filter((entry) => entry !== 'null');
};

const scalarKind = (schema: unknown): ScalarKind | undefined => {
  const types = schemaTypes(schema);
  if (types === undefined) {
    return undefined;
  }
  // Untyped, or string among the alternatives: the raw text is valid.
  if (types.length === 0 || types.includes('string')) {
    return 'string';
  }
  if (types.length === 1 && (types[0] === 'integer' || types[0] === 'number')) {
    return 'number';
  }
  return types.length === 1 && types[0] === 'boolean' ? 'boolean' : undefined;
};

// A nullable composition unwrapped to its one non-null branch (zod emits
// `anyOf: [X, {type: null}]` for a nullable field), else the schema itself.
const unwrapNullable = (schema: unknown): unknown => {
  if (!isRecord(schema) || !Array.isArray(schema['anyOf'])) {
    return schema;
  }
  const branches = schema['anyOf'].filter(
    (branch) => !(isRecord(branch) && branch['type'] === 'null'),
  );
  return branches.length === 1 ? unwrapNullable(branches[0]) : schema;
};

// A deepObject field: only the properties its schema DECLARES can come back
// from a next link, each decoded per its own scalar kind. A free-form object
// (no declared properties) or one with no scalar property gives nothing a
// link could be checked against, so it is unsupported (fail-closed).
const objectFieldOf = (field: string, schema: unknown): PaginationField => {
  const node = unwrapNullable(schema);
  const declared = isRecord(node) && isRecord(node['properties']) ? node['properties'] : {};
  const properties = Object.fromEntries(
    Object.entries(declared).flatMap(([key, child]) => {
      const kind = scalarKind(child);
      return kind === undefined ? [] : [[key, kind] as const];
    }),
  );
  return Object.keys(properties).length === 0
    ? { field, kind: 'unsupported' }
    : { field, kind: 'object', properties };
};

const DELIMITER_OF: Readonly<Record<Exclude<QueryStyle, 'deepObject'>, ArrayDelimiter>> = {
  form: ',',
  spaceDelimited: ' ',
  pipeDelimited: '|',
};

export const fieldOf = (
  field: string,
  schema: unknown,
  { style, explode }: { style: QueryStyle; explode: boolean },
): PaginationField => {
  if (style === 'deepObject') {
    return objectFieldOf(field, schema);
  }
  const scalar = scalarKind(schema);
  // A delimited style is only defined for an array or an object (#108), so
  // a scalar here is form-only; a delimited OBJECT (k|v|k|v) is not decoded.
  if (scalar !== undefined && style === 'form') {
    return { field, kind: scalar };
  }
  const types = schemaTypes(schema);
  const items = isRecord(schema) ? scalarKind(schema['items']) : undefined;
  return types?.length === 1 && types[0] === 'array' && items !== undefined
    ? { field, kind: 'array', items, explode, delimiter: DELIMITER_OF[style] }
    : { field, kind: 'unsupported' };
};

// Hint values become the NEXT call's arguments, so they must be safe as
// such: bounded, printable, and decoded to the field's declared type.
const MAX_HINT_VALUE_LENGTH = 1024;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point (a value carrying one is refused)
const CONTROL_RE = /[\u0000-\u001F\u007F]/u;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/u;
const BOOLEAN_TEXT: Readonly<Record<string, boolean | undefined>> = { true: true, false: false };

export type HintScalar = string | number | boolean;

const decodeScalar = (raw: unknown, kind: ScalarKind): HintScalar | undefined => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (kind === 'boolean') {
      return undefined;
    }
    return kind === 'number' ? raw : String(raw);
  }
  if (typeof raw === 'boolean') {
    return kind === 'boolean' ? raw : undefined;
  }
  if (
    typeof raw !== 'string' ||
    raw === '' ||
    raw.length > MAX_HINT_VALUE_LENGTH ||
    CONTROL_RE.test(raw)
  ) {
    return undefined;
  }
  if (kind === 'number') {
    return NUMERIC_RE.test(raw) ? Number(raw) : undefined;
  }
  if (kind === 'boolean') {
    return BOOLEAN_TEXT[raw];
  }
  return raw;
};

// One hint value from a body cursor (a JSON value).
export const hintValue = (raw: unknown, field: PaginationField): HintScalar | undefined =>
  field.kind === 'array' || field.kind === 'object' || field.kind === 'unsupported'
    ? undefined
    : decodeScalar(raw, field.kind);

// One deepObject property's value from the next link (`name[key]`, every
// occurrence): a key the schema does not declare (own properties only, so
// `__proto__` and friends never match) or a repeated key gives nothing.
export const deepObjectValue = (
  raws: readonly string[],
  field: PaginationField,
  key: string,
): HintScalar | undefined => {
  if (field.kind !== 'object' || !Object.hasOwn(field.properties, key) || raws.length !== 1) {
    return undefined;
  }
  return decodeScalar(raws[0], field.properties[key] as ScalarKind);
};

// One field's value from the next link's query: every occurrence of the
// parameter, decoded per the field's type and style (`explode: true`
// repeats the key per item; otherwise ONE value whose items are joined by
// the style's delimiter: `,` for form, space or `|` for the delimited
// styles). A deepObject is never given by its bare name.
export const linkValue = (
  raws: readonly string[],
  field: PaginationField,
): HintScalar | HintScalar[] | undefined => {
  if (field.kind === 'unsupported' || field.kind === 'object') {
    return undefined;
  }
  if (field.kind !== 'array') {
    return raws.length === 1 ? decodeScalar(raws[0], field.kind) : undefined;
  }
  if (!field.explode && raws.length !== 1) {
    return undefined;
  }
  const items = field.explode ? raws : (raws[0] ?? '').split(field.delimiter);
  const decoded = items.map((item) => decodeScalar(item, field.items));
  return decoded.every((item) => item !== undefined) ? decoded : undefined;
};

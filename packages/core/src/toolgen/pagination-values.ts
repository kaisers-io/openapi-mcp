// Typing of pagination hint values: which kind of value a tool field
// takes (from its declared input schema), and decoding a body cursor or a
// next link's query parameter into exactly that kind, so `pagination.next`
// can be passed back to the tool as arguments.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ScalarKind = 'string' | 'number' | 'boolean';

// How a hint value for a tool field is decoded, from the field's declared
// input schema: a scalar, an array of scalars (with the parameter's form
// `explode`), or something a hint cannot carry (object, mixed, ...).
export type PaginationField =
  | { field: string; kind: ScalarKind }
  | { field: string; kind: 'array'; items: ScalarKind; explode: boolean }
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

export const fieldOf = (field: string, schema: unknown, explode: boolean): PaginationField => {
  const scalar = scalarKind(schema);
  if (scalar !== undefined) {
    return { field, kind: scalar };
  }
  const types = schemaTypes(schema);
  const items = isRecord(schema) ? scalarKind(schema['items']) : undefined;
  return types?.length === 1 && types[0] === 'array' && items !== undefined
    ? { field, kind: 'array', items, explode }
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
  field.kind === 'array' || field.kind === 'unsupported'
    ? undefined
    : decodeScalar(raw, field.kind);

// One field's value from the next link's query: every occurrence of the
// parameter, decoded per the field's type and form style (`explode: true`
// repeats the key per item, `explode: false` joins items with commas).
export const linkValue = (
  raws: readonly string[],
  field: PaginationField,
): HintScalar | HintScalar[] | undefined => {
  if (field.kind === 'unsupported') {
    return undefined;
  }
  if (field.kind !== 'array') {
    return raws.length === 1 ? decodeScalar(raws[0], field.kind) : undefined;
  }
  if (!field.explode && raws.length !== 1) {
    return undefined;
  }
  const items = field.explode ? raws : (raws[0] ?? '').split(',');
  const decoded = items.map((item) => decodeScalar(item, field.items));
  return decoded.every((item) => item !== undefined) ? decoded : undefined;
};

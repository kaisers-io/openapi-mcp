// A compact list of a tool's result fields, for describe_operation (issue
// #49). With `_fields` on, describe used to return the full output schema:
// 44 to 154 KB per GitHub operation, mostly nested schemas and examples. The
// agent needs the field paths to pick `_fields` pointers, so it gets them as
// `<pointer>: <type>` lines, breadth first (every top-level field before any
// nested one), two levels deep and capped; `truncated` says when fields were
// left out. The full schema stays available with include_output_schema: true.

const MAX_FIELDS = 150;
const MAX_DEPTH = 2;

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const subschemas = (schema: Schema, key: string): Schema[] => {
  const value = schema[key];
  return Array.isArray(value) ? value.filter((entry) => isRecord(entry)) : [];
};

// Whether fields were left out
type Walk = { truncated: boolean };

// Composition nested deeper than this is not unfolded (an output schema is
// finite and inlined, so this only bounds the walk)
const MAX_COMPOSITION_DEPTH = 8;

// The schema itself and every allOf/anyOf/oneOf variant, nested ones too: a
// union lists the fields of all its variants. Composition left folded at the
// depth limit marks the list incomplete.
const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'];
const variants = (schema: Schema, walk: Walk, level = 0): Schema[] => {
  const nested = COMPOSITION_KEYS.flatMap((key) => subschemas(schema, key));
  if (level === MAX_COMPOSITION_DEPTH) {
    walk.truncated ||= nested.length > 0;
    return [schema];
  }
  return [schema, ...nested.flatMap((variant) => variants(variant, walk, level + 1))];
};

// The types of a field, from its own `type` and from its composition
// members (`anyOf: [{type: string}, {type: integer}]` is `string|integer`)
const typeName = (schema: Schema): string => {
  const types = new Set<string>();
  for (const variant of variants(schema, { truncated: false })) {
    const { type } = variant;
    for (const name of Array.isArray(type) ? type : [type]) {
      if (typeof name === 'string') {
        types.add(name);
      }
    }
  }
  if (types.size === 0 && isRecord(schema['items'])) {
    types.add('array');
  }
  return types.size === 0 ? 'any' : [...types].join('|');
};

const escapeToken = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

type Pending = { pointer: string; schema: Schema; depth: number };

// Lazy, so a caller takes only as many children as it can use: a schema
// with 130,000 properties must not be materialized to list 150 (review of #49)
const childrenOf = function* childrenOf(
  { pointer, schema, depth }: Pending,
  walk: Walk,
): Generator<Pending> {
  for (const variant of variants(schema, walk)) {
    const { items, properties } = variant;
    if (isRecord(items)) {
      yield { pointer: `${pointer}/*`, schema: items, depth };
    } else if (isRecord(properties)) {
      for (const key of Object.keys(properties)) {
        const child = properties[key];
        if (isRecord(child)) {
          yield { pointer: `${pointer}/${escapeToken(key)}`, schema: child, depth: depth + 1 };
        }
      }
    }
  }
};

// Bounds the fields queued for the next level: union variants can repeat a
// pointer, but no more than this many can ever be listed
const MAX_QUEUED = MAX_FIELDS * 4;

// Up to MAX_QUEUED of `children`, and whether more were left
const take = (children: Iterable<Pending>, into: Pending[]): boolean => {
  for (const child of children) {
    if (into.length === MAX_QUEUED) {
      return true;
    }
    into.push(child);
  }
  return false;
};

// `<pointer>: <type>` for the `data` of one response, breadth first. A
// pointer that union variants type differently lists every type.
const fieldsOf = (data: Schema): { fields: string[]; truncated: boolean } => {
  const listed = new Map<string, Set<string>>();
  const walk: Walk = { truncated: false };
  let queue: Pending[] = [];
  // The generators set `walk.truncated` while they run, so their own result
  // is combined after, never through `||=` (which would overwrite it)
  const rootLeft = take(childrenOf({ pointer: '', schema: data, depth: 0 }, walk), queue);
  walk.truncated ||= rootLeft;
  let full = false;
  while (queue.length > 0 && !full) {
    const next: Pending[] = [];
    for (const field of queue) {
      const types = listed.get(field.pointer);
      if (types !== undefined) {
        types.add(typeName(field.schema));
      } else if (listed.size === MAX_FIELDS) {
        full = true;
        break;
      } else {
        listed.set(field.pointer, new Set([typeName(field.schema)]));
      }
      const children = childrenOf(field, walk);
      const left =
        field.depth < MAX_DEPTH
          ? take(children, next)
          : // Deeper fields exist that the list does not show
            children.next().done !== true;
      walk.truncated ||= left;
    }
    queue = next;
  }
  const fields = [...listed].map(([pointer, types]) => `${pointer}: ${[...types].join('|')}`);
  return { fields, truncated: full || walk.truncated };
};

export type OutputFields = {
  status: unknown;
  contentType: unknown;
  fields: string[];
  truncated?: true;
};

// One entry per success response of the envelope's oneOf
// ({status, contentType, data} branches, toolgen/output-schema.ts)
export const outputFieldsOf = (outputSchema: Schema): OutputFields[] =>
  subschemas(outputSchema, 'oneOf').flatMap((branch) => {
    const properties = isRecord(branch['properties']) ? branch['properties'] : {};
    const { status, contentType, data } = properties;
    if (!isRecord(data) || !isRecord(status) || !isRecord(contentType)) {
      return [];
    }
    const { fields, truncated } = fieldsOf(data);
    return [
      {
        status: status['const'],
        contentType: contentType['const'],
        fields,
        ...(truncated ? { truncated: true as const } : {}),
      },
    ];
  });

// --output-schema defs (issue #9): a derived output schema with every
// repeated subschema emitted once under the root's `$defs` and referenced
// with a local `$ref` elsewhere. Validation is unchanged: a `$ref` to a local
// `$defs` entry validates exactly what the replaced subschema validated (JSON
// Schema Core 2020-12 §8.2.3.1), and MCP requires 2020-12 support with local
// references resolved (only network `$ref`s are off by default).
//
// Output schemas are fully inlined from the dereferenced document, so one
// component schema can appear several times inside one tool's schema (a
// `repository` under several statuses and inside nested objects). Each tool's
// schema must stand alone, so nothing is shared across tools.
//
// Only SCHEMA positions are rewritten (properties, items, composition
// members, ...), never instance data: an object under `enum`, `const`,
// `default` or `examples` is a value, and a `$ref` there would change it.
// A schema that already uses `$ref`, `$defs`, `$id`, `$anchor` or
// `$dynamicRef` is returned unchanged, because moving subschemas could change
// what those resolve to. The result is only used when it is smaller.

type Node = Record<string, unknown>;

const isRecord = (value: unknown): value is Node =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Keywords whose value is one subschema, a list of subschemas, or a map of
// subschemas (JSON Schema Core 2020-12 §10, Validation §6, Unevaluated §11).
const SINGLE: ReadonlySet<string> = new Set([
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const LIST: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const MAP: ReadonlySet<string> = new Set(['dependentSchemas', 'patternProperties', 'properties']);

// Keywords that make subschema positions matter for resolution.
const IDENTITY_KEYWORDS: readonly string[] = [
  '$ref',
  '$defs',
  'definitions',
  '$id',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
];

// A `$ref` plus its def entry cost about this much; smaller repeats do not pay.
const MIN_REPEATED_BYTES = 64;

const DEF_PREFIX = '#/$defs/';

// Serialized form per schema node. Generated schema nodes are never mutated
// after creation (toolgen builds copy-on-write, and the server snapshot
// freezes them), and many are shared between tools (memoizedJsonSchema), so
// each node is serialized once per process instead of once per tool.
const serialized = new WeakMap<Node, string>();
const keyOf = (node: Node): string => {
  let key = serialized.get(node);
  if (key === undefined) {
    key = JSON.stringify(node);
    serialized.set(node, key);
  }
  return key;
};

// Calls `visit` for every subschema directly below `node`.
const childSchemas = (node: Node, visit: (child: Node) => void): void => {
  for (const [keyword, value] of Object.entries(node)) {
    if (SINGLE.has(keyword) && isRecord(value)) {
      visit(value);
    } else if (LIST.has(keyword) && Array.isArray(value)) {
      for (const member of value) {
        if (isRecord(member)) {
          visit(member);
        }
      }
    } else if (MAP.has(keyword) && isRecord(value)) {
      for (const member of Object.values(value)) {
        if (isRecord(member)) {
          visit(member);
        }
      }
    }
  }
};

// A copy of `node` with each direct subschema mapped; the node itself kept
// when nothing changed.
const rebuild = (node: Node, map: (child: Node) => Node): Node => {
  let changed = false;
  const mapOne = (child: unknown): unknown => {
    if (!isRecord(child)) {
      return child;
    }
    const mapped = map(child);
    changed ||= mapped !== child;
    return mapped;
  };
  const entries = Object.entries(node).map(([keyword, value]) => {
    if (SINGLE.has(keyword)) {
      return [keyword, mapOne(value)] as const;
    }
    if (LIST.has(keyword) && Array.isArray(value)) {
      return [keyword, value.map((member) => mapOne(member))] as const;
    }
    if (MAP.has(keyword) && isRecord(value)) {
      return [
        keyword,
        Object.fromEntries(Object.entries(value).map(([name, member]) => [name, mapOne(member)])),
      ] as const;
    }
    return [keyword, value] as const;
  });
  return changed ? Object.fromEntries(entries) : node;
};

const usesIdentity = (node: Node): boolean => {
  if (IDENTITY_KEYWORDS.some((keyword) => Object.hasOwn(node, keyword))) {
    return true;
  }
  let found = false;
  childSchemas(node, (child) => {
    found ||= usesIdentity(child);
  });
  return found;
};

// Serialized form of every subschema below the root, with occurrence counts
// and the first node seen for each.
const collect = (root: Node): Map<string, { node: Node; count: number }> => {
  const seen = new Map<string, { node: Node; count: number }>();
  const walk = (node: Node): void => {
    childSchemas(node, (child) => {
      const key = keyOf(child);
      const entry = seen.get(key);
      if (entry === undefined) {
        seen.set(key, { node: child, count: 1 });
      } else {
        entry.count += 1;
      }
      walk(child);
    });
  };
  walk(root);
  return seen;
};

// Replaces every subschema whose serialization is in `names` by a `$ref`,
// outermost first. A pinned node stays inline (its own children may still be
// replaced).
const replaceRepeats = (
  node: Node,
  names: ReadonlyMap<string, string>,
  pinned: ReadonlySet<Node>,
): Node =>
  rebuild(node, (child) => {
    const name = pinned.has(child) ? undefined : names.get(keyOf(child));
    return name === undefined
      ? replaceRepeats(child, names, pinned)
      : { $ref: `${DEF_PREFIX}${name}` };
  });

const countRefs = (nodes: readonly Node[]): Map<string, number> => {
  const counts = new Map<string, number>();
  const walk = (node: Node): void => {
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith(DEF_PREFIX)) {
      const name = ref.slice(DEF_PREFIX.length);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    childSchemas(node, walk);
  };
  for (const node of nodes) {
    walk(node);
  }
  return counts;
};

// The compact form of `schema`, or `schema` itself when it has nothing worth
// factoring out or already uses references. Deterministic: names are
// numbered largest repeat first. `pinned` nodes (by identity) are never
// replaced by a `$ref`: code that reads the schema's own structure, such as
// the envelope branches' `status`/`contentType` consts, finds them inline.
export const factorRepeatedSubschemas = (
  schema: Node,
  pinned: ReadonlySet<Node> = new Set(),
): Node => {
  if (usesIdentity(schema)) {
    return schema;
  }
  const seen = collect(schema);
  let candidates = [...seen.entries()]
    .filter(([key, entry]) => entry.count > 1 && key.length >= MIN_REPEATED_BYTES)
    .map(([key]) => key)
    .toSorted((first, second) => second.length - first.length);
  // A repeat nested in a larger repeat can end up referenced only once (from
  // the larger one's single definition): drop such candidates and rebuild
  // until every definition is referenced at least twice.
  for (;;) {
    if (candidates.length === 0) {
      return schema;
    }
    const names = new Map(candidates.map((key, index) => [key, `d${String(index)}`]));
    const body = replaceRepeats(schema, names, pinned);
    const defs = candidates.map((key) => {
      const original = seen.get(key)?.node ?? {};
      return [names.get(key) ?? '', replaceRepeats(original, names, pinned)] as const;
    });
    const refs = countRefs([body, ...defs.map(([, def]) => def)]);
    const kept = candidates.filter((key) => (refs.get(names.get(key) ?? '') ?? 0) > 1);
    if (kept.length === candidates.length) {
      const compact = { ...body, $defs: Object.fromEntries(defs) };
      return JSON.stringify(compact).length < keyOf(schema).length ? compact : schema;
    }
    candidates = kept;
  }
};

// --no-output-schema-descriptions (issue #49): the same schema without its
// `description` keywords, which were 49% of the GitHub output schemas. Only
// the keyword is dropped: a property NAMED `description` is a key of a
// `properties` map and stays, and values under `enum`, `const`, `default`
// or `examples` are never walked. Validation is unchanged, since
// `description` is an annotation.
const SCHEMA_MAPS: ReadonlySet<string> = new Set([...MAP, '$defs', 'definitions']);

const mapValues = (value: unknown, each: (entry: unknown) => unknown): unknown =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, each(entry)]))
    : value;

// Generated envelopes share their response schemas, so one stripped copy
// per shared node: copying every envelope's tree retained 45 MB for 100
// tools sharing one 5,000-field response (review of #49)
const stripped = new WeakMap<Node, Node>();

export const withoutDescriptions = (schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  const known = stripped.get(schema);
  if (known !== undefined) {
    return known;
  }
  const copy = Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => {
        if (SINGLE.has(key)) {
          return [key, withoutDescriptions(value)];
        }
        if (LIST.has(key) && Array.isArray(value)) {
          return [key, value.map((entry: unknown) => withoutDescriptions(entry))];
        }
        if (SCHEMA_MAPS.has(key)) {
          return [key, mapValues(value, withoutDescriptions)];
        }
        return [key, value];
      }),
  );
  stripped.set(schema, copy);
  return copy;
};

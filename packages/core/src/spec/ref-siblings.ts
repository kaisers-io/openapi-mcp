// Keywords next to a $ref (issue kaisers-io/openapi-mcp-archive#63). In OpenAPI
// 3.1 a Schema Object is a JSON Schema 2020-12 schema, where keywords beside
// $ref apply IN ADDITION to the referenced schema; elsewhere a Reference Object
// may carry only `summary` and `description`, which override the target's.
// OpenAPI 3.0 ignores all of them (the dereferencer does not call into this
// module for 3.0).
import { isRecord } from './refs.ts';
import { canonical, meet, NO_MEET, scopeConflict } from './schema-meet.ts';

// Where a node sits, which decides what keywords next to a $ref mean (issue
// kaisers-io/openapi-mcp-archive#63): `schema` inside a Schema Object,
// `schemas` for a map whose values are schemas (components.schemas,
// `properties`, `$defs`, ...), `data` for literal instance values inside a
// schema (`example`, `default`, `const`, `enum`, ...), whose `$ref` keys are
// data, not references; `other` everywhere else (parameters, responses, request
// bodies, ... — Reference Objects).
export type Context = 'schema' | 'schemas' | 'data' | 'other';

// Keywords of a schema whose value maps names to schemas
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

// Keywords of a schema whose value is instance data, copied verbatim
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  'example',
  'examples',
  'default',
  'const',
  'enum',
]);

export const childContext = (context: Context, key: string): Context => {
  if (context === 'data') {
    return 'data';
  }
  if (context === 'schemas') {
    // A name in the map: its value is a schema, whatever the name
    return 'schema';
  }
  if (context === 'schema') {
    if (DATA_KEYWORDS.has(key)) {
      return 'data';
    }
    return SCHEMA_MAP_KEYWORDS.has(key) ? 'schemas' : 'schema';
  }
  if (key === 'schema') {
    return 'schema';
  }
  return key === 'schemas' ? 'schemas' : 'other';
};

// JSON Schema annotations: they describe, they do not constrain, so a value
// next to the $ref simply replaces the target's (how 3.1 tools present it).
// `summary` is not a schema keyword, but 3.1 allows it next to any Reference
// Object, so it is treated as one rather than refused as unknown.
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'summary',
  'default',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
  'externalDocs',
]);

const isAnnotation = (key: string): boolean => key.startsWith('x-') || ANNOTATION_KEYWORDS.has(key);

// A Reference Object (outside schemas) may carry only these, which override
// the target's; anything else next to it SHALL be ignored (OpenAPI 3.1, 4.8.23)
export const REFERENCE_OBJECT_OVERRIDES: ReadonlySet<string> = new Set(['summary', 'description']);

export const nullObject = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>;

// Applies the keywords next to a $ref in a SCHEMA (OpenAPI 3.1, JSON Schema
// 2020-12: they apply in addition to the referenced schema, as if both were
// allOf members). Annotations override. An assertion is flattened into the
// target only where that is exactly the conjunction:
//  - the target lacks it, and its scope group (see SCOPE_GROUPS) is either
//    absent from the target or declared identically on both sides;
//  - both carry it with an equal value (compared key-order independently);
//  - both carry a monotone keyword, whose intersection is computed exactly:
//    the smaller upper bound, the larger lower bound, the union of
//    `required`, the intersection of `enum` and `type`, `uniqueItems` if
//    either side sets it.
// Anything else (a differing `pattern`, `format`, `multipleOf`, `const`,
// scope-coupled object or array keywords, an empty intersection) keeps target
// and siblings apart in allOf, which the converter either merges exactly
// (object schemas) or refuses, omitting the operation: never a silent widening.
export const mergeSchemaSiblings = (
  target: unknown,
  siblings: Record<string, unknown>,
): Record<string, unknown> => {
  const annotations = Object.entries(siblings).filter(([key]) => isAnnotation(key));
  const assertions = Object.entries(siblings).filter(([key]) => !isAnnotation(key));
  const apart = (): Record<string, unknown> =>
    Object.assign(nullObject(), Object.fromEntries(annotations), {
      allOf: [target, Object.assign(nullObject(), Object.fromEntries(assertions))],
    });
  if (!isRecord(target) || typeof target['$ref'] === 'string') {
    // A boolean schema or a cycle marker: nothing to merge into, so keep both
    // (a marker inside allOf stays unrepresentable, i.e. fail-closed)
    return apart();
  }
  if (scopeConflict(target, Object.fromEntries(assertions))) {
    return apart();
  }
  const merged: [string, unknown][] = [];
  for (const [key, value] of assertions) {
    if (!Object.hasOwn(target, key)) {
      merged.push([key, value]);
    } else if (canonical(target[key]) !== canonical(value)) {
      const met = meet(key, target[key], value);
      if (met === NO_MEET) {
        return apart();
      }
      merged.push([key, met]);
    }
  }
  return Object.assign(
    nullObject(),
    target,
    Object.fromEntries(merged),
    Object.fromEntries(annotations),
  );
};

// A Reference Object outside schemas: its allowed siblings replace the
// target's fields. A cycle marker or a non-object target is left as it is.
export const mergeReferenceSiblings = (
  target: unknown,
  siblings: Record<string, unknown>,
): unknown =>
  isRecord(target) && typeof target['$ref'] !== 'string'
    ? Object.assign(nullObject(), target, siblings)
    : target;

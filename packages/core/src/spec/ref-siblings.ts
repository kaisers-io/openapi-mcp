// Keywords next to a $ref (issue #63). In OpenAPI 3.1 a Schema Object is a
// JSON Schema 2020-12 schema, where keywords beside $ref apply IN ADDITION to
// the referenced schema; elsewhere a Reference Object may carry only `summary`
// and `description`, which override the target's. OpenAPI 3.0 ignores all of
// them (the dereferencer does not call into this module for 3.0).
import { isRecord } from './refs.ts';

// Where a node sits, which decides what keywords next to a $ref mean (issue
// #63): `schema` inside a Schema Object, `schemas` for the components.schemas
// map (whose values are schemas), `other` everywhere else (parameters,
// responses, request bodies, ... — Reference Objects).
export type Context = 'schema' | 'schemas' | 'other';

export const childContext = (context: Context, key: string): Context => {
  if (context === 'schema' || context === 'schemas') {
    return 'schema';
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
// 2020-12: they apply in addition to the referenced schema). Annotations
// override; an assertion the target lacks is added; an assertion both carry
// with the same value is kept. Two different values mean the intersection,
// which is not computed heuristically: target and siblings are combined with
// allOf instead, which the converter either merges exactly (object schemas) or
// refuses, omitting the operation — never a silent widening.
export const mergeSchemaSiblings = (
  target: unknown,
  siblings: Record<string, unknown>,
): Record<string, unknown> => {
  const annotations = Object.entries(siblings).filter(([key]) => isAnnotation(key));
  const assertions = Object.entries(siblings).filter(([key]) => !isAnnotation(key));
  if (!isRecord(target) || typeof target['$ref'] === 'string') {
    // A boolean schema or a cycle marker: nothing to merge into, so keep both
    // (a marker inside allOf stays unrepresentable, i.e. fail-closed)
    return Object.assign(nullObject(), Object.fromEntries(annotations), {
      allOf: [target, Object.assign(nullObject(), Object.fromEntries(assertions))],
    });
  }
  const conflicting = assertions.some(
    ([key, value]) =>
      Object.hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value),
  );
  if (conflicting) {
    return Object.assign(nullObject(), Object.fromEntries(annotations), {
      allOf: [target, Object.assign(nullObject(), Object.fromEntries(assertions))],
    });
  }
  return Object.assign(
    nullObject(),
    target,
    Object.fromEntries(assertions),
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

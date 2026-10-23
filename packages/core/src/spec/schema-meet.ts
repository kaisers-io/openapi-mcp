// Exact intersections for keywords next to a $ref in an OpenAPI 3.1 schema
// (issue kaisers-io/openapi-mcp-archive#63): when a sibling assertion can be
// flattened into the referenced schema, and what two values of one monotone
// keyword become when both must hold. Used by mergeSchemaSiblings in
// ref-siblings.ts.
import { isRecord } from './refs.ts';

// Key-order independent JSON, so two equal object values (an `enum` of
// objects, a `const`) never read as different
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

// Keywords whose meaning depends on other keywords OF THE SAME schema object:
// `additionalProperties` applies to the properties its own schema object does
// not declare, `items` to the positions after its own `prefixItems`, and so
// on. Flattening a sibling from one of these groups into a target that has a
// keyword of the same group would move it into the other's scope and widen
// validation (a sibling `additionalProperties: false` next to a target with
// `properties` rejects those properties; flattened, it would allow them). Such
// a pair keeps its separate scopes in allOf instead.
const SCOPE_GROUPS: readonly ReadonlySet<string>[] = [
  new Set(['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties']),
  new Set(['prefixItems', 'items', 'additionalItems', 'unevaluatedItems']),
  new Set(['contains', 'minContains', 'maxContains']),
  new Set(['if', 'then', 'else']),
];

const pick = (record: Record<string, unknown>, keys: readonly string[]): string =>
  canonical(Object.fromEntries(keys.map((key) => [key, record[key]])));

// A sibling from a scope group may join the target only when the target has
// no keyword of that group, or when both sides declare the group identically
// (then nothing moves into another scope): an equal `additionalProperties`
// next to a target that also declares `properties` still forbids those
// properties on the sibling's side
export const scopeConflict = (
  target: Record<string, unknown>,
  siblings: Record<string, unknown>,
): boolean =>
  SCOPE_GROUPS.some((group) => {
    const own = Object.keys(target).filter((key) => group.has(key));
    const added = Object.keys(siblings).filter((key) => group.has(key));
    if (own.length === 0 || added.length === 0) {
      return false;
    }
    return pick(target, own) !== pick(siblings, added);
  });

const UPPER_BOUNDS: ReadonlySet<string> = new Set([
  'maxLength',
  'maxItems',
  'maximum',
  'exclusiveMaximum',
  'maxProperties',
]);
const LOWER_BOUNDS: ReadonlySet<string> = new Set([
  'minLength',
  'minItems',
  'minimum',
  'exclusiveMinimum',
  'minProperties',
]);

const typeSet = (value: unknown): readonly string[] | undefined => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return undefined;
};

// What an instance of type `left` AND of type `right` can be: `integer` is the one
// type contained in another (`number`)
const typeMeet = (left: string, right: string): string | undefined => {
  if (left === right) {
    return left;
  }
  if ((left === 'integer' && right === 'number') || (left === 'number' && right === 'integer')) {
    return 'integer';
  }
  return undefined;
};

// No representable intersection: the caller keeps both sides apart in allOf
export const NO_MEET = Symbol('no-meet');

const meetBound = (key: string, own: unknown, sibling: unknown): unknown => {
  if (typeof own !== 'number' || typeof sibling !== 'number') {
    return NO_MEET;
  }
  return UPPER_BOUNDS.has(key) ? Math.min(own, sibling) : Math.max(own, sibling);
};

const meetRequired = (own: unknown, sibling: unknown): unknown => {
  if (!Array.isArray(own) || !Array.isArray(sibling)) {
    return NO_MEET;
  }
  const names: unknown[] = [...own, ...sibling];
  return names.every((name) => typeof name === 'string') ? [...new Set(names)] : NO_MEET;
};

const meetEnum = (own: unknown, sibling: unknown): unknown => {
  if (!Array.isArray(own) || !Array.isArray(sibling)) {
    return NO_MEET;
  }
  const allowed = new Set(sibling.map((value) => canonical(value)));
  const both = own.filter((value) => allowed.has(canonical(value)));
  // An empty enum accepts nothing: that verdict is left to the fail-closed path
  return both.length === 0 ? NO_MEET : both;
};

const meetType = (own: unknown, sibling: unknown): unknown => {
  const ownTypes = typeSet(own);
  const siblingTypes = typeSet(sibling);
  if (ownTypes === undefined || siblingTypes === undefined) {
    return NO_MEET;
  }
  const both = [
    ...new Set(
      ownTypes.flatMap((left) =>
        siblingTypes.flatMap((right) => {
          const met = typeMeet(left, right);
          return met === undefined ? [] : [met];
        }),
      ),
    ),
  ];
  if (both.length === 0) {
    return NO_MEET;
  }
  return both.length === 1 ? both[0] : both;
};

// The exact intersection of two different values of one monotone keyword
// (both constraints must hold), or NO_MEET for any other keyword, malformed
// values, or no common value
export const meet = (key: string, own: unknown, sibling: unknown): unknown => {
  if (UPPER_BOUNDS.has(key) || LOWER_BOUNDS.has(key)) {
    return meetBound(key, own, sibling);
  }
  switch (key) {
    case 'uniqueItems': {
      // Either side requiring unique items requires it
      return typeof own === 'boolean' && typeof sibling === 'boolean' ? own || sibling : NO_MEET;
    }
    case 'required': {
      return meetRequired(own, sibling);
    }
    case 'enum': {
      return meetEnum(own, sibling);
    }
    case 'type': {
      return meetType(own, sibling);
    }
    default: {
      return NO_MEET;
    }
  }
};

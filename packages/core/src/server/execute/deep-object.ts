// A deepObject value as flat key/value pairs (issues #95 and #96): each pair
// is the path below the parameter or body field name, one segment per
// bracket, and the leaf as text. The caller encodes them for the query or
// the form body.
//
// OpenAPI defines deepObject for one level of an object with scalar values
// only (`name[key]=value`). With `indices` (--deep-object-indices) the
// convention of qs "indices", which Stripe's SDK sends, covers the rest:
// objects nest as `name[a][b]=value`, arrays as `name[0]=value`, and a scalar
// is `name=value`. Fail closed where a pair could be read as something else:
// null (not the empty string), an empty array or object (indistinguishable
// from an absent value), a key that is empty (read as `[]`) or contains a
// bracket (read as nesting), and text that is not well-formed UTF-16.

export type DeepObjectPair = { path: readonly string[]; value: string };

// Bounds the walk; a tool's input schema allows far less nesting
const MAX_DEPTH = 32;
const WHERE_DISPLAY_MAX = 128;

const where = (name: string, path: readonly string[]): string => {
  const shown = `${name}${path.map((segment) => `[${segment}]`).join('')}`;
  return shown.length > WHERE_DISPLAY_MAX ? `${shown.slice(0, WHERE_DISPLAY_MAX)}…` : shown;
};

export const deepObjectPairs = (
  // The parameter or body field name, for errors only
  name: string,
  value: unknown,
  indices: boolean,
): { ok: DeepObjectPair[] } | { error: string } => {
  const pairs: DeepObjectPair[] = [];
  // Imperative on purpose: the walk stops at the first value it cannot send,
  // before encoding the rest of a caller-supplied argument
  const walk = (node: unknown, path: string[]): { error: string } | undefined => {
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      const text = String(node);
      if (!text.isWellFormed()) {
        return { error: `"${where(name, path)}" could not be encoded` };
      }
      pairs.push({ path, value: text });
      return undefined;
    }
    if (path.length >= MAX_DEPTH) {
      return { error: `"${name}" nests deeper than ${String(MAX_DEPTH)} levels` };
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        return {
          error: `"${where(name, path)}" is an empty array, which cannot be sent: leave it out`,
        };
      }
      for (const [index, item] of node.entries()) {
        const failed = walk(item, [...path, String(index)]);
        if (failed !== undefined) {
          return failed;
        }
      }
      return undefined;
    }
    if (node === null || typeof node !== 'object') {
      return { error: `"${where(name, path)}" is null, which cannot be sent: leave it out` };
    }
    const entries = Object.entries(node);
    if (entries.length === 0) {
      return {
        error: `"${where(name, path)}" is an empty object, which cannot be sent: leave it out`,
      };
    }
    for (const [key, item] of entries) {
      if (key === '' || key.includes('[') || key.includes(']') || !key.isWellFormed()) {
        return {
          error: `"${where(name, path)}" has a key that is empty, contains "[" or "]", or cannot be encoded`,
        };
      }
      const failed = walk(item, [...path, key]);
      if (failed !== undefined) {
        return failed;
      }
    }
    return undefined;
  };
  // Without the convention: only what OpenAPI defines, an object of scalars
  if (!indices) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `"${name}" (deepObject) must be an object` };
    }
    if (Object.values(value).some((item) => typeof item === 'object' && item !== null)) {
      return { error: `"${name}" (deepObject) must be an object of scalar values` };
    }
    // An empty object sends nothing, as for a deepObject query parameter
    if (Object.keys(value).length === 0) {
      return { ok: [] };
    }
  }
  const failed = walk(value, []);
  return failed === undefined ? { ok: pairs } : failed;
};

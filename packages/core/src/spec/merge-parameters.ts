import { isRecord } from './refs.ts';

// Follows a parameter `{ $ref }` only as far as needed to read its name and
// location (normalize.ts reads the document before it is dereferenced).
export type Resolve = (node: unknown) => unknown;

// A parameter as written (a `{ $ref }` stays one: keywords next to the $ref
// are applied when the operation is dereferenced, OpenAPI 3.1, issue
// kaisers-io/openapi-mcp-archive#63) with the name and location of what it
// resolves to.
type Entry = { written: Record<string, unknown>; name: string; in: string };

// One level's parameters keyed by exact resolved `in name`, the last
// definition of a key winning (OpenAPI allows a key once per level).
// Undefined when a parameter is unresolvable: a cyclic { $ref } marker or a
// malformed shape.
const levelParameters = (
  level: readonly unknown[],
  resolve: Resolve,
): Map<string, Entry> | undefined => {
  const byKey = new Map<string, Entry>();
  for (const written of level) {
    const param = resolve(written);
    if (
      !isRecord(written) ||
      !isRecord(param) ||
      typeof param['name'] !== 'string' ||
      typeof param['in'] !== 'string'
    ) {
      return undefined;
    }
    byKey.set(`${param['in']} ${param['name']}`, {
      written,
      name: param['name'],
      in: param['in'],
    });
  }
  return byKey;
};

// Header names are case-insensitive (RFC 9110 §5.1); every other location
// keeps its case-sensitive name.
const overrideKey = (entry: Entry): string =>
  entry.in === 'header' ? `header ${entry.name.toLowerCase()}` : `${entry.in} ${entry.name}`;

// An operation-level parameter overrides a path-level one with the same name
// and location (OpenAPI Path Item `parameters`), taking its position. For
// headers that match is case-insensitive, so a path-level `X-Req-Id` is
// replaced by an operation-level `x-req-id` instead of surviving next to it,
// which made buildLayout omit the whole operation as a duplicate header.
// Within ONE level, two headers differing only in case are both kept (at the
// path level also when the operation overrides one of them), so buildLayout's
// case-insensitive check still rejects them fail-closed. Matching uses the
// RESOLVED name/in, so a `{ $ref }` parameter overrides and is overridden
// like an inline one. `cookie` and `querystring` say whether any merged
// parameter is in that location (normalize.ts omits such operations).
export const mergeParameters = (
  pathLevel: readonly unknown[],
  opLevel: readonly unknown[],
  resolve: Resolve,
): {
  parameters: Record<string, unknown>[];
  unresolvable: boolean;
  cookie: boolean;
  querystring: boolean;
} => {
  const pathParams = levelParameters(pathLevel, resolve);
  const opParams = levelParameters(opLevel, resolve);
  if (pathParams === undefined || opParams === undefined) {
    return { parameters: [], unresolvable: true, cookie: false, querystring: false };
  }
  const overrides = new Map<string, Entry>();
  for (const entry of opParams.values()) {
    if (!overrides.has(overrideKey(entry))) {
      overrides.set(overrideKey(entry), entry);
    }
  }
  const placed = new Set<Entry>();
  const fromPath = [...pathParams.values()].flatMap((entry) => {
    const override = overrides.get(overrideKey(entry));
    if (override === undefined) {
      return [entry];
    }
    // A second path-level case variant of the same header: kept, so the
    // path level's own duplicate is still rejected by buildLayout instead of
    // being resolved silently by the override
    if (placed.has(override)) {
      return [entry];
    }
    placed.add(override);
    return [override];
  });
  const remaining = [...opParams.values()].filter((entry) => !placed.has(entry));
  const merged = [...fromPath, ...remaining];
  return {
    parameters: merged.map((entry) => entry.written),
    unresolvable: false,
    cookie: merged.some((entry) => entry.in === 'cookie'),
    // OpenAPI 3.2: the whole query string as one parameter
    querystring: merged.some((entry) => entry.in === 'querystring'),
  };
};

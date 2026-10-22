const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type Parameter = Record<string, unknown> & { name: string; in: string };

// One level's parameters keyed by exact `in name`, the last definition of a
// key winning (OpenAPI allows a key once per level). Undefined when a
// parameter is unresolvable: a cyclic { $ref } marker or a malformed shape.
const levelParameters = (level: readonly unknown[]): Map<string, Parameter> | undefined => {
  const byKey = new Map<string, Parameter>();
  for (const param of level) {
    if (!isRecord(param) || typeof param['name'] !== 'string' || typeof param['in'] !== 'string') {
      return undefined;
    }
    byKey.set(`${param['in']} ${param['name']}`, param as Parameter);
  }
  return byKey;
};

// Header names are case-insensitive (RFC 9110 §5.1); every other location
// keeps its case-sensitive name.
const overrideKey = (param: Parameter): string =>
  param.in === 'header' ? `header ${param.name.toLowerCase()}` : `${param.in} ${param.name}`;

// An operation-level parameter overrides a path-level one with the same name
// and location (OpenAPI Path Item `parameters`), taking its position. For
// headers that match is case-insensitive, so a path-level `X-Req-Id` is
// replaced by an operation-level `x-req-id` instead of surviving next to it,
// which made buildLayout omit the whole operation as a duplicate header.
// Within ONE level, two headers differing only in case are both kept, so
// buildLayout's case-insensitive check still rejects them fail-closed.
export const mergeParameters = (
  pathLevel: readonly unknown[],
  opLevel: readonly unknown[],
): { parameters: Record<string, unknown>[]; unresolvable: boolean } => {
  const pathParams = levelParameters(pathLevel);
  const opParams = levelParameters(opLevel);
  if (pathParams === undefined || opParams === undefined) {
    return { parameters: [], unresolvable: true };
  }
  const overrides = new Map<string, Parameter>();
  for (const param of opParams.values()) {
    if (!overrides.has(overrideKey(param))) {
      overrides.set(overrideKey(param), param);
    }
  }
  const placed = new Set<Parameter>();
  const fromPath = [...pathParams.values()].flatMap((param) => {
    const override = overrides.get(overrideKey(param));
    if (override === undefined) {
      return [param];
    }
    if (placed.has(override)) {
      return [];
    }
    placed.add(override);
    return [override];
  });
  const remaining = [...opParams.values()].filter((param) => !placed.has(param));
  return { parameters: [...fromPath, ...remaining], unresolvable: false };
};

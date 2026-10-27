import { notExposedCounts, sanitizeSpecText } from '@kaisers-io/openapi-mcp-core';
import type {
  NormalizedSpec,
  NotExposedOperation,
  OperationRecord,
  SecurityRequirement,
} from '@kaisers-io/openapi-mcp-core';

// What `--json tools` tells about each operation beyond its exposure (issue
// #76), so a person can decide on --allow and --deny without the spec: what
// the operation does and which credentials it accepts.

// Descriptions are sanitized at normalization; this bounds each one again,
// since a spec may give every operation several KB of text
const DESCRIPTION_MAX = 1024;

export type OperationFacts = {
  operationId?: string;
  tags?: readonly string[];
  summary?: string;
  description?: string;
  // The operation's own `security`, or the spec's root one: alternatives
  // (any one suffices), each naming the schemes it needs together, with
  // scopes. `[]` needs none; a `{}` alternative makes credentials optional.
  // Absent when neither declares it.
  security?: readonly SecurityRequirement[];
};

const effectiveSecurity = (
  operation: OperationRecord,
  spec: NormalizedSpec,
): readonly SecurityRequirement[] | undefined => operation.security ?? spec.security;

export const factsOf = (operation: OperationRecord, spec: NormalizedSpec): OperationFacts => {
  const security = effectiveSecurity(operation, spec);
  return {
    ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
    tags: operation.tags,
    ...(operation.summary === undefined ? {} : { summary: operation.summary }),
    ...(operation.description === undefined
      ? {}
      : { description: sanitizeSpecText(operation.description, DESCRIPTION_MAX) }),
    ...(security === undefined ? {} : { security }),
  };
};

const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

// Every not-exposed operation with the facts of its spec operation. An
// operation omitted while the spec was read has no record: it keeps the
// identifiers it already carries.
export const withFacts = (
  notExposed: readonly NotExposedOperation[],
  spec: NormalizedSpec,
): (NotExposedOperation & OperationFacts)[] => {
  const records = new Map(
    spec.operations.map((operation) => [keyOf(operation.method, operation.path), operation]),
  );
  return notExposed.map((row) => {
    const record = records.get(keyOf(row.method, row.path));
    return record === undefined ? row : { ...row, ...factsOf(record, spec) };
  });
};

const usesScheme = (facts: OperationFacts, scheme: string): boolean =>
  (facts.security ?? []).some((requirement) => Object.hasOwn(requirement, scheme));

// Every scheme the spec declares (as far as it was read), with how many
// exposed and not exposed operations accept it
export const schemeInventory = (
  spec: NormalizedSpec,
  exposed: readonly OperationFacts[],
  notExposed: readonly OperationFacts[],
) => ({
  securitySchemes: (spec.securitySchemes ?? []).map((scheme) => ({
    name: scheme.name,
    type: scheme.type,
    deprecated: scheme.deprecated === true,
    exposed: exposed.filter((facts) => usesScheme(facts, scheme.name)).length,
    notExposed: notExposed.filter((facts) => usesScheme(facts, scheme.name)).length,
  })),
  ...(spec.securitySchemesDropped === undefined
    ? {}
    : { securitySchemesDropped: spec.securitySchemesDropped }),
});

// Every operation is either a tool or in notExposed, so they add up
export const inventoryCounts = (exposed: number, notExposed: readonly NotExposedOperation[]) => ({
  operations: exposed + notExposed.length,
  exposed,
  notExposed: notExposedCounts(notExposed),
});

import type { OmittedOperation } from '../spec/normalize.ts';
import type { NotExposedDecision, NotExposedOperation } from './apply.ts';

// Every operation of the spec that is not a tool, with its one decision
// (issue #41): left out by the filters, omitted as not supported (while the
// spec is normalized or tools are generated), or withheld because a pending
// candidate removed it. Shared by `tools` and `serve`.
export type NotExposedSources = {
  spec: { omitted: readonly OmittedOperation[] };
  filteredOut: readonly NotExposedOperation[];
  withheldOperations: readonly OmittedOperation[];
};

const fromOmission = (
  omission: OmittedOperation,
  decision: NotExposedDecision,
): NotExposedOperation => ({
  // An omitted method is kept as normalized: a name that is not upper case
  // was never one a pattern can name, and upper-casing it would hide that
  method: decision === 'withheld' ? omission.method.toUpperCase() : omission.method,
  path: omission.path,
  ...(omission.operationId === undefined ? {} : { operationId: omission.operationId }),
  ...(omission.toolName === undefined ? {} : { toolName: omission.toolName }),
  tags: omission.tags ?? [],
  decision,
  reason: omission.reason,
});

export const notExposedOperations = (
  sources: NotExposedSources,
  toolgenOmitted: readonly OmittedOperation[],
): NotExposedOperation[] => [
  ...sources.filteredOut,
  ...[...sources.spec.omitted, ...toolgenOmitted].map((omission) =>
    fromOmission(omission, 'omitted'),
  ),
  ...sources.withheldOperations.map((omission) => fromOmission(omission, 'withheld')),
];

export type NotExposedCounts = Record<NotExposedDecision, number>;

export const notExposedCounts = (operations: readonly NotExposedOperation[]): NotExposedCounts => {
  const counts: NotExposedCounts = {
    denied: 0,
    'not-allowed': 0,
    'read-only-default': 0,
    omitted: 0,
    withheld: 0,
    'head-without-get': 0,
  };
  for (const operation of operations) {
    counts[operation.decision] += 1;
  }
  return counts;
};

const SUMMARY_WORDING: Record<NotExposedDecision, string> = {
  denied: 'excluded by --deny',
  'not-allowed': 'matched by no --allow',
  'read-only-default': 'left out by the read-only default',
  omitted: 'omitted as not supported',
  withheld: 'withheld for a pending candidate',
  'head-without-get': 'HEAD left out because its GET is not exposed',
};

// One bounded line however large the spec, or none when everything is a
// tool. The full list is in `openapi-mcp --json tools`.
export const notExposedSummary = (counts: NotExposedCounts): string | undefined => {
  const parts = (Object.keys(SUMMARY_WORDING) as NotExposedDecision[])
    .filter((decision) => counts[decision] > 0)
    .map((decision) => `${String(counts[decision])} ${SUMMARY_WORDING[decision]}`);
  return parts.length === 0
    ? undefined
    : `operations not exposed: ${parts.join(', ')}; every one with its reason: openapi-mcp --json tools with the same options`;
};

// An omission as it was always serialized: provenance stays internal
export const publicOmission = (omission: OmittedOperation): OmittedOperation => ({
  method: omission.method,
  path: omission.path,
  reason: omission.reason,
});

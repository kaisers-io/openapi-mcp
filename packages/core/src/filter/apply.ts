import { usageError } from '../errors.ts';
import type { OmittedOperation } from '../spec/normalize.ts';
import type { NamedOperation } from '../toolgen/naming.ts';
import { caseCollisionsFor } from './case-collisions.ts';
import type { CaseCollision } from './case-collisions.ts';
import { deadPatternsFor, matchesOperation } from './engine.ts';
import type { DeadPattern, DeadPatternFlag, FilterTarget } from './engine.ts';
import { STANDARD_FILTER_METHODS, createMatchBudget } from './pattern.ts';
import type { FilterPattern, MatchBudget } from './pattern.ts';

// With no --allow, only these methods are exposed. QUERY (OpenAPI 3.2) is
// safe by definition (RFC 10008 §2): a read with a request body.
const READ_ONLY_METHODS = new Set(['get', 'head', 'query']);

// Why an operation of the spec is not a tool (issue #41). Every operation is
// either exposed or has exactly one of these.
export type NotExposedDecision =
  | 'denied'
  | 'not-allowed'
  | 'read-only-default'
  | 'omitted'
  | 'withheld'
  | 'head-without-get';

export type NotExposedOperation = {
  // Upper case, as sent
  method: string;
  path: string;
  operationId?: string;
  toolName?: string;
  tags: readonly string[];
  decision: NotExposedDecision;
  // `denied`: the first --deny pattern that matches it
  pattern?: string;
  reason: string;
  // `omitted` only for these optional parameters, which
  // --omit-unsupported-parameters would leave out (issue #67)
  omittableParameters?: readonly string[];
};

export type FilterDecision = {
  exposed: readonly NamedOperation[];
  // The operations the filters leave out, each with its decision
  filteredOut: readonly NotExposedOperation[];
  deadPatterns: readonly DeadPattern[];
  // Patterns that match values differing only by case (issue #42)
  caseCollisions: readonly CaseCollision[];
};

// The omitted operations a pattern can name, by operationId and tags. Only
// an upper-case method was ever one a `METHOD /path` pattern can name (an
// OpenAPI 3.2 `link` key is not `LINK`), so any other keeps no method: it
// matches no such pattern and declares none.
export const omittedTargets = (omitted: readonly OmittedOperation[]): FilterTarget[] =>
  omitted.map((omission): FilterTarget => {
    const { path, operationId, toolName, tags = [] } = omission;
    const method = omission.method === omission.method.toUpperCase() ? omission.method : '';
    return {
      method,
      path,
      tags,
      ...(operationId === undefined ? {} : { operationId }),
      ...(toolName === undefined ? {} : { toolName }),
    };
  });

// A named operation as a pattern sees it, with its generated tool name
export const targetOf = (named: NamedOperation): FilterTarget => ({
  method: named.operation.method,
  path: named.operation.path,
  tags: named.operation.tags,
  toolName: named.toolName,
  ...(named.operation.operationId === undefined
    ? {}
    : { operationId: named.operation.operationId }),
});

// A "method:" or "route:" pattern may name a method outside the standard ones
// only when an operation of this spec declares it (OpenAPI 3.2
// `additionalOperations`), also one omitted as not supported. Anything else
// is a misspelling, which stays a usage error: a misspelled --deny method
// would otherwise deny nothing.
export const assertKnownMethods = (
  patterns: readonly FilterPattern[],
  records: readonly { method: string }[],
): void => {
  const declared = new Set(records.map((op) => op.method.toUpperCase()));
  for (const pattern of patterns) {
    if (
      (pattern.kind === 'method' || pattern.kind === 'route') &&
      !STANDARD_FILTER_METHODS.has(pattern.method) &&
      !declared.has(pattern.method)
    ) {
      throw usageError(
        `a "${pattern.kind}:" filter pattern names ${pattern.method}, which is not a standard method and no operation in the spec declares`,
      );
    }
  }
};

// Dead patterns of one flag. A pattern that names only operations omitted as
// not supported says so instead of suggesting an unrelated operation.
export const deadPatternsWithOmitted = (
  patterns: readonly FilterPattern[],
  flag: DeadPatternFlag,
  records: readonly FilterTarget[],
  omitted: readonly FilterTarget[],
  budget: MatchBudget,
): DeadPattern[] => {
  const byRaw = new Map(patterns.map((pattern) => [pattern.raw, pattern]));
  return deadPatternsFor(patterns, flag, records, budget).map((dead) => {
    const pattern = byRaw.get(dead.raw);
    return pattern !== undefined &&
      omitted.some((target) => matchesOperation(pattern, target, budget))
      ? { raw: dead.raw, flag, notExposed: true as const }
      : dead;
  });
};

const filteredOutRecord = (
  named: NamedOperation,
  decision: NotExposedDecision,
  reason: string,
  pattern?: string,
): NotExposedOperation => ({
  method: named.operation.method.toUpperCase(),
  path: named.operation.path,
  ...(named.operation.operationId === undefined
    ? {}
    : { operationId: named.operation.operationId }),
  toolName: named.toolName,
  tags: named.operation.tags,
  decision,
  ...(pattern === undefined ? {} : { pattern }),
  reason,
});

// ONE budget for the whole run — exposure and dead-pattern detection alike.
// Scoping it per match would bound nothing: the reachable cost is the aggregate
// over patterns x operations x candidate lengths, which is what measured 22.5 s
// at the maximum admitted dimensions even with a non-backtracking matcher.
export const applyFilters = (
  operations: readonly NamedOperation[],
  allow: readonly FilterPattern[],
  deny: readonly FilterPattern[],
  budget: MatchBudget = createMatchBudget(),
  omitted: readonly OmittedOperation[] = [],
): FilterDecision => {
  const records = operations.map((entry) => targetOf(entry));
  const omittedOps = omittedTargets(omitted);
  assertKnownMethods([...allow, ...deny], [...records, ...omittedOps]);
  const exposed: NamedOperation[] = [];
  const filteredOut: NotExposedOperation[] = [];
  for (const [index, named] of operations.entries()) {
    const target = records[index] ?? targetOf(named);
    // Rule 1: --deny always wins over --allow, no exceptions
    const denied = deny.find((pattern) => matchesOperation(pattern, target, budget));
    if (denied !== undefined) {
      filteredOut.push(
        filteredOutRecord(named, 'denied', `excluded by --deny "${denied.raw}"`, denied.raw),
      );
    } else if (allow.length > 0) {
      // Rule 2: an explicit allow replaces the default entirely, so a matching
      // write operation present at startup is exposed
      if (allow.some((pattern) => matchesOperation(pattern, target, budget))) {
        exposed.push(named);
      } else {
        filteredOut.push(filteredOutRecord(named, 'not-allowed', 'matched by no --allow pattern'));
      }
    } else if (READ_ONLY_METHODS.has(named.operation.method)) {
      // Rule 3: read-only default
      exposed.push(named);
    } else {
      filteredOut.push(
        filteredOutRecord(
          named,
          'read-only-default',
          'not a read operation, and without --allow only reads are exposed',
        ),
      );
    }
  }
  // A pattern is dead when it matches zero operations in the ENTIRE
  // normalized inventory, evaluated before exposure. Deliberately not "zero
  // exposed operations" — a deny pattern that removes everything an allow
  // pattern selected is doing its job, not misspelled, and a pattern naming a
  // write operation hidden by the read-only default matched perfectly well.
  const deadPatterns = [
    ...deadPatternsWithOmitted(allow, 'allow', records, omittedOps, budget),
    ...deadPatternsWithOmitted(deny, 'deny', records, omittedOps, budget),
  ];
  const caseCollisions = [
    ...caseCollisionsFor(allow, 'allow', records, budget),
    ...caseCollisionsFor(deny, 'deny', records, budget),
  ];
  return { exposed, filteredOut, deadPatterns, caseCollisions };
};

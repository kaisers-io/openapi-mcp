import {
  notExposedCounts,
  notExposedOperations,
  notExposedSummary,
  routeEntriesFor,
  routeOverlaps,
  sanitizeSpecText,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  BuildToolsResult,
  NotExposedCounts,
  NotExposedOperation,
  Route,
  RouteEntry,
  RouteOverlap,
  SpecPipelineResult,
} from '@kaisers-io/openapi-mcp-core';

// As spec-options' PATH_DISPLAY_MAX, which re-exports this module
const KEY_DISPLAY_MAX = 512;

// Startup warnings name this many overlaps; `tools --json` lists them all
export const OVERLAP_WARNING_MAX = 20;

export type ExposureReport = {
  notExposed: readonly NotExposedOperation[];
  counts: NotExposedCounts;
  // The request-authorization routes, for `serve`'s route table
  routeEntries: readonly RouteEntry[];
  // Absent when the overlap check's budget ran out before compiling them
  routes?: readonly Route[] | undefined;
  overlaps: readonly RouteOverlap[];
  overlapCheckComplete: boolean;
  warnings: readonly string[];
};

const display = (key: string): string => sanitizeSpecText(key, KEY_DISPLAY_MAX);

// What the operator should know about the operations that are not tools
// (issue #41), shared by `tools` and `serve`: one summary line counting them
// by reason, and each exposed tool that a request authorization refuses for
// some arguments because its path also matches an operation that is not
// exposed. Under --strict-filters such an overlap stops the start.
export const exposureReport = (
  result: SpecPipelineResult,
  built: BuildToolsResult,
  strictFilters: boolean,
  // Tests only: a smaller work budget for the overlap check
  overlapBudget?: number,
): ExposureReport => {
  const notExposed = notExposedOperations(result, built.omitted);
  // Compiled once: `serve` builds its route table from the same routes
  const routeEntries = routeEntriesFor(
    result.spec,
    result.withheldOperations,
    built.tools.map((tool) => tool.operation),
  );
  const { overlaps, complete, routes } = routeOverlaps(routeEntries, overlapBudget);
  const toolNames = new Map(
    built.tools.map((tool) => [
      `${tool.operation.method.toUpperCase()} ${tool.operation.path}`,
      tool.toolName,
    ]),
  );
  const overlapLines = overlaps
    .slice(0, OVERLAP_WARNING_MAX)
    .map(
      (overlap) =>
        `tool ${toolNames.get(overlap.exposed) ?? '?'} (${display(overlap.exposed)}): a request that also matches ${display(overlap.excluded)}, which is not exposed, is refused; review --allow, --deny and the spec`,
    );
  const more = overlaps.length - overlapLines.length;
  const lines = [
    ...overlapLines,
    ...(more > 0 ? [`and ${String(more)} more such overlaps, all listed by --json tools`] : []),
    ...(complete
      ? []
      : ['the check for overlapping paths ran out of its work budget, so the list is incomplete']),
  ];
  // An incomplete check cannot show there is none, so it fails too
  if (strictFilters && lines.length > 0) {
    throw validationError(lines.join('\n'));
  }
  const counts = notExposedCounts(notExposed);
  const summary = notExposedSummary(counts);
  return {
    notExposed,
    counts,
    routeEntries,
    routes,
    overlaps,
    overlapCheckComplete: complete,
    warnings: [...(summary === undefined ? [] : [summary]), ...lines],
  };
};

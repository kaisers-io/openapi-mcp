import {
  headsWithoutGet,
  notExposedCounts,
  notExposedOperations,
  notExposedSummary,
  routeEntriesFor,
  routeKey,
  routeOverlaps,
  sanitizeSpecText,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  BuildToolsResult,
  DeferredToolsResult,
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

export type ExposureReport<Built> = {
  // The tools without a HEAD whose GET is not exposed (issue #68)
  built: Built;
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
// A HEAD left out because its GET is not exposed (issue #68). `get` is that
// GET's path, or '' when it has another template that covers the HEAD's path.
const headRow = (
  tool: {
    toolName: string;
    operation: { path: string; operationId?: string; tags: readonly string[] };
  },
  get: string,
): NotExposedOperation => ({
  method: 'HEAD',
  path: tool.operation.path,
  ...(tool.operation.operationId === undefined ? {} : { operationId: tool.operation.operationId }),
  toolName: tool.toolName,
  tags: tool.operation.tags,
  decision: 'head-without-get',
  reason:
    get === ''
      ? 'a HEAD request reaches a GET on the same path, which is not exposed'
      : `a HEAD request reaches GET ${display(get)}, which is not exposed`,
});

export const exposureReport = <Built extends BuildToolsResult | DeferredToolsResult>(
  result: SpecPipelineResult,
  generated: Built,
  strictFilters: boolean,
  // Tests only: a smaller work budget for the overlap check
  overlapBudget?: number,
): ExposureReport<Built> => {
  const entriesOf = (tools: Built['tools']): RouteEntry[] =>
    routeEntriesFor(
      result.spec,
      result.withheldOperations,
      tools.map((tool) => tool.operation),
    );
  // A HEAD whose GET is not exposed is refused on every call: it is left
  // out, decided on the final tools, after toolgen and the output-schema
  // opt-out, so a GET omitted at any stage counts
  const unreachable = headsWithoutGet(entriesOf(generated.tools));
  const keyOf = (tool: Built['tools'][number]): string =>
    routeKey(tool.operation.method.toUpperCase(), tool.operation.path);
  const built: Built =
    unreachable.size === 0
      ? generated
      : { ...generated, tools: generated.tools.filter((tool) => !unreachable.has(keyOf(tool))) };
  const notExposed = [
    ...notExposedOperations(result, built.omitted),
    ...generated.tools
      .filter((tool) => unreachable.has(keyOf(tool)))
      .map((tool) => headRow(tool, unreachable.get(keyOf(tool)) ?? '')),
  ];
  // Compiled once: `serve` builds its route table from the same routes
  const routeEntries = entriesOf(built.tools);
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
    built,
    notExposed,
    counts,
    routeEntries,
    routes,
    overlaps,
    overlapCheckComplete: complete,
    warnings: [...(summary === undefined ? [] : [summary]), ...lines],
  };
};

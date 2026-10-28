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

type Tools = (BuildToolsResult | DeferredToolsResult)['tools'];
const keyOf = (tool: Tools[number]): string =>
  routeKey(tool.operation.method.toUpperCase(), tool.operation.path);

// Each exposed HEAD whose GET is not exposed, so every call it could make is
// refused (issue #68): by route key, with that GET's path. Known once the
// tools are generated: the output-schema opt-out drops none of them.
export const unreachableHeads = (
  result: Pick<SpecPipelineResult, 'spec' | 'withheldOperations'>,
  tools: Tools,
): ReadonlyMap<string, string> =>
  headsWithoutGet(
    routeEntriesFor(
      result.spec,
      result.withheldOperations,
      tools.map((tool) => tool.operation),
    ),
  );

// The tools without those HEADs
export const reachableTools = <Tool extends Tools[number]>(
  tools: readonly Tool[],
  unreachable: ReadonlyMap<string, string>,
): Tool[] => tools.filter((tool) => !unreachable.has(keyOf(tool)));

// A HEAD left out because a GET that is not exposed refuses every call it
// could make (issue #68); `get` is that GET's path
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
  reason: `every HEAD request also reaches GET ${display(get)}, which is not exposed`,
});

// What the operator should know about the operations that are not tools
// (issue #41), shared by `tools` and `serve`: one summary line counting them
// by reason, and each exposed tool that a request authorization refuses for
// some arguments because its path also matches an operation that is not
// exposed. Under --strict-filters such an overlap stops the start.
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
  const unreachable = unreachableHeads(result, generated.tools);
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
  // Compiled once: `serve` builds its route table from the same routes. A
  // HEAD left out above stays exposed there, as it was: leaving it out only
  // stops offering a tool no call could pass, and must not change how any
  // other request is authorized.
  const routeEntries = entriesOf(generated.tools);
  const reported = routeOverlaps(routeEntries, overlapBudget);
  const { complete, routes } = reported;
  const overlaps = reported.overlaps.filter((overlap) => !unreachable.has(overlap.exposed));
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

import { deepFreeze } from '../freeze.ts';
import type { DeadPattern } from '../filter/engine.ts';
import type { OmittedOperation } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { BuildToolsResult, DeferredToolsResult } from '../toolgen/build.ts';
import { assertObjectRoot, entriesOf, indexByName } from './operation-entry.ts';
import {
  byToolName,
  META_INPUT_SCHEMA,
  META_TOOL_NAME,
  metaWireTool,
  OMITTED_REASONS_CAP,
} from './wire-tools.ts';
import { buildDiscoveryTools, executeTool } from './discovery.ts';
import { buildSearchIndex } from './search-index.ts';
import type { ApiSummary, MetaSummary, ServerSnapshot, SnapshotTool, ToolMode } from './types.ts';

export { META_TOOL_NAME } from './wire-tools.ts';

// Same display-string bound the `tools` CLI command uses for a spec-derived
// path/reason (packages/cli/src/commands/tools.ts's PATH_DISPLAY_MAX) — kept
// as a plain local constant here rather than a shared export because the two
// call sites (CLI human-readable rows vs. the in-process meta tool payload)
// have no other coupling and shouldn't be forced to share a module for one
// number. `omitted[].path` is always raw spec text (a literal path key from
// the document); `omitted[].reason` CAN also embed raw spec text (e.g. an
// unrepresentable parameter's own name, per layout.ts/schema.ts) even though
// most reason strings are package-authored constants — sanitize both
// unconditionally rather than trying to distinguish the two cases.
const PATH_DISPLAY_MAX = 512;

const sanitizeOmission = (omission: OmittedOperation): OmittedOperation => ({
  method: omission.method,
  path: sanitizeSpecText(omission.path, PATH_DISPLAY_MAX),
  reason: sanitizeSpecText(omission.reason, PATH_DISPLAY_MAX),
});

// The subset of SpecPipelineResult the meta summary needs — deliberately
// narrower than the full result (no `namedOperations`, no `cacheStatus`, and
// crucially NO `candidateContentHash`): the meta tool reports the ACCEPTED
// baseline only — there is no runtime refresh or candidate-spec field to
// report — so the type itself makes threading a candidate hash through a
// mistake the compiler catches, not just a convention. `spec.omitted` is
// normalizeSpec's OWN omission source (cookie parameters, OPTIONS/TRACE,
// webhooks, path-level `servers` overrides, ...) — a DIFFERENT stage from
// `built.omitted` (buildTools' toolgen-level omissions: unrepresentable
// schemas, reserved-header conflicts). Both are real, distinct "why isn't
// this operation a tool" sources and both must reach the meta tool.
export type SnapshotPipelineInput = {
  spec: { title: string; specVersion: string; omitted: readonly OmittedOperation[] };
  contentHash: string;
  displaySource: string;
  deadPatterns: readonly DeadPattern[];
  // Accepted operations withheld because the pending candidate removed them
  // (kaisers-io/openapi-mcp-archive#60). They are reported with the other
  // omissions, each with its reason, so the meta tool shows exactly why a
  // baseline operation is not a tool.
  withheldOperations?: readonly OmittedOperation[] | undefined;
  // Every operation that is not a tool, counted by why (issue #41). Without
  // it only the omitted and withheld ones are counted.
  notExposedCounts?: MetaSummary['notExposedCounts'] | undefined;
  cacheLock?: 'held' | 'stale' | undefined;
  // Several APIs behind one server (issue #16): each one, with the fields
  // above as their sums
  apis?: readonly ApiSummary[] | undefined;
};

export type SnapshotOptions = {
  // Omitted means `per-operation`, whose snapshot is unchanged by this option.
  toolMode?: ToolMode;
  // --output-schema defs (issue #9): show output schemas in their compact
  // `$defs` form. Under `per-operation` the listed tools carry it; under
  // `discover` describe_operation computes it on demand, so startup does not
  // pay for operations nobody describes.
  compactOutputSchemas?: boolean;
  // --no-output-schema-descriptions (issue #49), shown the same way
  bareOutputSchemas?: boolean;
  // Several APIs behind one server (issue #16): their names, so a search can
  // name one; every tool name starts with `<api>_`
  apiNames?: readonly [string, ...string[]];
  // Also offer execute_code (issue #60), next to the discovery tools or the
  // operation tools
  execute?: boolean;
  // Under `discover`, sees an operation whose output side fails to build on
  // first use (the call or description that needed it gets a tool error)
  onDeferredError?: (toolName: string, error: unknown) => void;
};

export const buildSnapshot = (
  built: BuildToolsResult | DeferredToolsResult,
  pipeline: SnapshotPipelineInput,
  options: SnapshotOptions = {},
): ServerSnapshot => {
  const toolMode = options.toolMode ?? 'per-operation';
  const compact = options.compactOutputSchemas === true;
  const bare = options.bareOutputSchemas === true;
  const { entries, tools: upstreamTools } = entriesOf(built, toolMode, options);
  const metaTool: SnapshotTool = {
    kind: 'meta',
    name: META_TOOL_NAME,
    wireTool: metaWireTool(pipeline.apis !== undefined),
    inputSchema: META_INPUT_SCHEMA,
  };
  // Meta tool first, then the upstream tools sorted by name: the tools/list
  // order (and therefore its bytes, which clients and prompt caches key on)
  // depends only on WHICH operations exist, never on the order of keys in
  // the spec document — a YAML-to-JSON round trip or a registry that
  // re-serializes the spec cannot reorder the list. Under `discover` the
  // operations leave tools/list; the discovery tools take their place.
  const sortedEntries = entries.toSorted(byToolName);
  const all =
    toolMode === 'discover'
      ? [
          metaTool,
          ...buildDiscoveryTools(sortedEntries, options.apiNames),
          ...(options.execute === true ? [executeTool(toolMode)] : []),
        ]
      : [
          metaTool,
          ...upstreamTools.toSorted(byToolName),
          ...(options.execute === true ? [executeTool(toolMode)] : []),
        ];
  // Two separate namespaces under `discover`: an operation that happens to
  // be named `call_operation` is reached as call_operation's `name` argument
  // and never collides with the listed tool of that name.
  const toolsByName = indexByName(all);
  const operationsByName = indexByName(sortedEntries);
  // Every listed tool's schemas are checked here; an operation's were
  // checked when it was built (under `discover`, its output schema on first
  // use, before anything is sent)
  for (const tool of all) {
    assertObjectRoot(tool.name, 'inputSchema', tool.wireTool.inputSchema);
    if (tool.wireTool.outputSchema !== undefined) {
      assertObjectRoot(tool.name, 'outputSchema', tool.wireTool.outputSchema);
    }
  }
  // Merge BOTH omission sources (normalization-level + toolgen-level) before
  // capping/sanitizing — the COUNT below is the exact TOTAL across both; the
  // REASONS list is a capped, sanitized diagnostic sample of that total.
  const mergedOmitted: OmittedOperation[] = [
    ...pipeline.spec.omitted,
    ...built.omitted,
    ...(pipeline.withheldOperations ?? []),
  ];
  const meta: MetaSummary = {
    specTitle: pipeline.spec.title,
    specVersion: pipeline.spec.specVersion,
    displaySource: sanitizeSpecText(pipeline.displaySource, PATH_DISPLAY_MAX),
    toolCount: entries.length,
    omittedCount: mergedOmitted.length,
    omittedReasons: mergedOmitted
      .slice(0, OMITTED_REASONS_CAP)
      .map((omission) => sanitizeOmission(omission)),
    acceptedContentHash: pipeline.contentHash,
    deadPatternCount: pipeline.deadPatterns.length,
    notExposedCounts: pipeline.notExposedCounts ?? {
      denied: 0,
      'not-allowed': 0,
      'read-only-default': 0,
      omitted: pipeline.spec.omitted.length + built.omitted.length,
      withheld: pipeline.withheldOperations?.length ?? 0,
      'head-without-get': 0,
    },
    ...(pipeline.cacheLock === undefined ? {} : { cacheLock: pipeline.cacheLock }),
    ...(pipeline.apis === undefined
      ? {}
      : {
          apis: pipeline.apis.map((api) => ({
            ...api,
            specTitle: sanitizeSpecText(api.specTitle, PATH_DISPLAY_MAX),
            specVersion: sanitizeSpecText(api.specVersion, PATH_DISPLAY_MAX),
            displaySource: sanitizeSpecText(api.displaySource, PATH_DISPLAY_MAX),
          })),
        }),
  };
  return deepFreeze({
    toolMode,
    ...(compact ? { compactOutputSchemas: true as const } : {}),
    ...(bare ? { bareOutputSchemas: true as const } : {}),
    tools: all,
    toolsByName,
    operations: entries,
    operationsByName,
    ...(toolMode === 'discover' ? { searchIndex: buildSearchIndex(entries) } : {}),
    meta,
  });
};

import {
  sanitizeSpecText,
  selectUnsupportedParameterOptIn,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  BuildToolsResult,
  DeferredToolsResult,
  ExposedOperations,
  FilterPattern,
  GeneratedTool,
  OmittedOperation,
  SpecPipelineResult,
  UnsupportedParameterOptIn,
} from '@kaisers-io/openapi-mcp-core';
import { unreachableHeads } from './exposure-report.ts';
import { filterMessages } from './filter-messages.ts';

// As in spec-options, which re-exports this module
const PATTERN_DISPLAY_MAX = 256;
// Names at most this many tools or operations per line, each with at most
// this many parameters
const NAMES_MAX = 10;
const PARAMETERS_MAX = 3;
const PARAMETER_DISPLAY_MAX = 64;

const FLAG = '--omit-unsupported-parameters';

// --omit-unsupported-parameters (issue #67), matched on the operations the
// filters expose, before the tools are built. Its dead patterns are reported
// like the filters': a warning, or under --strict-filters an error (exit 3).
export const unsupportedParameterOptIn = (
  result: Pick<SpecPipelineResult, 'namedOperations' | 'spec'>,
  patterns: readonly FilterPattern[],
  strictFilters: boolean,
): { optIn: UnsupportedParameterOptIn; warnings: readonly string[] } => {
  const optIn = selectUnsupportedParameterOptIn(result.namedOperations, patterns, result.spec);
  const warnings = filterMessages(optIn);
  if (strictFilters && warnings.length > 0) {
    throw validationError(warnings.join('\n'));
  }
  return { optIn, warnings };
};

// `name (a, b)`, bounded. Tool names are generated identifiers; parameter
// names are spec text.
const named = (name: string, parameters: readonly string[]): string => {
  const shown = parameters
    .slice(0, PARAMETERS_MAX)
    .map((parameter) => sanitizeSpecText(parameter, PARAMETER_DISPLAY_MAX));
  const more = parameters.length > PARAMETERS_MAX ? ', …' : '';
  return `${name} (${shown.join(', ')}${more})`;
};

const listed = (entries: readonly string[]): string =>
  `${entries.slice(0, NAMES_MAX).join(', ')}${
    entries.length > NAMES_MAX ? ` and ${String(entries.length - NAMES_MAX)} more` : ''
  }`;

const counted = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

// What the operator should know: the tools that leave parameters out (never
// silent), the operations omitted only for such parameters (with the flag
// that would build them), and a pattern that leaves nothing out
export const unsupportedParameterLines = (
  tools: readonly Pick<GeneratedTool, 'toolName' | 'leftOutParameters'>[],
  omitted: readonly OmittedOperation[],
  optIn: Pick<UnsupportedParameterOptIn, 'matches'>,
): readonly string[] => {
  const leaving = tools.filter((tool) => (tool.leftOutParameters ?? []).length > 0);
  const leavingNames = new Set(leaving.map((tool) => tool.toolName));
  const omittable = omitted.filter((omission) => omission.omittableParameters !== undefined);
  return [
    ...optIn.matches
      .filter(
        (match) =>
          match.toolNames.length > 0 && !match.toolNames.some((name) => leavingNames.has(name)),
      )
      .map(
        (match) =>
          `${FLAG} "${sanitizeSpecText(match.raw, PATTERN_DISPLAY_MAX)}" matches no operation with an optional parameter this server cannot send, so it changes nothing`,
      ),
    ...(leaving.length === 0
      ? []
      : [
          `${FLAG}: ${counted(leaving.length, 'tool leaves', 'tools leave')} out optional parameters the agent cannot set: ${listed(
            leaving.map((tool) =>
              named(
                tool.toolName,
                (tool.leftOutParameters ?? []).map((parameter) => parameter.name),
              ),
            ),
          )}; each with its reason: openapi-mcp --json tools`,
        ]),
    ...(omittable.length === 0
      ? []
      : [
          `${counted(omittable.length, 'operation is', 'operations are')} omitted only for optional parameters this server cannot send; ${FLAG} <pattern> builds them without those parameters: ${listed(
            omittable.map((omission) =>
              named(
                omission.toolName ??
                  `${omission.method} ${sanitizeSpecText(omission.path, PATTERN_DISPLAY_MAX)}`,
                omission.omittableParameters ?? [],
              ),
            ),
          )}`,
        ]),
  ];
};

// The tools of one API, built inside the pipeline's `countTools` hook (issue
// #67): the tool budget then counts the tools that are actually served, and
// is enforced before the pipeline writes anything to the cache. `take`
// returns what the hook built, so nothing is built twice.
export const toolsBuiltInPipeline = <Built extends BuildToolsResult | DeferredToolsResult>(
  patterns: readonly FilterPattern[],
  build: (exposed: ExposedOperations, optIn: ReadonlySet<string>) => Built,
) => {
  let kept:
    | {
        built: Built;
        optIn: UnsupportedParameterOptIn;
        optInWarnings: readonly string[];
        unreachable: ReadonlyMap<string, string>;
      }
    | undefined;
  return {
    countTools: (exposed: ExposedOperations): number => {
      const { optIn, warnings } = unsupportedParameterOptIn(exposed, patterns, false);
      const built = build(exposed, optIn.toolNames);
      const unreachable = unreachableHeads(exposed, built.tools);
      kept = { built, optIn, optInWarnings: warnings, unreachable };
      // Each unreachable HEAD is one of these tools (exposure-report.ts)
      return built.tools.length - unreachable.size;
    },
    take: () => {
      if (kept === undefined) {
        throw new Error('the spec pipeline did not build the tools');
      }
      return kept;
    },
  };
};

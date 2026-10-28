import {
  applyOutputSchemaOptOut,
  sanitizeSpecText,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  BuildToolsResult,
  CaseCollision,
  DeadPattern,
  FilterPattern,
  GeneratedTool,
  NormalizedSpec,
} from '@kaisers-io/openapi-mcp-core';
import { filterMessages } from './filter-messages.ts';

// As in spec-options, which re-exports this module
const PATTERN_DISPLAY_MAX = 256;

// Names at most this many tools in the --omit-output-schema warning
const OPT_OUT_NAMES_MAX = 10;

// One startup line naming the tools --omit-output-schema took the output
// schema from (issue #13), so the relaxed validation is never silent.
// Tool names are generated identifiers, safe to print as they are.
export const outputSchemaOptOutWarningLines = (
  tools: readonly GeneratedTool[],
): readonly string[] => {
  const names = tools
    .filter((tool) => tool.outputSchemaOptedOut === true)
    .map((tool) => tool.toolName);
  if (names.length === 0) {
    return [];
  }
  const shown = names.slice(0, OPT_OUT_NAMES_MAX).join(', ');
  const more =
    names.length > OPT_OUT_NAMES_MAX ? ` and ${names.length - OPT_OUT_NAMES_MAX} more` : '';
  const count = names.length === 1 ? '1 tool' : `${names.length} tools`;
  return [
    `--omit-output-schema: response-schema validation is off for ${count}, results are returned as text: ${shown}${more}`,
  ];
};

export type OutputSchemaOptOutResult = {
  built: BuildToolsResult;
  deadPatterns: readonly DeadPattern[];
  caseCollisions: readonly CaseCollision[];
  warnings: readonly string[];
};

// --omit-output-schema (issue #13) on the generated tools, shared by `tools`
// and `serve`. Its dead patterns are reported like the filters': a warning,
// or under --strict-filters an error (exit 3).
export const withOutputSchemaOptOut = (
  built: BuildToolsResult,
  patterns: readonly FilterPattern[],
  spec: Pick<NormalizedSpec, 'operations' | 'omitted'>,
  strictFilters: boolean,
): OutputSchemaOptOutResult => {
  const optOut = applyOutputSchemaOptOut(built.tools, patterns, spec);
  const deadMessages = filterMessages(optOut);
  if (strictFilters && deadMessages.length > 0) {
    throw validationError(deadMessages.join('\n'));
  }
  return {
    built: { ...built, tools: optOut.tools },
    deadPatterns: optOut.deadPatterns,
    caseCollisions: optOut.caseCollisions,
    warnings: [
      ...deadMessages,
      ...optOut.ineffectivePatterns.map(
        (raw) =>
          `--omit-output-schema "${sanitizeSpecText(raw, PATTERN_DISPLAY_MAX)}" matches only tools without an output schema, so it changes nothing`,
      ),
      ...outputSchemaOptOutWarningLines(optOut.tools),
    ],
  };
};

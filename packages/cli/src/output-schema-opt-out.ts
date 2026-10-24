import type { GeneratedTool } from '@kaisers-io/openapi-mcp-core';

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

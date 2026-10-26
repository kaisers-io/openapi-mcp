import { createHash } from 'node:crypto';
import type { BuildToolsResult, DeferredToolsResult, GeneratedTool } from './build.ts';
import { TOOL_NAME_MAX_LENGTH } from './naming.ts';

// Several APIs behind one server (issue #16): every tool name becomes
// `<api>_<name>`. API names contain no `_` (see API_NAME_PATTERN), so the
// part before the first `_` is always the API. Filters ran before this, on
// the API's own names, so `name:` selectors keep naming what the spec does.

export const API_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

// API names that could form a fixed tool name (`openapi_mcp_status`,
// `search_operations`, `describe_operation`, `call_operation`) with an
// operation's own name (review of #16)
export const RESERVED_API_NAMES: ReadonlySet<string> = new Set([
  'openapi',
  'search',
  'describe',
  'call',
]);

// `<api>_<name>`, within the 64-character compatibility cap: a longer one
// keeps its start and ends with a hash of the full name, so it stays unique
// and the same on every start (review of #16)
export const qualifiedName = (api: string, toolName: string): string => {
  const full = `${api}_${toolName}`;
  if (full.length <= TOOL_NAME_MAX_LENGTH) {
    return full;
  }
  const suffix = `_${createHash('sha256').update(full).digest('hex').slice(0, 8)}`;
  return `${full.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
};

// The API a qualified name belongs to
export const apiOfToolName = (toolName: string): string => toolName.slice(0, toolName.indexOf('_'));

const renamed = (tool: GeneratedTool, toolName: string): GeneratedTool =>
  Object.freeze({ ...tool, toolName });

export const qualifyTools = <Built extends BuildToolsResult | DeferredToolsResult>(
  built: Built,
  api: string,
): Built => ({
  ...built,
  tools: built.tools.map((tool) => {
    const toolName = qualifiedName(api, tool.toolName);
    return 'complete' in tool
      ? {
          ...tool,
          toolName,
          complete: (seen?: WeakSet<object>) => renamed(tool.complete(seen), toolName),
        }
      : renamed(tool, toolName);
  }),
});

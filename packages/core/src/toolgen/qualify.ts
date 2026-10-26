import type { BuildToolsResult, DeferredToolsResult, GeneratedTool } from './build.ts';

// Several APIs behind one server (issue #16): every tool name becomes
// `<api>_<name>`. API names contain no `_` (see API_NAME_PATTERN), so the
// part before the first `_` is always the API. Filters ran before this, on
// the API's own names, so `name:` selectors keep naming what the spec does.

export const API_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export const qualifiedName = (api: string, toolName: string): string => `${api}_${toolName}`;

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

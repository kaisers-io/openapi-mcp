import { createHash } from 'node:crypto';
import type { BuildToolsResult, DeferredToolsResult, GeneratedTool } from './build.ts';
import { TOOL_NAME_MAX_LENGTH } from './naming.ts';

// Several APIs behind one server (issue #16): every tool name becomes
// `<api>_<name>`. API names contain no `_` (see API_NAME_PATTERN), so the
// part before the first `_` is always the API. Filters ran before this, on
// the API's own names, so `name:` selectors keep naming what the spec does.

export const API_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

// API names that could form a fixed tool name (`openapi_mcp_status`,
// `search_operations`, `describe_operation`, `call_operation`,
// `execute_code`) with an operation's own name (review of #16)
export const RESERVED_API_NAMES: ReadonlySet<string> = new Set([
  'openapi',
  'search',
  'describe',
  'call',
  'execute',
]);

const capped = (full: string, hashLength: number): string => {
  const suffix = `_${createHash('sha256').update(full).digest('hex').slice(0, hashLength)}`;
  return `${full.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
};

// `<api>_<name>`, within the 64-character compatibility cap: a longer one
// keeps its start and ends with a hash of the full name, so it stays unique
// and the same on every start (review of #16)
export const qualifiedName = (api: string, toolName: string): string => {
  const full = `${api}_${toolName}`;
  return full.length <= TOOL_NAME_MAX_LENGTH ? full : capped(full, 8);
};

// The qualified names of every tool of one API, unique by construction and
// decided over the whole spec, so a name keeps naming the same operation
// however the spec is ordered and whatever the filters expose (review of
// #16). A name that fits is kept as it is; a shortened one that lands on a
// taken name (one that fits, or another shortened one) becomes a hash of its
// full name and a round counter, round by round until every name is free.
// Each round needs a new name crafted to collide, so the rounds end.
export const qualifiedNames = (
  api: string,
  toolNames: readonly string[],
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  let pending: string[] = [];
  for (const toolName of new Set(toolNames)) {
    const full = `${api}_${toolName}`;
    if (full.length <= TOOL_NAME_MAX_LENGTH) {
      names.set(toolName, full);
    } else {
      pending.push(toolName);
    }
  }
  const taken = new Set(names.values());
  for (let round = 0; pending.length > 0; round += 1) {
    const candidates = pending.map((toolName) => {
      const full = `${api}_${toolName}`;
      return [
        toolName,
        round === 0 ? capped(full, 8) : capped(`${full}#${String(round)}`, 12),
      ] as const;
    });
    const counts = new Map<string, number>();
    for (const [, name] of candidates) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    pending = [];
    for (const [toolName, name] of candidates) {
      if (taken.has(name) || counts.get(name) !== 1) {
        pending.push(toolName);
      } else {
        names.set(toolName, name);
        taken.add(name);
      }
    }
  }
  return names;
};

// The API a qualified name belongs to
export const apiOfToolName = (toolName: string): string => toolName.slice(0, toolName.indexOf('_'));

const renamed = (tool: GeneratedTool, toolName: string): GeneratedTool =>
  Object.freeze({ ...tool, toolName });

// `allToolNames` are the names of every operation of the API's spec, before
// any filter: the qualified names are decided over all of them
export const qualifyTools = <Built extends BuildToolsResult | DeferredToolsResult>(
  built: Built,
  api: string,
  allToolNames: readonly string[],
): Built => {
  const names = qualifiedNames(api, [...allToolNames, ...built.tools.map((tool) => tool.toolName)]);
  return {
    ...built,
    tools: built.tools.map((tool) => {
      const toolName = names.get(tool.toolName) ?? qualifiedName(api, tool.toolName);
      return 'complete' in tool
        ? {
            ...tool,
            toolName,
            complete: (seen?: WeakSet<object>) => renamed(tool.complete(seen), toolName),
          }
        : renamed(tool, toolName);
    }),
  };
};

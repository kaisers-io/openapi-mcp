import {
  buildTools,
  runSpecPipeline,
  sanitizeSpecText,
  SYSTEM_HEADERS,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import { getGlobalOpts, wrapAction } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  PATH_DISPLAY_MAX,
  registerSpecOptions,
  type SpecCmdOpts,
} from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

interface ToolRow {
  name: string;
  method: string;
  path: string;
  summary?: string;
  deprecated: boolean;
}

export const registerTools: CommandRegistrar = (program, ctx, state) => {
  registerSpecOptions(program.command('tools'))
    .description(
      'preview the operation inventory an OpenAPI spec generates, with filters applied (no server)',
    )
    .action(async (cmdOpts: SpecCmdOpts) => {
      const opts = getGlobalOpts(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const args = parseSpecPipelineArgs(cmdOpts, ctx);
        const result = await runSpecPipeline(args.source, args.options, args.deps);
        const deadMessages = result.deadPatterns.map((dead) => deadPatternMessage(dead));
        if (cmdOpts.strictFilters === true && deadMessages.length > 0) {
          // Spec §8 mandates exit 3 for dead patterns under --strict-filters
          throw validationError(deadMessages.join('\n'));
        }
        const built = buildTools(result.namedOperations, {
          reservedHeaders: SYSTEM_HEADERS,
          openapiVersion: result.spec.openapiVersion,
        });
        const allOmitted = [...result.spec.omitted, ...built.omitted];
        const tools: ToolRow[] = built.tools.map((generated) => {
          const row: ToolRow = {
            name: generated.toolName,
            method: generated.operation.method.toUpperCase(),
            path: generated.operation.path,
            deprecated: generated.operation.deprecated,
          };
          if (generated.operation.summary !== undefined) {
            row.summary = generated.operation.summary;
          }
          return row;
        });
        const data = {
          source: result.displaySource,
          title: result.spec.title,
          specVersion: result.spec.specVersion,
          openapiVersion: result.spec.openapiVersion,
          contentHash: result.contentHash,
          ...(result.candidateContentHash === undefined
            ? {}
            : { candidateContentHash: result.candidateContentHash }),
          cacheStatus: result.cacheStatus,
          toolCount: tools.length,
          tools,
          omitted: allOmitted,
          deadPatterns: result.deadPatterns,
        };
        const humanLines: string[] = [
          `${data.title} ${data.specVersion} (OpenAPI ${data.openapiVersion}) — ${tools.length} ${
            tools.length === 1 ? 'tool' : 'tools'
          }`,
          `source: ${sanitizeSpecText(data.source, PATH_DISPLAY_MAX)}`,
          `cache: ${data.cacheStatus}`,
        ];
        const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 4);
        for (const tool of tools) {
          // Paths are untrusted spec text: sanitize the display copy only (the
          // JSON envelope keeps raw paths — JSON encoding escapes controls)
          humanLines.push(
            `  ${tool.name.padEnd(nameWidth)}  ${tool.method.padEnd(6)} ${sanitizeSpecText(tool.path, PATH_DISPLAY_MAX)}${
              tool.summary === undefined ? '' : ` — ${tool.summary}`
            }${tool.deprecated ? ' [deprecated]' : ''}`,
          );
        }
        // Omissions, dead patterns, and cache degradation are all non-fatal
        // conditions: they belong on the warnings channel, not on stdout
        return {
          data,
          humanLines,
          warnings: [...result.warnings, ...deadMessages, ...omissionWarningLines(allOmitted)],
        };
      });
    });
};

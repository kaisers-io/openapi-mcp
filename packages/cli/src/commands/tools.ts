import {
  buildTools,
  runSpecPipeline,
  sanitizeSpecText,
  summarizeSecurity,
  SYSTEM_HEADERS,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type { GeneratedTool } from '@kaisers-io/openapi-mcp-core';
import { getGlobalOpts, wrapAction } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  PATH_DISPLAY_MAX,
  registerSpecOptions,
} from '../spec-options.ts';
import type { SpecCmdOpts } from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

type ToolRow = {
  name: string;
  method: string;
  path: string;
  summary?: string;
  deprecated: boolean;
  outputSchema: boolean;
  // The outputSchema exists only because of --default-response-is-error.
  outputSchemaAssumesDefaultIsError?: true;
  // Why there is no outputSchema, when the tool description tells the agent
  // (#39: a response pattern with nested quantifiers).
  outputSchemaWithheld?: string;
};

const toToolRow = (generated: GeneratedTool): ToolRow => ({
  name: generated.toolName,
  method: generated.operation.method.toUpperCase(),
  path: generated.operation.path,
  deprecated: generated.operation.deprecated,
  ...(generated.operation.summary === undefined ? {} : { summary: generated.operation.summary }),
  outputSchema: generated.outputSchema !== undefined,
  ...(generated.outputSchemaAssumesDefaultIsError === true
    ? { outputSchemaAssumesDefaultIsError: true as const }
    : {}),
  ...(generated.outputSchemaWithheld === undefined
    ? {}
    : { outputSchemaWithheld: generated.outputSchemaWithheld }),
});

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
          // Dead patterns under --strict-filters must exit 3
          throw validationError(deadMessages.join('\n'));
        }
        const built = buildTools(result.namedOperations, {
          reservedHeaders: SYSTEM_HEADERS,
          openapiVersion: result.spec.openapiVersion,
          defaultResponseIsError: cmdOpts.defaultResponseIsError === true,
        });
        const allOmitted = [...result.spec.omitted, ...built.omitted];
        const tools: ToolRow[] = built.tools.map(toToolRow);
        // Which credential the exposed operations expect, per referenced
        // security scheme — the operator otherwise has to guess the header.
        const security = summarizeSecurity(
          result.spec,
          built.tools.map((tool) => tool.operation),
        );
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
          security,
        };
        const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 4);
        const humanLines: readonly string[] = [
          `${data.title} ${data.specVersion} (OpenAPI ${data.openapiVersion}) — ${tools.length} ${
            tools.length === 1 ? 'tool' : 'tools'
          }`,
          `source: ${sanitizeSpecText(data.source, PATH_DISPLAY_MAX)}`,
          `cache: ${data.cacheStatus}`,
          // Hints are already sanitized by describeSecurityScheme.
          ...security.map((entry) => `auth: ${entry.hint}`),
          // Paths are untrusted spec text: sanitize the display copy only (the
          // JSON envelope keeps raw paths — JSON encoding escapes controls)
          ...tools.map(
            (tool) =>
              `  ${tool.name.padEnd(nameWidth)}  ${tool.method.padEnd(6)} ${sanitizeSpecText(tool.path, PATH_DISPLAY_MAX)}${
                tool.summary === undefined ? '' : ` — ${tool.summary}`
              }${tool.deprecated ? ' [deprecated]' : ''}${
                tool.outputSchemaAssumesDefaultIsError === true
                  ? ' [output schema assumes default = error]'
                  : ''
              }`,
          ),
        ];
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

import type { Command } from '@commander-js/extra-typings';
import {
  buildTools,
  publicOmission,
  runSpecPipeline,
  sanitizeSpecText,
  summarizeSecurity,
  SYSTEM_HEADERS,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type { GeneratedTool, LeftOutParameter } from '@kaisers-io/openapi-mcp-core';
import { factsOf, inventoryCounts, schemeInventory, withFacts } from '../inventory-facts.ts';
import type { OperationFacts } from '../inventory-facts.ts';
import { getGlobalOpts, wrapAction } from '../output.ts';
import {
  filterMessages,
  exposureReport,
  omissionWarningLines,
  parseSpecPipelineArgs,
  PATH_DISPLAY_MAX,
  registerSpecOptions,
  nullableOption,
  toolsBuiltInPipeline,
  unsupportedParameterLines,
  withOutputSchemaOptOut,
} from '../spec-options.ts';
import type { SpecCmdOpts } from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

type ToolRow = OperationFacts & {
  name: string;
  method: string;
  path: string;
  summary?: string;
  deprecated: boolean;
  outputSchema: boolean;
  // The outputSchema exists only because of --default-response-is-error.
  outputSchemaAssumesDefaultIsError?: true;
  // --nullable-response-fields widened the outputSchema (some response
  // property also admits null). JSON output only: with the flag it applies to
  // nearly every tool, so a human-output marker would be noise.
  outputSchemaAdmitsNullFields?: true;
  // Why there is no outputSchema, when the tool description tells the agent
  // (kaisers-io/openapi-mcp-archive#39: a response pattern with nested
  // quantifiers).
  outputSchemaWithheld?: string;
  // --omit-output-schema took this tool's output schema (issue #13)
  outputSchemaOptedOut?: true;
  // --omit-unsupported-parameters left these out (issue #67)
  leftOutParameters?: readonly LeftOutParameter[];
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
  ...(generated.outputSchemaAdmitsNullFields === true
    ? { outputSchemaAdmitsNullFields: true as const }
    : {}),
  ...(generated.outputSchemaWithheld === undefined
    ? {}
    : { outputSchemaWithheld: generated.outputSchemaWithheld }),
  ...(generated.outputSchemaOptedOut === true ? { outputSchemaOptedOut: true as const } : {}),
  ...(generated.leftOutParameters === undefined
    ? {}
    : { leftOutParameters: generated.leftOutParameters }),
});

export const registerTools: CommandRegistrar = (program, ctx, state) => {
  // The cast restores SpecCmdOpts after the extra option, as in serve.ts
  (
    registerSpecOptions(program.command('tools')).option(
      '--allow-insecure-http',
      'permit a --spec-header-env credential over cleartext http to a non-loopback origin',
    ) as unknown as Command<[], SpecCmdOpts>
  )
    .description(
      'preview the operation inventory an OpenAPI spec generates, with filters applied (no server)',
    )
    .action(async (cmdOpts: SpecCmdOpts) => {
      const opts = getGlobalOpts(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const args = parseSpecPipelineArgs(cmdOpts, ctx);
        const building = toolsBuiltInPipeline(
          args.filters.omitUnsupportedParameters,
          (exposed, omitUnsupportedParameters) =>
            buildTools(exposed.namedOperations, {
              omitUnsupportedParameters,
              reservedHeaders: SYSTEM_HEADERS,
              openapiVersion: exposed.spec.openapiVersion,
              defaultResponseIsError: cmdOpts.defaultResponseIsError === true,
              ...nullableOption(cmdOpts.nullableResponseFields),
            }),
        );
        const result = await runSpecPipeline(
          args.source,
          { ...args.options, countTools: building.countTools },
          args.deps,
        );
        const { built: generated, optIn, optInWarnings } = building.take();
        const deadMessages = [...filterMessages(result), ...optInWarnings];
        if (cmdOpts.strictFilters === true && deadMessages.length > 0) {
          // Dead patterns under --strict-filters must exit 3
          throw validationError(deadMessages.join('\n'));
        }
        const optOut = withOutputSchemaOptOut(
          generated,
          args.filters.omitOutputSchema,
          result.spec,
          cmdOpts.strictFilters === true,
        );
        const exposure = exposureReport(result, optOut.built, cmdOpts.strictFilters === true);
        const { built } = exposure;
        const allOmitted = [...result.spec.omitted, ...built.omitted].map((omission) =>
          publicOmission(omission),
        );
        const tools: ToolRow[] = built.tools.map((tool) => ({
          ...toToolRow(tool),
          ...factsOf(tool.operation, result.spec),
        }));
        const notExposed = withFacts(exposure.notExposed, result.spec);
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
          counts: inventoryCounts(tools.length, notExposed),
          tools,
          omitted: allOmitted,
          // Every operation that is not a tool, with its reason (issue #41)
          notExposed,
          overlaps: exposure.overlaps,
          overlapCheckComplete: exposure.overlapCheckComplete,
          deadPatterns: [...result.deadPatterns, ...optOut.deadPatterns, ...optIn.deadPatterns],
          // Patterns that match values differing only by case (issue #42)
          caseCollisions: [
            ...result.caseCollisions,
            ...optOut.caseCollisions,
            ...optIn.caseCollisions,
          ],
          security,
          ...schemeInventory(result.spec, tools, notExposed),
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
          // JSON envelope keeps raw paths and jsonLine escapes the controls)
          ...tools.map(
            (tool) =>
              `  ${tool.name.padEnd(nameWidth)}  ${tool.method.padEnd(6)} ${sanitizeSpecText(tool.path, PATH_DISPLAY_MAX)}${
                tool.summary === undefined ? '' : ` — ${tool.summary}`
              }${tool.deprecated ? ' [deprecated]' : ''}${
                tool.outputSchemaAssumesDefaultIsError === true
                  ? ' [output schema assumes default = error]'
                  : ''
              }${tool.outputSchemaOptedOut === true ? ' [output schema omitted]' : ''}${
                tool.leftOutParameters === undefined
                  ? ''
                  : ` [${String(tool.leftOutParameters.length)} optional ${tool.leftOutParameters.length === 1 ? 'parameter' : 'parameters'} left out]`
              }`,
          ),
        ];
        // Omissions, dead patterns, and cache degradation are all non-fatal
        // conditions: they belong on the warnings channel, not on stdout
        return {
          data,
          humanLines,
          warnings: [
            ...result.warnings,
            ...deadMessages,
            ...omissionWarningLines(allOmitted),
            ...unsupportedParameterLines(built.tools, built.omitted, optIn),
            ...optOut.warnings,
            ...exposure.warnings,
          ],
          warningReasons: result.warningReasons,
        };
      });
    });
};

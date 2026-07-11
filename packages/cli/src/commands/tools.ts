import {
  parseDuration,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  runSpecPipeline,
  sanitizeSpecText,
} from '@kaisers-io/openapi-mcp-core';
import { getGlobalOpts, wrapAction } from '../output.ts';
import type { CommandRegistrar } from './registry.ts';

const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Cap for untrusted display strings (paths) in human terminal output
const PATH_DISPLAY_MAX = 512;

export const registerTools: CommandRegistrar = (program, ctx, state) => {
  program
    .command('tools')
    .description(
      'preview the operation inventory an OpenAPI spec generates (no server; filters land in M2b)',
    )
    .requiredOption('--spec <url|file>', 'OpenAPI spec source, JSON or YAML')
    .option(
      '--spec-header-env <Header=ENV>',
      'auth header for the spec fetch, value read from env (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option('--timeout <duration>', 'spec fetch timeout (<int><s|m|h|d>)', '30s')
    .option(
      '--allow-private-network',
      'permit private/loopback redirect targets during the spec fetch (never cloud-metadata)',
    )
    .action(async (cmdOpts) => {
      const opts = getGlobalOpts(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const mappings = cmdOpts.specHeaderEnv.map((raw) => parseHeaderEnvMapping(raw));
        const specHeaders = resolveHeaderEnvMappings(mappings, ctx.env);
        const timeoutMs = parseDuration(cmdOpts.timeout);
        const result = await runSpecPipeline(
          cmdOpts.spec,
          {
            specHeaders,
            timeoutMs,
            cwd: ctx.cwd(),
            allowPrivateNetwork: cmdOpts.allowPrivateNetwork === true,
          },
          {
            fetcher: ctx.fetcher,
            lookup: ctx.lookup,
            readFileText: ctx.readFileText,
            fileSizeBytes: ctx.fileSizeBytes,
          },
        );
        const tools = result.namedOperations.map((named) => ({
          name: named.toolName,
          method: named.operation.method.toUpperCase(),
          path: named.operation.path,
          ...(named.operation.summary === undefined ? {} : { summary: named.operation.summary }),
          deprecated: named.operation.deprecated,
        }));
        const data = {
          source: result.displaySource,
          title: result.spec.title,
          specVersion: result.spec.specVersion,
          openapiVersion: result.spec.openapiVersion,
          contentHash: result.contentHash,
          toolCount: tools.length,
          tools,
          omitted: result.spec.omitted,
        };
        const humanLines: string[] = [
          `${data.title} ${data.specVersion} (OpenAPI ${data.openapiVersion}) — ${tools.length} ${
            tools.length === 1 ? 'tool' : 'tools'
          }`,
          `source: ${sanitizeSpecText(data.source, PATH_DISPLAY_MAX)}`,
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
        if (result.spec.omitted.length > 0) {
          humanLines.push('omitted operations:');
          for (const omission of result.spec.omitted) {
            humanLines.push(
              `  ${omission.method} ${sanitizeSpecText(omission.path, PATH_DISPLAY_MAX)} — ${omission.reason}`,
            );
          }
        }
        return { data, humanLines };
      });
    });
};

import {
  defaultCacheRoot,
  parseCacheKey,
  parseDuration,
  parseFilterPatterns,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  runSpecPipeline,
  sanitizeSpecText,
  validationError,
  type DeadPattern,
  type FilterPattern,
} from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from '../context.ts';
import { getGlobalOpts, wrapAction } from '../output.ts';
import type { CommandRegistrar } from './registry.ts';

const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Cap for untrusted display strings (paths) in human terminal output
const PATH_DISPLAY_MAX = 512;

// Patterns are operator input, but they are echoed next to spec-derived
// suggestions, so the whole warning line is bounded
const PATTERN_DISPLAY_MAX = 256;

export interface ParsedFilters {
  allow: readonly FilterPattern[];
  deny: readonly FilterPattern[];
}

// Patterns parse in the command layer so a syntax error, an over-long pattern,
// a wildcard bomb, or too many patterns is a usage error (exit 2) before any
// network or filesystem access happens. Every D15 bound — length, wildcards,
// and count — lives inside parseFilterPatterns, so this helper is only the
// argv-to-core adapter and has no bound of its own to keep in sync.
export const parseFilters = (
  allowRaw: readonly string[],
  denyRaw: readonly string[],
): ParsedFilters => ({
  allow: parseFilterPatterns(allowRaw),
  deny: parseFilterPatterns(denyRaw),
});

// Spec §8 wording: --allow "readPets" matches no operation; closest: readPetById
// The flag comes from the engine, which knows which list the pattern came from
export const deadPatternMessage = (dead: DeadPattern): string => {
  const raw = sanitizeSpecText(dead.raw, PATTERN_DISPLAY_MAX);
  const base = `--${dead.flag} "${raw}" matches no operation`;
  return dead.suggestion === undefined
    ? base
    : `${base}; closest: ${sanitizeSpecText(dead.suggestion, PATTERN_DISPLAY_MAX)}`;
};

const cacheRootOf = (ctx: CliContext): string | undefined => {
  const home = ctx.homeDir();
  return home === undefined || home === '' ? undefined : defaultCacheRoot(home);
};

export const registerTools: CommandRegistrar = (program, ctx, state) => {
  program
    .command('tools')
    .description(
      'preview the operation inventory an OpenAPI spec generates, with filters applied (no server)',
    )
    .requiredOption('--spec <url|file>', 'OpenAPI spec source, JSON or YAML')
    .option('--allow <pattern>', 'whitelist pattern (repeatable)', collect, [] as readonly string[])
    .option(
      '--deny <pattern>',
      'blacklist pattern, always wins (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option('--strict-filters', 'exit with an error instead of a warning on dead patterns')
    .option(
      '--spec-header-env <Header=ENV>',
      'auth header for the spec fetch, value read from env (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option('--timeout <duration>', 'spec fetch timeout (<int><s|m|h|d>)', '30s')
    .option('--ttl <duration>', 'spec refresh interval (<int><s|m|h|d>)', '1h')
    .option('--cache-key <name>', 'durable cache namespace label; required for authenticated specs')
    .option('--trust-spec-updates', 'auto-accept refreshed specs instead of gating them')
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
        const ttlMs = parseDuration(cmdOpts.ttl);
        const cacheKey =
          cmdOpts.cacheKey === undefined ? undefined : parseCacheKey(cmdOpts.cacheKey);
        const filters = parseFilters(cmdOpts.allow, cmdOpts.deny);
        const result = await runSpecPipeline(
          cmdOpts.spec,
          {
            specHeaders,
            timeoutMs,
            cwd: ctx.cwd(),
            allowPrivateNetwork: cmdOpts.allowPrivateNetwork === true,
            allow: filters.allow,
            deny: filters.deny,
            ttlMs,
            ...(cacheKey === undefined ? {} : { cacheKey }),
            trustSpecUpdates: cmdOpts.trustSpecUpdates === true,
            cacheRoot: cacheRootOf(ctx),
            nowMs: ctx.now(),
          },
          {
            fetcher: ctx.fetcher,
            lookup: ctx.lookup,
            readFileText: ctx.readFileText,
            fileSizeBytes: ctx.fileSizeBytes,
            cacheFs: ctx.cacheFs,
          },
        );
        const deadMessages = result.deadPatterns.map((dead) => deadPatternMessage(dead));
        if (cmdOpts.strictFilters === true && deadMessages.length > 0) {
          // Spec §8 mandates exit 3 for dead patterns under --strict-filters
          throw validationError(deadMessages.join('\n'));
        }
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
          ...(result.candidateContentHash === undefined
            ? {}
            : { candidateContentHash: result.candidateContentHash }),
          cacheStatus: result.cacheStatus,
          toolCount: tools.length,
          tools,
          omitted: result.spec.omitted,
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
        const omissionWarnings = result.spec.omitted.map(
          (omission) =>
            `omitted ${omission.method} ${sanitizeSpecText(omission.path, PATH_DISPLAY_MAX)} — ${omission.reason}`,
        );
        return {
          data,
          humanLines,
          warnings: [...result.warnings, ...deadMessages, ...omissionWarnings],
        };
      });
    });
};

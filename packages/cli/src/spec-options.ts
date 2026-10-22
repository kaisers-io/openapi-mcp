import type { Command } from '@commander-js/extra-typings';
import {
  defaultCacheRoot,
  parseCacheKey,
  parseAgeDuration,
  parseDuration,
  parseFilterPatterns,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  sanitizeSpecText,
} from '@kaisers-io/openapi-mcp-core';
import type {
  DeadPattern,
  FilterPattern,
  OmittedOperation,
  ResolvedHeader,
  SpecPipelineDeps,
  SpecPipelineOptions,
} from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from './context.ts';

const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Cap for untrusted display strings (paths) in human terminal output
export const PATH_DISPLAY_MAX = 512;

// Patterns are operator input, but they are echoed next to spec-derived
// suggestions, so the whole warning line is bounded
export const PATTERN_DISPLAY_MAX = 256;

// Example wording: --allow "readPets" matches no operation; closest: readPetById
// The flag comes from the engine, which knows which list the pattern came from.
// Shared by `tools` and `serve` so a dead-pattern warning is sanitized and
// worded identically regardless of which command produced it.
export const deadPatternMessage = (dead: DeadPattern): string => {
  const raw = sanitizeSpecText(dead.raw, PATTERN_DISPLAY_MAX);
  const base = `--${dead.flag} "${raw}" matches no operation`;
  return dead.suggestion === undefined
    ? base
    : `${base}; closest: ${sanitizeSpecText(dead.suggestion, PATTERN_DISPLAY_MAX)}`;
};

// Omissions (spec-level and toolgen-level) are a non-fatal condition: they
// belong on the warnings channel, not on stdout. Shared by `tools` and `serve`
// so both commands sanitize and word an omission warning identically.
export const omissionWarningLines = (allOmitted: readonly OmittedOperation[]): readonly string[] =>
  allOmitted.map(
    (omission) =>
      `omitted ${omission.method} ${sanitizeSpecText(omission.path, PATH_DISPLAY_MAX)} — ${sanitizeSpecText(omission.reason, PATH_DISPLAY_MAX)}`,
  );

export type ParsedFilters = {
  allow: readonly FilterPattern[];
  deny: readonly FilterPattern[];
};

// Patterns parse in the command layer so a syntax error, an over-long
// pattern, a wildcard bomb, or too many patterns is a usage error (exit 2)
// before any network or filesystem access happens.
export const parseFilters = (
  allowRaw: readonly string[],
  denyRaw: readonly string[],
): ParsedFilters => ({
  allow: parseFilterPatterns(allowRaw),
  deny: parseFilterPatterns(denyRaw),
});

const cacheRootOf = (ctx: CliContext): string | undefined => {
  const home = ctx.homeDir();
  return home === undefined || home === '' ? undefined : defaultCacheRoot(home);
};

export type SpecCmdOpts = {
  // Commander's own `Command<Args, Opts, GlobalOpts>` generic constrains
  // `Opts` to `OptionValues` (`Record<string, any>`), which TS's generic
  // constraint check only accepts from a type carrying an explicit index
  // signature (a plain object literal type is rejected even though it is
  // structurally assignable) — required below so `registerSpecOptions` can
  // name `Command<[], SpecCmdOpts>` as its return type.
  [key: string]: unknown;
  spec: string;
  allow: readonly string[];
  deny: readonly string[];
  strictFilters?: boolean;
  specHeaderEnv: readonly string[];
  timeout: string;
  ttl: string;
  cacheKey?: string;
  trustSpecUpdates?: boolean;
  allowPrivateNetwork?: boolean;
};

// The --spec/--allow/--deny/... flags shared by every command that runs the
// spec pipeline (`tools`, `serve`). Registering them in one place keeps their
// help text, defaults, and parsing identical across commands — a change here
// changes both commands together, never one silently. The return type is
// pinned to `SpecCmdOpts` rather than threaded through generically: commander
// re-derives a brand-new `Command<Args, Opts, GlobalOpts>` type on every
// `.option()`/`.requiredOption()` call (never `this`), so a generic input
// parameter can never carry the accumulated option shape back out through a
// factored-out function — `SpecCmdOpts` is the hand-written mirror of
// exactly that accumulated shape, and every option below must keep matching
// it (a caller's `.action((cmdOpts: SpecCmdOpts) => ...)` is what actually
// enforces that, since a drifted shape fails typecheck there).
// GlobalOpts is left unspecified: the class default is already `{}`.
export const registerSpecOptions = (command: Command): Command<[], SpecCmdOpts> =>
  command
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
    .option(
      '--ttl <duration>',
      'how long a cached spec is used before it is re-validated at startup (<int><s|m|h|d>, up to 365d)',
      '1h',
    )
    .option('--cache-key <name>', 'durable cache namespace label; required for authenticated specs')
    .option('--trust-spec-updates', 'auto-accept refreshed specs instead of gating them')
    .option(
      '--allow-private-network',
      'permit private/loopback redirect targets during the spec fetch (never cloud-metadata)',
    );

export type SpecPipelineArgs = {
  source: string;
  options: SpecPipelineOptions;
  deps: SpecPipelineDeps;
  filters: ParsedFilters;
};

// Builds the exact runSpecPipeline call shape both `tools` and `serve` need,
// so their spec/cache/filter behaviour can never silently diverge.
export const parseSpecPipelineArgs = (cmdOpts: SpecCmdOpts, ctx: CliContext): SpecPipelineArgs => {
  const mappings = cmdOpts.specHeaderEnv.map((raw) => parseHeaderEnvMapping(raw));
  const specHeaders: readonly ResolvedHeader[] = resolveHeaderEnvMappings(mappings, ctx.env);
  const timeoutMs = parseDuration(cmdOpts.timeout, '--timeout');
  // An age, not a timer: --ttl is only compared with a cache entry's age, so
  // it is not bound by the Node timer limit that --timeout is (#88)
  const ttlMs = parseAgeDuration(cmdOpts.ttl, '--ttl');
  const cacheKey = cmdOpts.cacheKey === undefined ? undefined : parseCacheKey(cmdOpts.cacheKey);
  const filters = parseFilters(cmdOpts.allow, cmdOpts.deny);
  return {
    source: cmdOpts.spec,
    options: {
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
    deps: {
      fetcher: ctx.fetcher,
      lookup: ctx.lookup,
      readFileText: ctx.readFileText,
      fileSizeBytes: ctx.fileSizeBytes,
      cacheFs: ctx.cacheFs,
    },
    filters,
  };
};

import type { Command } from '@commander-js/extra-typings';
import {
  applyOutputSchemaOptOut,
  defaultCacheRoot,
  parseCacheKey,
  parseAgeDuration,
  parseDuration,
  parseFilterPatterns,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  sanitizeSpecText,
  usageError,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  BuildToolsResult,
  CaseCollision,
  DeadPattern,
  FilterPattern,
  NormalizedSpec,
  NullableFieldScope,
  OmittedOperation,
  ResolvedHeader,
  SpecPipelineDeps,
  SpecPipelineOptions,
} from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from './context.ts';
import { filterMessages } from './filter-messages.ts';
import { outputSchemaOptOutWarningLines } from './output-schema-opt-out.ts';

export { exposureReport } from './exposure-report.ts';
export { caseCollisionMessage, deadPatternMessage, filterMessages } from './filter-messages.ts';

const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Cap for untrusted display strings (paths) in human terminal output
export const PATH_DISPLAY_MAX = 512;

// Patterns are operator input, but they are echoed next to spec-derived
// suggestions, so the whole warning line is bounded
export const PATTERN_DISPLAY_MAX = 256;

// Omissions (spec-level and toolgen-level) are a non-fatal condition: they
// belong on the warnings channel, not on stdout. Shared by `tools` and `serve`
// so both commands sanitize and word an omission warning identically.
export const omissionWarningLines = (allOmitted: readonly OmittedOperation[]): readonly string[] =>
  allOmitted.map(
    (omission) =>
      `omitted ${omission.method} ${sanitizeSpecText(omission.path, PATH_DISPLAY_MAX)} — ${sanitizeSpecText(omission.reason, PATH_DISPLAY_MAX)}`,
  );

export type OutputSchemaOptOutResult = {
  built: BuildToolsResult;
  deadPatterns: readonly DeadPattern[];
  caseCollisions: readonly CaseCollision[];
  warnings: readonly string[];
};

// --omit-output-schema (issue #13) on the generated tools, shared by `tools`
// and `serve`. Its dead patterns are reported like the filters': a warning,
// or under --strict-filters an error (exit 3).
export const withOutputSchemaOptOut = (
  built: BuildToolsResult,
  patterns: readonly FilterPattern[],
  spec: Pick<NormalizedSpec, 'operations' | 'omitted'>,
  strictFilters: boolean,
): OutputSchemaOptOutResult => {
  const optOut = applyOutputSchemaOptOut(built.tools, patterns, spec);
  const deadMessages = filterMessages(optOut);
  if (strictFilters && deadMessages.length > 0) {
    throw validationError(deadMessages.join('\n'));
  }
  return {
    built: { ...built, tools: optOut.tools },
    deadPatterns: optOut.deadPatterns,
    caseCollisions: optOut.caseCollisions,
    warnings: [
      ...deadMessages,
      ...optOut.ineffectivePatterns.map(
        (raw) =>
          `--omit-output-schema "${sanitizeSpecText(raw, PATTERN_DISPLAY_MAX)}" matches only tools without an output schema, so it changes nothing`,
      ),
      ...outputSchemaOptOutWarningLines(optOut.tools),
    ],
  };
};

export type ParsedFilters = {
  allow: readonly FilterPattern[];
  deny: readonly FilterPattern[];
  omitOutputSchema: readonly FilterPattern[];
};

// Patterns parse in the command layer so a syntax error, an over-long
// pattern, a wildcard bomb, or too many patterns is a usage error (exit 2)
// before any network or filesystem access happens.
export const parseFilters = (
  allowRaw: readonly string[],
  denyRaw: readonly string[],
  omitOutputSchemaRaw: readonly string[],
): ParsedFilters => ({
  allow: parseFilterPatterns(allowRaw),
  deny: parseFilterPatterns(denyRaw),
  omitOutputSchema: parseFilterPatterns(omitOutputSchemaRaw),
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
  defaultResponseIsError?: boolean;
  // `true` when the flag is given without a value
  nullableResponseFields?: boolean | string;
  omitOutputSchema: readonly string[];
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
//
// The one deliberate difference is the --allow-private-network help text:
// `tools` only fetches the spec, while in `serve` the same flag also governs
// API egress (a private spec-derived servers[0] origin and redirect hops), so
// each command describes the scope the flag actually has there.
const SPEC_FETCH_PRIVATE_NETWORK_HELP =
  'permit private/loopback redirect targets during the spec fetch (never cloud-metadata)';

export const registerSpecOptions = (
  command: Command,
  allowPrivateNetworkHelp: string = SPEC_FETCH_PRIVATE_NETWORK_HELP,
  // `serve` also takes several APIs through --api (issue #16), and checks
  // that one of the two is given itself
  specRequired = true,
): Command<[], SpecCmdOpts> =>
  (specRequired
    ? command.requiredOption('--spec <url|file>', 'OpenAPI spec source, JSON or YAML')
    : command.option(
        '--spec <url|file>',
        'OpenAPI spec source, JSON or YAML (or several APIs with --api)',
      )
  )
    .option(
      '--allow <pattern>',
      'expose what this selector matches: method:, path:, route:, operationId:, name: or tag: (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option(
      '--deny <pattern>',
      'exclude what this selector matches, always wins (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option(
      '--strict-filters',
      'exit with an error instead of a warning on dead patterns, case collisions and tools whose path overlaps an excluded one',
    )
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
    .option('--allow-private-network', allowPrivateNetworkHelp)
    .option(
      '--default-response-is-error',
      'derive output schemas for operations with a "default" response, assuming it covers errors only (an undocumented 2xx then fails)',
    )
    .option(
      '--nullable-response-fields [scope]',
      'admit null for object properties in derived output schemas (for specs, e.g. springdoc, that omit "nullable"): every property (all, the default) or only those not listed in "required" (optional)',
    )
    .option(
      '--omit-output-schema <pattern>',
      'declare no output schema for matching tools, whose responses do not match the spec: results are returned as text without response-schema validation (repeatable, --allow selectors)',
      collect,
      [] as readonly string[],
    ) as unknown as Command<[], SpecCmdOpts>;

const NULLABLE_FIELD_SCOPES: readonly NullableFieldScope[] = ['all', 'optional'];

// --nullable-response-fields: absent is off, bare is `all` (its meaning
// before the scope existed), otherwise the named scope (issue #17).
const parseNullableResponseFields = (
  raw: boolean | string | undefined,
): NullableFieldScope | undefined => {
  if (raw === undefined || raw === false) {
    return undefined;
  }
  if (raw === true) {
    return 'all';
  }
  const scope = NULLABLE_FIELD_SCOPES.find((candidate) => candidate === raw);
  if (scope === undefined) {
    throw usageError(
      `--nullable-response-fields "${raw}" is not one of ${NULLABLE_FIELD_SCOPES.join(', ')}`,
    );
  }
  return scope;
};

// The buildTools option for the parsed flag, absent when it is off.
export const nullableOption = (
  raw: boolean | string | undefined,
): { nullableResponseFields?: NullableFieldScope } => {
  const scope = parseNullableResponseFields(raw);
  return scope === undefined ? {} : { nullableResponseFields: scope };
};

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
  // it is not bound by the Node timer limit that --timeout is
  // (kaisers-io/openapi-mcp-archive#88)
  const ttlMs = parseAgeDuration(cmdOpts.ttl, '--ttl');
  const cacheKey = cmdOpts.cacheKey === undefined ? undefined : parseCacheKey(cmdOpts.cacheKey);
  const filters = parseFilters(cmdOpts.allow, cmdOpts.deny, cmdOpts.omitOutputSchema);
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
      ...(ctx.readFileBytes === undefined ? {} : { readFileBytes: ctx.readFileBytes }),
      fileSizeBytes: ctx.fileSizeBytes,
      cacheFs: ctx.cacheFs,
    },
    filters,
  };
};

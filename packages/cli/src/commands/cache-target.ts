import type { Command } from '@commander-js/extra-typings';
import {
  cacheLayout,
  cacheNamespace,
  canonicalSourceOf,
  clearNamespace,
  defaultCacheRoot,
  listNamespaceIds,
  OpenapiMcpError,
  parseCacheId,
  parseCacheKey,
  parseSpecSource,
  sanitizeSpecText,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type { CacheEntrySummary, CacheLayout } from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from '../context.ts';
import { getGlobalOpts } from '../output.ts';

// Split out of cache.ts: import/max-dependencies is scoped off only for
// spec/pipeline.ts and cache/store.ts, not disabled for the whole repository,
// so it is enforced for cache.ts too. These are the shared target-resolution
// helpers every cache subcommand needs, so they live in their own module
// rather than widening the override.

export const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Cache display values are spec- or remote-derived: bound them for the terminal
export const CACHE_DISPLAY_MAX = 512;

export const rootOf = (ctx: CliContext): string => {
  const home = ctx.homeDir();
  if (home === undefined || home === '') {
    throw validationError('cannot resolve the home directory for the openapi-mcp cache root');
  }
  return defaultCacheRoot(home);
};

// One entry's display block for `cache list`: 4 fixed lines, plus a 5th only
// when a candidate is pending promotion. Split out here (rather than kept
// inline in cache.ts's flatMap) alongside cache.ts's other line-budget
// extractions (see clearAllNamespaces below).
export const entryDisplayLines = (entry: CacheEntrySummary): readonly string[] => [
  `  ${entry.id}  ${sanitizeSpecText(entry.title, CACHE_DISPLAY_MAX)} ${sanitizeSpecText(
    entry.specVersion,
    CACHE_DISPLAY_MAX,
  )}`,
  `    source:    ${sanitizeSpecText(entry.displaySource, CACHE_DISPLAY_MAX)}`,
  // The label is charset-restricted and never secret, so it prints raw
  `    key:       ${entry.cacheKey ?? '(none)'}`,
  `    fetched:   ${new Date(entry.fetchedAt).toISOString()}`,
  `    accepted:  ${entry.acceptedContentHash}`,
  ...(entry.candidateContentHash === undefined
    ? []
    : [`    candidate: ${entry.candidateContentHash} (pending promotion)`]),
];

export const layoutForSpec = (
  ctx: CliContext,
  spec: string,
  cacheKey: string | undefined,
): CacheLayout => {
  const source = parseSpecSource(spec, { cwd: ctx.cwd() });
  const key = cacheKey === undefined ? undefined : parseCacheKey(cacheKey);
  return cacheLayout(rootOf(ctx), cacheNamespace(canonicalSourceOf(source), key));
};

// The parseCacheId call below is the path-traversal boundary: an --id
// reaching cacheLayout unchecked is the one place operator input could steer
// a filesystem path. It throws a usageError that never echoes the raw value.
export const layoutForId = (ctx: CliContext, id: string): CacheLayout =>
  cacheLayout(rootOf(ctx), parseCacheId(id));

// Command.parent is typed CommandUnknownOpts | null by the base commander.js
// class extra-typings re-exports as-is, so `program.parent ?? program` widens
// to a union getGlobalOpts's Command parameter does not accept. The runtime
// value is the same root Command instance either way (extra-typings just
// narrows its static option types, which getGlobalOpts does not use), so this
// cast documents a real type-fidelity gap rather than papering over a bug.
export const globalOptsOf = (program: Command): ReturnType<typeof getGlobalOpts> =>
  getGlobalOpts((program.parent ?? program) as Command);

// Also split out of cache.ts to keep it under the default max-lines budget:
// the "--all" sweep belongs next to layoutForId/layoutForSpec because it
// walks the same namespace-id space rather than a single resolved target.
export const clearAllNamespaces = async (
  root: string,
  cacheFs: CliContext['cacheFs'],
  now: number,
): Promise<number> => {
  // --all must enumerate NAMESPACE DIRECTORIES, not readable summaries.
  // listCacheEntries deliberately skips entries it cannot parse, so relying
  // on it here could never clear precisely the corrupt entries that "clear"
  // is the documented recovery path for — "--all" would quietly mean "all
  // the healthy ones".
  const namespaceIds = await listNamespaceIds(root, cacheFs);
  let cleared = 0;
  for (const id of namespaceIds) {
    try {
      // Each namespace is cleared under its OWN lock, exactly as a targeted
      // clear is. A sweep is not a licence to skip the serialisation a
      // single clear needs.
      if (await clearNamespace(cacheLayout(root, id), cacheFs, now)) {
        cleared += 1;
      }
    } catch (error) {
      // A namespace-shaped NAME that is not a real directory (a planted file
      // or symlink) is not ours to clear — skip it and continue the sweep
      // rather than aborting every remaining healthy namespace. mkdirSecure's
      // rejectUnlessRealDirectory surfaces this as the dedicated
      // cache_path_type code; any other error, INCLUDING a validationError
      // whose message happens to contain "is not a directory" or "is a
      // symlink" (readFileTextCapped's over-budget message embeds the raw
      // path, and it is reachable here via the lock read), still propagates.
      // The discriminator is the CODE, never the message, so an
      // attacker-controlled cache path can never spoof the skip signal.
      if (!(error instanceof OpenapiMcpError && error.code === 'cache_path_type')) {
        throw error;
      }
    }
  }
  return cleared;
};

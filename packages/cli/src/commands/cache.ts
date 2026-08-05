import {
  clearNamespace,
  listCacheEntries,
  notFoundError,
  parseCacheKey,
  parseContentHash,
  parseDuration,
  parseHeaderEnvMapping,
  parseSpecSource,
  promoteCandidate,
  readCacheEntry,
  resolveCachePolicy,
  resolveHeaderEnvMappings,
  runSpecPipeline,
  sanitizeSpecText,
  unlockNamespace,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import { wrapAction } from '../output.ts';
import {
  CACHE_DISPLAY_MAX,
  clearAllNamespaces,
  collect,
  entryDisplayLines,
  globalOptsOf,
  layoutForId,
  layoutForSpec,
  rootOf,
} from './cache-target.ts';
import type { CommandRegistrar } from './registry.ts';

const registerList: CommandRegistrar = (program, ctx, state) => {
  program
    .command('list')
    .description('list cache entries with their opaque entry ids')
    .action(async () => {
      const opts = globalOptsOf(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const root = rootOf(ctx);
        const entries = await listCacheEntries(root, ctx.cacheFs);
        const data = { cacheRoot: root, entryCount: entries.length, entries };
        // The root is environment-derived (homeDir()), so it is untrusted
        // display text on the human path exactly like a spec title is. JSON
        // mode stays raw because JSON encoding escapes controls.
        const displayRoot = sanitizeSpecText(root, CACHE_DISPLAY_MAX);
        if (entries.length === 0) {
          return { data, humanLines: [`no cache entries under ${displayRoot}`] };
        }
        const humanLines = [
          `${entries.length} cache ${entries.length === 1 ? 'entry' : 'entries'} under ${displayRoot}`,
          ...entries.flatMap((entry) => entryDisplayLines(entry)),
        ];
        return { data, humanLines };
      });
    });
};

const registerClear: CommandRegistrar = (program, ctx, state) => {
  program
    .command('clear')
    .description('remove cache entries; requires an explicit target or --all')
    .option('--spec <url|file>', 'clear the namespace for this spec source')
    .option('--id <entry-id>', 'clear the namespace with this opaque entry id')
    .option('--cache-key <name>', 'cache namespace label used with --spec')
    .option('--all', 'remove every cache entry for this user')
    .action(async (cmdOpts) => {
      const opts = globalOptsOf(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const targeted = cmdOpts.spec !== undefined || cmdOpts.id !== undefined;
        if (cmdOpts.all === true && targeted) {
          throw usageError('--all cannot be combined with --spec or --id');
        }
        if (cmdOpts.spec !== undefined && cmdOpts.id !== undefined) {
          throw usageError('--spec and --id are mutually exclusive');
        }
        if (!targeted && cmdOpts.all !== true) {
          // The accepted baseline anchors the fail-closed refresh policy: losing
          // it turns the next start of every affected server back into TOFU, so
          // wiping the whole cache is never the default
          throw usageError(
            'cache clear needs an explicit target: pass --spec <url|file>, --id <entry-id>,' +
              ' or --all to remove every entry for this user',
          );
        }
        const root = rootOf(ctx);
        if (cmdOpts.all === true) {
          // Cleared namespace by namespace, each under its OWN lock. The root
          // itself is left in place — removing it would race a first-ever
          // write recreating a namespace underneath, and an empty root costs
          // nothing
          const cleared = await clearAllNamespaces(root, ctx.cacheFs, ctx.now());
          return {
            data: { cacheRoot: root, clearedEntries: cleared },
            humanLines: [`cleared ${cleared} cache ${cleared === 1 ? 'entry' : 'entries'}`],
          };
        }
        const layout =
          cmdOpts.id === undefined
            ? layoutForSpec(ctx, cmdOpts.spec!, cmdOpts.cacheKey)
            : layoutForId(ctx, cmdOpts.id);
        const removed = await clearNamespace(layout, ctx.cacheFs, ctx.now());
        if (!removed) {
          throw notFoundError(`no cache entry for namespace ${layout.namespace}`);
        }
        return {
          data: { cacheRoot: root, clearedEntries: 1, id: layout.namespace },
          humanLines: [`cleared cache entry ${layout.namespace}`],
        };
      });
    });
};

const registerRefresh: CommandRegistrar = (program, ctx, state) => {
  program
    .command('refresh')
    .description('force a refetch of a spec source, writing a candidate on change')
    .requiredOption('--spec <url|file>', 'OpenAPI spec source, JSON or YAML')
    .option('--cache-key <name>', 'cache namespace label')
    .option(
      '--spec-header-env <Header=ENV>',
      'auth header for the spec fetch, value read from env (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option('--timeout <duration>', 'spec fetch timeout (<int><s|m|h|d>)', '30s')
    .option('--trust-spec-updates', 'accept the refreshed spec directly instead of gating it')
    .option('--allow-private-network', 'permit private/loopback redirect targets during the fetch')
    .action(async (cmdOpts) => {
      const opts = globalOptsOf(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        const mappings = cmdOpts.specHeaderEnv.map((raw) => parseHeaderEnvMapping(raw));
        const specHeaders = resolveHeaderEnvMappings(mappings, ctx.env);
        const cacheKey =
          cmdOpts.cacheKey === undefined ? undefined : parseCacheKey(cmdOpts.cacheKey);
        const cacheRoot = rootOf(ctx);
        const policy = resolveCachePolicy({
          source: parseSpecSource(cmdOpts.spec, { cwd: ctx.cwd() }),
          authenticated: specHeaders.length > 0,
          cacheKey,
          trustSpecUpdates: cmdOpts.trustSpecUpdates === true,
          cacheRoot,
        });
        if (policy.kind === 'bypass') {
          // Refreshing a cache that will never be written is not a no-op, it is
          // a request the operator did not mean to make
          throw usageError(
            `cache refresh needs a persistent cache namespace, but this source resolves to a bypass (${policy.reason}) — pass --cache-key <name> to give it a durable namespace`,
          );
        }
        // A zero TTL forces the revalidate path, which validates the response
        // before writing anything — no separate fetch/validate logic needed here
        const result = await runSpecPipeline(
          cmdOpts.spec,
          {
            specHeaders,
            timeoutMs: parseDuration(cmdOpts.timeout),
            cwd: ctx.cwd(),
            allowPrivateNetwork: cmdOpts.allowPrivateNetwork === true,
            allow: [],
            deny: [],
            ttlMs: 0,
            ...(cacheKey === undefined ? {} : { cacheKey }),
            trustSpecUpdates: cmdOpts.trustSpecUpdates === true,
            cacheRoot,
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
        const read = await readCacheEntry(policy.layout, ctx.cacheFs);
        const meta = read.kind === 'hit' ? read.entry.meta : undefined;
        const data = {
          id: policy.layout.namespace,
          cacheStatus: result.cacheStatus,
          displaySource: result.displaySource,
          acceptedContentHash: meta?.acceptedContentHash ?? '',
          // The nested member on disk, flattened for the output envelope
          ...(meta?.candidate === undefined
            ? {}
            : { candidateContentHash: meta.candidate.contentHash }),
        };
        const humanLines = [
          `refreshed ${sanitizeSpecText(data.displaySource, CACHE_DISPLAY_MAX)} (${data.cacheStatus})`,
          `  entry:     ${data.id}`,
          `  accepted:  ${data.acceptedContentHash}`,
          meta?.candidate === undefined
            ? `  candidate: none${data.cacheStatus === 'revalidated' ? ' — the spec is unchanged' : ''}`
            : `  candidate: ${meta.candidate.contentHash} (run "openapi-mcp cache promote" to accept)`,
        ];
        return { data, humanLines, warnings: result.warnings };
      });
    });
};

const registerPromote: CommandRegistrar = (program, ctx, state) => {
  program
    .command('promote')
    .description('accept the pending candidate spec as the new baseline')
    .requiredOption('--spec <url|file>', 'OpenAPI spec source, JSON or YAML')
    .option('--cache-key <name>', 'cache namespace label')
    .option('--hash <digest>', 'pin the promotion to this candidate content hash')
    .action(async (cmdOpts) => {
      const opts = globalOptsOf(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        // Validated at the boundary so a malformed digest never reaches the
        // compare-and-swap and can never be mistaken for "no pin given"
        const expectedHash =
          cmdOpts.hash === undefined ? undefined : parseContentHash(cmdOpts.hash);
        const layout = layoutForSpec(ctx, cmdOpts.spec, cmdOpts.cacheKey);
        const promoted = await promoteCandidate(
          layout,
          ctx.cacheFs,
          ctx.now(),
          expectedHash === undefined ? {} : { expectedHash },
        );
        return {
          data: { id: layout.namespace, acceptedContentHash: promoted.promotedHash },
          humanLines: [
            `promoted candidate ${promoted.promotedHash} to the accepted baseline`,
            `  entry: ${layout.namespace}`,
          ],
        };
      });
    });
};

// The explicit recovery path that replaces automatic stale-lock breaking.
// Breaking a lock cannot be made safe automatically — a third process can
// acquire between the staleness check and the unlink, so the breaker deletes
// a live lock. Making it an operator action does NOT make the race
// disappear: unlockNamespace reads one record and unlinks the path
// afterwards, so a process A can release and a process C can acquire in
// between, and the unlink aimed at A's lock removes C's instead. What the
// operator action buys is that the risk is taken KNOWINGLY by someone who
// can check whether the owning process still exists — not that the
// operation is safe. The command documents that it requires quiesced
// writers, and the exit-3 path below refuses without --force whenever the
// lock is not demonstrably stale.
const registerUnlock: CommandRegistrar = (program, ctx, state) => {
  program
    .command('unlock')
    .description(
      'remove a stale writer lock left behind by a process that died (stop other openapi-mcp processes on this entry first: removing a lock a live writer still holds re-admits a second writer)',
    )
    .option('--spec <url|file>', 'unlock the namespace for this spec source')
    .option('--id <entry-id>', 'unlock the namespace with this opaque entry id')
    .option('--cache-key <name>', 'cache namespace label used with --spec')
    .option('--force', 'remove the lock even when it is not known to be stale')
    .action(async (cmdOpts) => {
      const opts = globalOptsOf(program);
      state.exitCode = await wrapAction(ctx, opts, async () => {
        if ((cmdOpts.spec === undefined) === (cmdOpts.id === undefined)) {
          throw usageError('cache unlock needs exactly one of --spec or --id');
        }
        const layout =
          cmdOpts.id === undefined
            ? layoutForSpec(ctx, cmdOpts.spec!, cmdOpts.cacheKey)
            : layoutForId(ctx, cmdOpts.id);
        const { heldForMs } = await unlockNamespace(layout, ctx.cacheFs, ctx.now(), {
          force: cmdOpts.force === true,
        });
        const heldForSeconds = Math.floor(heldForMs / 1000);
        return {
          data: { id: layout.namespace, heldForMs },
          humanLines: [
            `removed the writer lock on cache entry ${layout.namespace} (held for ${String(heldForSeconds)}s)`,
          ],
        };
      });
    });
};

export const registerCache: CommandRegistrar = (program, ctx, state) => {
  const cache = program.command('cache').description('inspect and manage the on-disk spec cache');
  registerList(cache, ctx, state);
  registerClear(cache, ctx, state);
  registerRefresh(cache, ctx, state);
  registerPromote(cache, ctx, state);
  registerUnlock(cache, ctx, state);
};

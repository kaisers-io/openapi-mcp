import { asCacheError } from '../cache/errors.ts';
import type { CacheFs } from '../cache/fs.ts';
import { CACHE_MAX_PERSISTED_BYTES, resolveCachePolicy } from '../cache/paths.ts';
import type { CacheLayout } from '../cache/paths.ts';
import {
  readCacheEntry,
  serializedSizeWithin,
  touchRevalidated,
  writeAccepted,
  writeCandidate,
} from '../cache/store.ts';
import { isStaleRevisionError } from '../cache/revision.ts';
import type { ExpectedRevision } from '../cache/revision.ts';
import type { CacheEntry } from '../cache/store.ts';
import { evaluateFreshness } from '../cache/ttl.ts';
import { CACHE_META_SCHEMA_VERSION } from '../schemas/cache.ts';
import { reasonOf, usageError, validationError } from '../errors.ts';
import type { ErrorReason } from '../errors.ts';
import { applyFilters } from '../filter/apply.ts';
import type { NotExposedOperation } from '../filter/apply.ts';
import type { CaseCollision } from '../filter/case-collisions.ts';
import type { DeadPattern } from '../filter/engine.ts';
import type { FilterPattern } from '../filter/pattern.ts';
import type { DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
import { assignToolNames } from '../toolgen/naming.ts';
import type { NamedOperation } from '../toolgen/naming.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { checkRefs, createDereferencer } from './dereference.ts';
import type { FetchSpecDeps } from './fetch.ts';
import { loadSpecFromFile, parseSpecSource } from './load.ts';
import type { LoadedSpecText } from './load.ts';
import { normalizeSpec } from './normalize.ts';
import type { NormalizedSpec, OmittedOperation, OperationRecord } from './normalize.ts';
import { parseSpecText } from './parse.ts';
import { operationKeysOf, pendingCandidateKeys, withholdRemoved } from './pending-candidate.ts';
import { serverUrlRejectedWarning } from './server-url.ts';
import { loadOpenApiValidators, validateOpenApiDocument } from './validate.ts';
import type { OpenapiVersion } from './validate.ts';

export type SpecPipelineOptions = {
  specHeaders: readonly ResolvedHeader[];
  timeoutMs: number;
  cwd: string;
  allowPrivateNetwork: boolean;
  // Lets --spec-header-env go over plain http to a host that is not loopback
  allowInsecureHttp?: boolean;
  allow: readonly FilterPattern[];
  deny: readonly FilterPattern[];
  ttlMs: number;
  cacheKey?: string | undefined;
  trustSpecUpdates: boolean;
  cacheRoot: string | undefined;
  nowMs: number;
  // The exposed-set budget for this run. Omitted means
  // SPEC_BUDGETS.maxToolCount (one tool per operation); `serve --tool-mode
  // discover|auto` passes SPEC_BUDGETS.maxDiscoverToolCount, since its
  // tools/list size does not grow with the operation count.
  maxToolCount?: number | undefined;
  // How many tools the exposed operations become (issue #67): an operation
  // omitted as not supported is no tool, so counting the operations refused
  // a start whose tools fit. The caller builds its tools here, before
  // anything is cached, and keeps them. Omitted counts the operations.
  countTools?: ((exposed: ExposedOperations) => number) | undefined;
};

// What the filters expose, as `countTools` receives it
export type ExposedOperations = Pick<
  SpecPipelineResult,
  'spec' | 'namedOperations' | 'withheldOperations'
>;

export type SpecPipelineDeps = {
  // Matches FetchSpecDeps.fetcher — undici's own fetch, never Node's global
  // fetch (dual-package hazard: the global fetch rejects an installed-undici
  // Agent as its dispatcher).
  fetcher: FetchSpecDeps['fetcher'];
  lookup: DnsLookup;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
  // See FileLoadDeps: hash a spec file as bytes, decode only when used
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  cacheFs: CacheFs;
};

export type CacheStatus =
  | 'bypassed'
  | 'fresh'
  | 'revalidated'
  | 'accepted-first'
  | 'accepted-update'
  | 'candidate'
  | 'stale';

export type SpecPipelineResult = {
  spec: NormalizedSpec;
  namedOperations: readonly NamedOperation[];
  contentHash: string;
  candidateContentHash?: string | undefined;
  displaySource: string;
  deadPatterns: readonly DeadPattern[];
  warnings: readonly string[];
  // The stable reasons of the warnings that replace an error (issue #79)
  warningReasons: readonly ErrorReason[];
  cacheStatus: CacheStatus;
  // Accepted operations hidden because the pending candidate removed them
  // (kaisers-io/openapi-mcp-archive#60); empty when no candidate is waiting
  withheldOperations: readonly OmittedOperation[];
  // The operations --allow, --deny or the read-only default leave out, each
  // with its decision (issue #41)
  filteredOut: readonly NotExposedOperation[];
  // --allow/--deny patterns that match values differing only by case (#42)
  caseCollisions: readonly CaseCollision[];
  // Set when this run could not record its revalidation because another
  // process holds the cache entry's writer lock
  // (kaisers-io/openapi-mcp-archive#65): "held" while a live writer is busy,
  // "stale" when the holder looks gone, which will not clear by itself (an
  // operator runs "openapi-mcp cache unlock")
  cacheLock?: CacheLockState | undefined;
};

export type CacheLockState = 'held' | 'stale';

// `spec` is normalized from the NOT yet dereferenced `document`
// (issue kaisers-io/openapi-mcp-archive#89): its operations carry the raw
// parameters, request body and responses, $refs included. Only the operations
// that survive filtering are dereferenced, in finish.
type ProcessedSpec = {
  // RAW operations (issue kaisers-io/openapi-mcp-archive#89): parameters,
  // requestBody and responses may still hold `$ref`s. Only `namedOperations` in
  // the result are dereferenced; nothing may read schemas from spec.operations.
  spec: NormalizedSpec;
  document: Record<string, unknown>;
};

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Two levels (issue kaisers-io/openapi-mcp-archive#32). The raw cap bounds the
// unfiltered document and runs before anything is cached; the tool budget
// bounds what is exposed and runs after filtering (see finish), so --allow can
// carve a small tool set out of an API that documents more operations than the
// budget.
const enforceToolBudget = (exposedCount: number, maxToolCount: number): void => {
  if (exposedCount > maxToolCount) {
    throw validationError(
      `${exposedCount} tools would be exposed after filtering — exceeds the ${maxToolCount}-tool budget; narrow the set with --allow or --deny`,
    );
  }
};

const enforceOperationBudget = (spec: NormalizedSpec): void => {
  if (spec.operations.length > SPEC_BUDGETS.maxOperationCount) {
    throw validationError(
      `spec defines ${spec.operations.length} operations — exceeds the ${SPEC_BUDGETS.maxOperationCount}-operation limit`,
    );
  }
};

// Parse, validate, check every $ref, normalize, and enforce the raw operation
// cap. Every cache write happens downstream of this function, so an
// unvalidated, dangling-$ref or over-limit spec can never reach the disk. The
// validated document itself is what gets cached: it is the
// source's own size, where its dereferenced form was 15-30x larger.
const processSpecText = async (text: string): Promise<ProcessedSpec> => {
  const parsed = parseSpecText(text);
  const validated = validateOpenApiDocument(parsed, await loadOpenApiValidators());
  checkRefs(validated.document);
  const spec = normalizeSpec(validated.document, validated.version);
  enforceOperationBudget(spec);
  return { spec, document: validated.document };
};

// A cached document is already parsed, so this path skips that. It also does
// NOT re-validate against the meta-schema: these
// bytes were validated before they were written and readCacheEntry has
// already checked their sha256 against meta.acceptedContentHash. The 3.0/3.1/3.2
// discriminator that would otherwise have been the reason to revalidate comes
// from meta.openapiVersion, which is persisted for exactly this.
// Entries written before the cache format bump hold the dereferenced document
// instead of the source one; that is still a valid, $ref-free (up to cycle
// markers) document and goes through the same path.
const processCachedDocument = (
  document: Record<string, unknown>,
  openapiVersion: OpenapiVersion,
): ProcessedSpec => {
  const spec = normalizeSpec(document, openapiVersion);
  // Re-enforced per run: an entry written under an older, larger limit must
  // not bypass the current one. The exposed-set budget runs in finish.
  enforceOperationBudget(spec);
  return { spec, document };
};

// Refreshed bytes identical to the ones the accepted document was validated
// from (kaisers-io/openapi-mcp-archive#76) need no second parse and validation:
// the entry read at the start of this run already holds that document,
// hash-verified against its object name by readCacheEntry. A file source used
// to discard it and re-parse the file on every start, which for a large YAML
// spec was most of the start-up (DigitalOcean: ~0.6 s of YAML parsing per
// start).
//
// Exact on purpose. The source hash covers every byte of the input, and the
// stored document is the output of parse + validate + checkRefs, which take
// no options; filtering, dereferencing and tool generation still run on every
// start, so no flag can be served stale. A different CACHE_META_SCHEMA_VERSION
// means that processing changed since the entry was written (a legacy entry
// even holds the dereferenced form), so it is processed again and rewritten.
// Not keyed on the package version: a validation rule a newer build adds
// is not applied to unchanged bytes. The same document would be served
// today (last known good), but now without the refresh-failed warning; a
// rule that must reach existing entries bumps CACHE_META_SCHEMA_VERSION.
const reusableAcceptedDocument = (
  cached: CacheEntry | undefined,
  sourceContentHash: string,
): ProcessedSpec | undefined =>
  cached !== undefined &&
  cached.meta.schemaVersion === CACHE_META_SCHEMA_VERSION &&
  cached.meta.sourceContentHash === sourceContentHash
    ? processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion)
    : undefined;

// FAIL CLOSED on a corrupt entry. A silent refetch would re-enter
// trust-on-first-use and accept whatever the remote says now, which is exactly
// the rug pull that fail-closed handling of a corrupt entry exists to prevent,
// and is reachable by anyone who can write into the cache directory. Recovery
// must be an explicit operator act.
const unusableEntryError = (reason: string): Error =>
  validationError(
    `the spec cache entry is unusable (${reason}); it is the accepted baseline that authorizes this spec, so it is never refetched silently — run "openapi-mcp cache clear" to reset it deliberately`,
  );

// A strict cache write (first use, a candidate, an accepted update) waits for
// a busy writer lock for as long as the operator allowed the spec fetch to
// take (--timeout), not just the built-in ~2 s: a concurrent first use of a
// large spec can hold the lock longer than that
// (kaisers-io/openapi-mcp-archive#65)
const withLockWait = (cacheFs: CacheFs, timeoutMs: number): CacheFs =>
  cacheFs.runtime === undefined
    ? cacheFs
    : { ...cacheFs, runtime: { ...cacheFs.runtime, lockWaitMs: timeoutMs } };

export const runSpecPipeline = (
  rawSource: string,
  opts: SpecPipelineOptions,
  deps: SpecPipelineDeps,
): Promise<SpecPipelineResult> =>
  runSpecPipelineOnce(rawSource, opts, {
    ...deps,
    cacheFs: withLockWait(deps.cacheFs, opts.timeoutMs),
  });

const runSpecPipelineOnce = async (
  rawSource: string,
  opts: SpecPipelineOptions,
  deps: SpecPipelineDeps,
): Promise<SpecPipelineResult> => {
  const source = parseSpecSource(rawSource, { cwd: opts.cwd });
  const authenticated = opts.specHeaders.length > 0;
  // Diagnosed before the policy: the missing-cache-decision usage error also
  // names --spec-header-env, and this is the more specific answer
  if (source.kind === 'file' && authenticated) {
    throw usageError('--spec-header-env only applies to URL spec sources');
  }
  // Policy is a value, not an assertion — bypass means cacheFs is never touched
  const policy = resolveCachePolicy({
    source,
    authenticated,
    cacheKey: opts.cacheKey,
    trustSpecUpdates: opts.trustSpecUpdates,
    cacheRoot: opts.cacheRoot,
  });

  const warnings: string[] = [];
  // Composition root, imperative on purpose: `layout` stays undefined on the
  // bypass branch and is only assigned after the awaited mkdirSecure below
  // succeeds — a ternary/ helper would either call mkdirSecure unconditionally
  // or hide the awaited side effect inside a value-producing expression,
  // reordering it relative to the `warnings.push` above.
  let layout: CacheLayout | undefined;
  if (policy.kind === 'bypass') {
    // This is the ONLY way storage is skipped. A bypass is a policy decision
    // taken deliberately, never the fallout of an I/O error.
    warnings.push(`spec cache bypassed: ${policy.reason}`);
  } else {
    // Once policy has resolved to persistent, an inability to prepare the
    // namespace is a validation failure, not something to silently continue
    // past: serving the remote document without ever consulting the durable
    // accepted baseline that authorizes it would let an attacker who can make
    // one mkdir fail re-enter trust-on-first-use through the back door.
    //
    // The failure must be a TYPED one: letting the raw fs error propagate
    // exits 1 ("unexpected") rather than the 3 the Global Constraints declare
    // for this case. cacheIoError makes the declared exit code real.
    try {
      await deps.cacheFs.mkdirSecure(policy.layout.dir);
    } catch (error) {
      throw asCacheError(`prepare the namespace for ${policy.layout.namespace}`, error);
    }
    ({ layout } = policy);
  }

  // Composition root, imperative on purpose: `cached` stays undefined unless
  // the awaited read below both runs (layout defined) and reports a hit;
  // the corrupt-entry throw in between is a fail-closed exit, not a value.
  let cached: CacheEntry | undefined;
  if (layout !== undefined) {
    // The reader itself distinguishes absence from failure; anything it
    // throws is a real I/O failure and is typed here for the same reason.
    // No wrapper here: readCacheEntry is wrapped at its own definition, and
    // double-wrapping contradicts the one-boundary design
    const read = await readCacheEntry(layout, deps.cacheFs);
    if (read.kind === 'corrupt') {
      // FAIL CLOSED. A silent refetch here would re-enter trust-on-first-use
      // and accept whatever the remote says now, which is exactly the rug pull
      // that fail-closed handling of a corrupt entry exists to prevent, and is
      // reachable by anyone who can write into the cache directory. Recovery
      // must be an explicit operator act.
      throw unusableEntryError(read.reason);
    }
    if (read.kind === 'hit') {
      cached = read.entry;
    }
  }

  // File specs are re-read and hash-compared on every run, so
  // the TTL never short-circuits them; only URL sources take the no-network path.
  // A version 1 entry (its document is the dereferenced form) is
  // refetched WITHOUT validators, so the server sends the bytes rather than a
  // 304: unchanged bytes are then rewritten as an accepted entry in the
  // current format, and changed ones go through the usual candidate gate.
  const decision =
    cached === undefined ||
    source.kind === 'file' ||
    cached.meta.schemaVersion !== CACHE_META_SCHEMA_VERSION
      ? { kind: 'revalidate' as const }
      : evaluateFreshness(cached.meta, opts.nowMs, opts.ttlMs);

  if (cached !== undefined && decision.kind === 'fresh') {
    const processed = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(processed, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'fresh',
      candidateOperationKeys: await pendingCandidateKeys(layout, deps.cacheFs, cached),
      // A restart inside the TTL still has to surface a waiting candidate
      cached,
    });
  }

  // The refresh attempt. The last-known-good rule wraps exactly this block:
  // a failed fetch or a failed validation of the REFRESHED spec falls back to
  // the accepted baseline. The corrupt-entry throw above is deliberately outside
  // it, because a corrupt anchor is never a recoverable condition.
  // Composition root, imperative on purpose: `refreshed` and
  // `notModifiedValidators` below are assigned deep inside the try's
  // conditional branches and read after it — the staged
  // fail-closed-read/conditional-refresh/last-known-good-fallback sequence is
  // sequential by contract, not a candidate for restructuring into a value
  // expression.
  let refreshed:
    | { loaded: LoadedSpecText; etag?: string | undefined; lastModified?: string | undefined }
    | 'not-modified';
  // A 304 carries validators, and they are what the next revalidation
  // replays. Captured here so the touchRevalidated call below can record them.
  let notModifiedValidators: { etag?: string | undefined; lastModified?: string | undefined } = {};
  // The validated refresh is carried OUT of the try so the commit happens
  // outside the stale-fallback catch
  let processedRefresh: ProcessedSpec | undefined;
  try {
    if (source.kind === 'url') {
      // Routing every URL fetch through fetchSpecConditional captures
      // validators uniformly: a first-ever fetch (cached === undefined)
      // through the plain, non-conditional fetchSpec would discard any
      // ETag/Last-Modified the server returned, leaving meta.etag unset after
      // trust-on-first-use so the NEXT revalidation — past the TTL — could
      // never send If-None-Match. When cached is undefined, `decision` carries
      // no etag/lastModified (see its construction above), so this degrades
      // to an ordinary GET — identical bytes, but with the response's
      // validators captured.
      // Imported here, not at the top (issue
      // kaisers-io/openapi-mcp-archive#91): the fetch path pulls in undici and
      // the DNS-pinned transport, which file specs never need
      const { fetchSpecConditional } = await import('./fetch.ts');
      const conditional = await fetchSpecConditional(
        source.url,
        {
          headers: opts.specHeaders,
          timeoutMs: opts.timeoutMs,
          allowPrivateNetwork: opts.allowPrivateNetwork,
          allowInsecureHttp: opts.allowInsecureHttp === true,
          ...(decision.kind === 'revalidate' && decision.etag !== undefined
            ? { etag: decision.etag }
            : {}),
          ...(decision.kind === 'revalidate' && decision.lastModified !== undefined
            ? { lastModified: decision.lastModified }
            : {}),
        },
        { fetcher: deps.fetcher, lookup: deps.lookup },
      );
      if (conditional.kind === 'not-modified') {
        notModifiedValidators = {
          ...(conditional.etag === undefined ? {} : { etag: conditional.etag }),
          ...(conditional.lastModified === undefined
            ? {}
            : { lastModified: conditional.lastModified }),
        };
      }
      refreshed =
        conditional.kind === 'not-modified'
          ? 'not-modified'
          : {
              loaded: conditional.loaded,
              ...(conditional.etag === undefined ? {} : { etag: conditional.etag }),
              ...(conditional.lastModified === undefined
                ? {}
                : { lastModified: conditional.lastModified }),
            };
    } else {
      refreshed = { loaded: await loadSpecFromFile(source.path, SPEC_BUDGETS.maxSpecBytes, deps) };
    }
    if (refreshed !== 'not-modified') {
      // Validation of the refreshed bytes happens inside the try, so an invalid
      // refresh degrades to last-known-good rather than killing the command.
      //
      // The COMMIT deliberately does not happen here: calling commitRefresh
      // inside this try would let a writeAccepted or writeCandidate I/O
      // failure — or, worse, a lock conflictError (exit 5) or a
      // corrupt-existing-object validationError — be caught by the
      // stale-fallback below and reported as a SUCCESSFUL `stale` response. A
      // failed cache write is not a failed refresh: the last-known-good rule
      // covers the network and the spec, not our own inability to persist.
      // Only the fetch and the validation may fall back.
      const reused = reusableAcceptedDocument(cached, refreshed.loaded.contentHash);
      processedRefresh = reused ?? (await processSpecText(refreshed.loaded.text));
      // The persisted-document budget depends on the spec alone, so a document
      // over it is a failed refresh, not a failed cache write. Checked only for
      // a new document that a cache will persist: the accepted one already
      // fits, and the no-cache path never persists. Without an accepted spec
      // there is nothing to fall back to, and the writer refuses it the same.
      if (
        reused === undefined &&
        cached !== undefined &&
        layout !== undefined &&
        serializedSizeWithin(processedRefresh.document, CACHE_MAX_PERSISTED_BYTES) === undefined
      ) {
        throw validationError(
          `the refreshed spec exceeds the ${CACHE_MAX_PERSISTED_BYTES}-byte persisted-document budget`,
        );
      }
    }
  } catch (error) {
    if (cached === undefined) {
      throw error;
    }
    warnings.push(
      `spec refresh failed, serving the last known good accepted baseline: ${describeCause(error)}`,
    );
    const processed = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(processed, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'stale',
      warningReason: reasonOf(error),
      candidateOperationKeys: await pendingCandidateKeys(layout, deps.cacheFs, cached),
      // A failed refresh does not make a waiting candidate disappear either
      cached,
    });
  }

  // The commit runs OUTSIDE the stale-fallback catch, so a cache write
  // failure — an I/O error, a corrupt pre-existing object, or a lock conflict
  // (exit 5) — propagates with its own typed error instead of being
  // laundered into a successful `stale` response.
  if (processedRefresh !== undefined && refreshed !== 'not-modified') {
    // Wrapped, like every other cache mutation: committing outside the
    // stale-fallback path keeps a write failure from being reported as
    // success, and the typed wrap keeps a RAW write failure from surfacing
    // as an unexpected exit 1.
    // A typed store error (notably a lock conflict, exit 5) passes through
    // untouched.
    //
    // One retry on a stale revision (kaisers-io/openapi-mcp-archive#34):
    // another process changed the entry between this run's lock-free read and
    // its commit (typically servers starting together). The fetched and
    // validated bytes are still valid input, so the entry is read again and the
    // decision re-made against what is current, without refetching. Only a
    // second conflict exits 5: a decision is still never committed against a
    // revision it did not see.
    const commitAgainst = (entry: CacheEntry | undefined): Promise<SpecPipelineResult> =>
      commitRefresh(processedRefresh, refreshed, entry, layout, opts, deps, warnings, source.kind);
    try {
      return await commitAgainst(cached);
    } catch (error) {
      if (layout === undefined || !isStaleRevisionError(error)) {
        throw error;
      }
      const reread = await readCacheEntry(layout, deps.cacheFs);
      if (reread.kind === 'corrupt') {
        throw unusableEntryError(reread.reason);
      }
      return await commitAgainst(reread.kind === 'hit' ? reread.entry : undefined);
    }
  }

  // 304 Not Modified: reuse the accepted baseline, bump only the timestamp
  if (cached === undefined) {
    throw validationError('the spec source reported no change but nothing is cached');
  }
  // Calling writeAccepted here would rewrite the accepted entry and CLEAR
  // the candidate, silently destroying a candidate awaiting promotion
  // without ever approving it. touchRevalidated updates the timestamp and
  // validators and preserves both slots.
  //
  // Typed, like every other cache mutation, so a raw fs failure here
  // cannot surface as an unexpected exit 1.
  //
  // Best effort (kaisers-io/openapi-mcp-archive#65): the entry being served was
  // read and hash-verified in this run and the source confirmed it unchanged,
  // so the write only records fetchedAt and validators. A lock held by another
  // process (servers starting together, or a crashed writer) must not fail the
  // start-up over that; the verified baseline is served with a warning.
  const cacheLock =
    layout === undefined
      ? undefined
      : await touchBestEffort(
          layout,
          deps.cacheFs,
          opts.nowMs,
          {
            ...(notModifiedValidators.etag === undefined
              ? {}
              : { etag: notModifiedValidators.etag }),
            ...(notModifiedValidators.lastModified === undefined
              ? {}
              : { lastModified: notModifiedValidators.lastModified }),
          },
          { replaceValidators: false, expected: { meta: cached.meta } },
          warnings,
        );
  const processed = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
  return finish(processed, opts, warnings, {
    contentHash: cached.meta.sourceContentHash,
    displaySource: cached.meta.displaySource,
    cacheStatus: 'revalidated',
    cached,
    candidateOperationKeys: await pendingCandidateKeys(layout, deps.cacheFs, cached),
    cacheLock,
  });
};

// Shared by both best-effort bookkeeping paths (304, unchanged 200): records
// the revalidation if the writer lock is free, otherwise adds the warning and
// reports what kind of lock was in the way
const touchBestEffort = async (
  layout: CacheLayout,
  cacheFs: CacheFs,
  nowMs: number,
  validators: { etag?: string; lastModified?: string },
  touchOpts: { replaceValidators: boolean; expected: ExpectedRevision },
  warnings: string[],
): Promise<CacheLockState | undefined> => {
  const touched = await touchRevalidated(layout, cacheFs, nowMs, validators, {
    ...touchOpts,
    bestEffort: true,
  });
  if (touched.recorded) {
    return undefined;
  }
  warnings.push(`cache metadata not updated, serving the verified baseline: ${touched.reason}`);
  // A revision that moved on (kaisers-io/openapi-mcp-archive#34) is not a lock
  // problem
  if (touched.lockStale === undefined) {
    return undefined;
  }
  return touched.lockStale ? 'stale' : 'held';
};

type FinishInput = {
  contentHash: string;
  candidateContentHash?: string | undefined;
  displaySource: string;
  cacheStatus: CacheStatus;
  // The pending candidate's `METHOD path` keys, when one is waiting
  // (kaisers-io/openapi-mcp-archive#60)
  candidateOperationKeys?: ReadonlySet<string> | undefined;
  cacheLock?: CacheLockState | undefined;
  // The entry being served, when one is. A candidate recorded in it must
  // surface on EVERY such result, not only on the run that created it.
  cached?: CacheEntry | undefined;
  // Why a failed refresh was replaced by the cached baseline, when known
  warningReason?: ErrorReason | undefined;
};

const PENDING_PROMOTION_WARNING =
  'a refreshed spec is waiting as a candidate; the accepted baseline is being served — run "openapi-mcp cache promote" to accept it';

// Dereferences what an exposed operation hands to tool generation. One
// dereferencer serves every operation of a run, so a $ref target shared by
// many operations is expanded once and its output object is shared.
const materialize = (
  operation: OperationRecord,
  dereferencer: ReturnType<typeof createDereferencer>,
): OperationRecord => {
  const { requestBody } = operation;
  return {
    ...operation,
    parameters: operation.parameters.map(
      (parameter) => dereferencer.resolve(parameter) as Record<string, unknown>,
    ),
    ...(requestBody === undefined
      ? {}
      : { requestBody: dereferencer.resolve(requestBody) as Record<string, unknown> }),
    responses: dereferencer.resolve(operation.responses) as Record<string, unknown>,
  };
};

const finish = (
  processed: ProcessedSpec,
  opts: SpecPipelineOptions,
  warnings: readonly string[],
  input: FinishInput,
): SpecPipelineResult => {
  const { spec } = processed;
  const named = assignToolNames(spec.operations);
  // One budget for the whole filtering pass
  const filtered = applyFilters(named, opts.allow, opts.deny, undefined, spec.omitted);
  // Reporting the candidate only on the `candidate` status would mean a
  // later start inside the TTL returns `fresh` with no candidate hash and no
  // warning — the candidate would be on disk, gating the update, and
  // completely invisible. The same holds for `revalidated` and `stale`. A
  // pending candidate is a property of the ENTRY, so it is reported wherever
  // that entry is served.
  const pending = input.cached?.meta.candidate;
  const candidateContentHash = input.candidateContentHash ?? pending?.contentHash;
  const withholding = withholdRemoved(filtered.exposed, input.candidateOperationKeys);
  // Every served path (fresh, cached, refreshed) ends here, so the rejected
  // server URL is reported on each of them, not only when it was first seen
  const rejected = spec.serverUrlRejected;
  const allWarnings = [
    ...warnings,
    ...(rejected === undefined ? [] : [serverUrlRejectedWarning(rejected.expandedBytes)]),
    ...(pending === undefined || input.candidateContentHash !== undefined
      ? []
      : [PENDING_PROMOTION_WARNING]),
    ...(withholding.warning === undefined ? [] : [withholding.warning]),
  ];
  // Filter first, then dereference only what is exposed: the
  // node budgets now measure what the model will actually see
  const dereferencer = createDereferencer(processed.document, {
    collapseCycles: true,
    openapiVersion: spec.openapiVersion,
  });
  const exposed = withholding.exposed.map((entry) => ({
    ...entry,
    operation: materialize(entry.operation, dereferencer),
  }));
  // Every result, fresh or cached, passes through here, before the accepted
  // write: the tool budget is enforced on the tools that would actually be
  // served (issues #41 and #67), so a run that refuses to serve leaves no
  // baseline behind (kaisers-io/openapi-mcp-archive#32)
  enforceToolBudget(
    opts.countTools === undefined
      ? exposed.length
      : opts.countTools({
          spec,
          namedOperations: exposed,
          withheldOperations: withholding.withheld,
        }),
    opts.maxToolCount ?? SPEC_BUDGETS.maxToolCount,
  );
  return {
    spec,
    namedOperations: exposed,
    withheldOperations: withholding.withheld,
    filteredOut: filtered.filteredOut,
    caseCollisions: filtered.caseCollisions,
    contentHash: input.contentHash,
    ...(candidateContentHash === undefined ? {} : { candidateContentHash }),
    displaySource: input.displaySource,
    deadPatterns: filtered.deadPatterns,
    warnings: allWarnings,
    warningReasons: input.warningReason === undefined ? [] : [input.warningReason],
    cacheStatus: input.cacheStatus,
    ...(input.cacheLock === undefined ? {} : { cacheLock: input.cacheLock }),
  };
};

type Refreshed = {
  loaded: LoadedSpecText;
  etag?: string | undefined;
  lastModified?: string | undefined;
};

// Written as an if-else chain, not a nested ternary, purely for lint-rule
// compliance (no-nested-ternary) — the three-way branch itself is unchanged
const acceptedCacheStatus = (
  layout: CacheLayout | undefined,
  cached: CacheEntry | undefined,
  unchanged: boolean | undefined,
): CacheStatus => {
  if (layout === undefined) {
    return 'bypassed';
  }
  if (cached === undefined) {
    return 'accepted-first';
  }
  return unchanged ? 'revalidated' : 'accepted-update';
};

// The exposed-set budget depends on this run's filters, which `cache promote`
// does not know, so a candidate that is over it under the current filters
// would only surface as a failed start after promotion. Checked when the
// candidate is recorded (the only run that holds its document) and reported
// as a warning: the accepted baseline keeps serving either way.
const candidateBudgetWarning = (
  candidate: NormalizedSpec,
  opts: SpecPipelineOptions,
): string | undefined => {
  const budget = opts.maxToolCount ?? SPEC_BUDGETS.maxToolCount;
  let exposedCount: number;
  try {
    exposedCount = applyFilters(
      assignToolNames(candidate.operations),
      opts.allow,
      opts.deny,
      undefined,
      candidate.omitted,
    ).exposed.length;
  } catch (error) {
    return `the candidate spec could not be checked against the ${budget}-tool budget (${describeCause(error)}); after "openapi-mcp cache promote" this server may refuse to start with the current filters`;
  }
  if (exposedCount <= budget) {
    return undefined;
  }
  // An upper bound: an operation omitted as not supported is no tool, and
  // only building the tools would tell, which is not worth it for a warning
  return `${exposedCount} operations of the candidate spec pass the current filters — over the ${budget}-tool budget; after "openapi-mcp cache promote" this server may refuse to start unless --allow or --deny narrows the set`;
};

// Decides what a successfully fetched-and-validated spec becomes: the accepted
// baseline (first use, unchanged content, or --trust-spec-updates), or a gated
// candidate while the accepted baseline keeps serving.
const commitRefresh = async (
  processed: ProcessedSpec,
  refreshed: Refreshed,
  cached: CacheEntry | undefined,
  layout: CacheLayout | undefined,
  opts: SpecPipelineOptions,
  deps: SpecPipelineDeps,
  warnings: string[],
  sourceKind: 'file' | 'url',
): Promise<SpecPipelineResult> => {
  const unchanged = cached?.meta.sourceContentHash === refreshed.loaded.contentHash;
  const gate = cached !== undefined && !unchanged && !opts.trustSpecUpdates;
  if (gate && cached !== undefined && layout !== undefined) {
    const written = await writeCandidate(layout, deps.cacheFs, {
      document: processed.document,
      sourceContentHash: refreshed.loaded.contentHash,
      title: processed.spec.title,
      specVersion: processed.spec.specVersion,
      fetchedAt: opts.nowMs,
      // The validators belong to THIS representation, which is the most
      // recently fetched one — keeping the accepted entry's stale pair
      // instead would make the next conditional request ask about a
      // representation the cache no longer had
      ...(refreshed.etag === undefined ? {} : { etag: refreshed.etag }),
      ...(refreshed.lastModified === undefined ? {} : { lastModified: refreshed.lastModified }),
      // Compare-and-swap (kaisers-io/openapi-mcp-archive#34): the revision this
      // decision was made against
      expected: { meta: cached.meta },
    });
    warnings.push(
      'the spec source changed; the refreshed spec is stored as a candidate awaiting "openapi-mcp cache promote"',
    );
    const overBudget = candidateBudgetWarning(processed.spec, opts);
    if (overBudget !== undefined) {
      warnings.push(overBudget);
    }
    const baseline = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(baseline, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      candidateContentHash: written.candidateContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'candidate',
      // The candidate was just validated in this run: its own document says
      // which accepted operations it no longer has
      candidateOperationKeys: operationKeysOf(processed.document),
    });
  }
  // Filtered (and the exposed-set tool budget enforced) BEFORE the accepted
  // write and before the bookkeeping touch below: a run that refuses to serve
  // must not leave a trust-on-first-use baseline or bookkeeping behind as a
  // side effect (kaisers-io/openapi-mcp-archive#32)
  const result = finish(processed, opts, warnings, {
    contentHash: refreshed.loaded.contentHash,
    displaySource: refreshed.loaded.displaySource,
    cacheStatus: acceptedCacheStatus(layout, cached, unchanged),
  });
  // Nothing to persist when the source is byte-identical to the accepted one
  // and no candidate is waiting (kaisers-io/openapi-mcp-archive#75). `cached`
  // was read and hash-verified earlier in this run, so rewriting it would only
  // re-serialize the document, re-read and re-hash the accepted object, take
  // the writer lock and churn meta.json — every run, for bytes that are already
  // on disk.
  //  - A file source records nothing worth updating: its TTL never
  //    short-circuits (it is re-read on every run), so `fetchedAt` is unused.
  //  - A URL source answering 200 with identical bytes only refreshes its
  //    bookkeeping (fetchedAt, validators) through the metadata-only path a
  //    304 already uses, with the 200's validators replacing the old ones.
  // A waiting candidate still takes the full write below: the source has
  // reverted to the accepted content, and that write is what clears it. So
  // does an entry in an older cache format (kaisers-io/openapi-mcp-archive#89):
  // touching it would keep its old schemaVersion, so it would never migrate,
  // and a URL source would refetch without validators on every start.
  const bookkeepingOnly =
    cached !== undefined &&
    unchanged &&
    cached.meta.candidate === undefined &&
    cached.meta.schemaVersion === CACHE_META_SCHEMA_VERSION;
  if (layout !== undefined && bookkeepingOnly && sourceKind === 'url') {
    // Best effort for the same reason as the 304 path
    // (kaisers-io/openapi-mcp-archive#65). `result` was built above, so the
    // touch's warning and lock state are added to it here rather than to
    // `warnings`, which finish() has already copied
    const touchWarnings: string[] = [];
    const cacheLock = await touchBestEffort(
      layout,
      deps.cacheFs,
      opts.nowMs,
      {
        ...(refreshed.etag === undefined ? {} : { etag: refreshed.etag }),
        ...(refreshed.lastModified === undefined ? {} : { lastModified: refreshed.lastModified }),
      },
      { replaceValidators: true, expected: { meta: cached?.meta } },
      touchWarnings,
    );
    return {
      ...result,
      warnings: [...result.warnings, ...touchWarnings],
      ...(cacheLock === undefined ? {} : { cacheLock }),
    };
  }
  if (layout !== undefined && !bookkeepingOnly) {
    await writeAccepted(layout, deps.cacheFs, {
      document: processed.document,
      sourceContentHash: refreshed.loaded.contentHash,
      displaySource: refreshed.loaded.displaySource,
      title: processed.spec.title,
      specVersion: processed.spec.specVersion,
      // The discriminator is derived inside writeAccepted from the document
      // itself, so there is nothing to pass and nothing to disagree
      fetchedAt: opts.nowMs,
      ...(opts.cacheKey === undefined ? {} : { cacheKey: opts.cacheKey }),
      ...(refreshed.etag === undefined ? {} : { etag: refreshed.etag }),
      ...(refreshed.lastModified === undefined ? {} : { lastModified: refreshed.lastModified }),
      // Compare-and-swap (kaisers-io/openapi-mcp-archive#34): the revision this
      // decision was made against
      expected: { meta: cached?.meta },
    });
  }
  return result;
};

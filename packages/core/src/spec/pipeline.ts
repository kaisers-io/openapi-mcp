import { asCacheError } from '../cache/errors.ts';
import type { CacheFs } from '../cache/fs.ts';
import { resolveCachePolicy, type CacheLayout } from '../cache/paths.ts';
import {
  readCacheEntry,
  touchRevalidated,
  writeAccepted,
  writeCandidate,
  type CacheEntry,
} from '../cache/store.ts';
import { evaluateFreshness } from '../cache/ttl.ts';
import { usageError, validationError } from '../errors.ts';
import { applyFilters, type DeadPattern } from '../filter/engine.ts';
import type { FilterPattern } from '../filter/pattern.ts';
import type { DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
import { assignToolNames, type NamedOperation } from '../toolgen/naming.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { dereference } from './dereference.ts';
import { fetchSpecConditional, type FetchSpecDeps } from './fetch.ts';
import { loadSpecFromFile, parseSpecSource, type LoadedSpecText } from './load.ts';
import { normalizeSpec, type NormalizedSpec } from './normalize.ts';
import { parseSpecText } from './parse.ts';
import { validateOpenApiDocument, type OpenapiVersion } from './validate.ts';

export interface SpecPipelineOptions {
  specHeaders: readonly ResolvedHeader[];
  timeoutMs: number;
  cwd: string;
  allowPrivateNetwork: boolean;
  allow: readonly FilterPattern[];
  deny: readonly FilterPattern[];
  ttlMs: number;
  cacheKey?: string | undefined;
  trustSpecUpdates: boolean;
  cacheRoot: string | undefined;
  nowMs: number;
}

export interface SpecPipelineDeps {
  // Matches FetchSpecDeps.fetcher — undici's own fetch, never Node's global
  // fetch (dual-package hazard: the global fetch rejects an installed-undici
  // Agent as its dispatcher).
  fetcher: FetchSpecDeps['fetcher'];
  lookup: DnsLookup;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
  cacheFs: CacheFs;
}

export type CacheStatus =
  | 'bypassed'
  | 'fresh'
  | 'revalidated'
  | 'accepted-first'
  | 'accepted-update'
  | 'candidate'
  | 'stale';

export interface SpecPipelineResult {
  spec: NormalizedSpec;
  namedOperations: readonly NamedOperation[];
  contentHash: string;
  candidateContentHash?: string | undefined;
  displaySource: string;
  deadPatterns: readonly DeadPattern[];
  warnings: readonly string[];
  cacheStatus: CacheStatus;
}

interface ProcessedSpec {
  spec: NormalizedSpec;
  document: Record<string, unknown>;
}

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const enforceToolBudget = (spec: NormalizedSpec): void => {
  if (spec.operations.length > SPEC_BUDGETS.maxToolCount) {
    throw validationError(
      `spec defines ${spec.operations.length} operations — exceeds the ${SPEC_BUDGETS.maxToolCount}-tool budget`,
    );
  }
};

// Parse, validate, dereference, normalize, and enforce the tool budget. Every
// cache write happens downstream of this function, so an unvalidated or
// over-budget spec can never reach the disk.
const processSpecText = (text: string): ProcessedSpec => {
  const parsed = parseSpecText(text);
  const validated = validateOpenApiDocument(parsed);
  const dereferenced = dereference(validated.document);
  const spec = normalizeSpec(dereferenced, validated.version);
  enforceToolBudget(spec);
  return { spec, document: dereferenced };
};

// A cached document is already parsed and already dereferenced, so this path
// skips both. It also does NOT re-validate against the meta-schema: these
// bytes were validated before they were written and readCacheEntry has
// already checked their sha256 against meta.acceptedContentHash. The 3.0/3.1
// discriminator that would otherwise have been the reason to revalidate comes
// from meta.openapiVersion, which is persisted for exactly this.
const processCachedDocument = (
  document: Record<string, unknown>,
  openapiVersion: OpenapiVersion,
): NormalizedSpec => {
  const spec = normalizeSpec(document, openapiVersion);
  // Re-enforced per run: this bounds what will be exposed now, which is not
  // what the write-path check established
  enforceToolBudget(spec);
  return spec;
};

export const runSpecPipeline = async (
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
    } catch (err) {
      throw asCacheError(`prepare the namespace for ${policy.layout.namespace}`, err);
    }
    ({ layout } = policy);
  }

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
      throw validationError(
        `the spec cache entry is unusable (${read.reason}); it is the accepted baseline that authorizes this spec, so it is never refetched silently — run "openapi-mcp cache clear" to reset it deliberately`,
      );
    }
    if (read.kind === 'hit') {
      cached = read.entry;
    }
  }

  // File specs are re-read and hash-compared on every run, so
  // the TTL never short-circuits them; only URL sources take the no-network path.
  const decision =
    cached === undefined || source.kind === 'file'
      ? { kind: 'revalidate' as const }
      : evaluateFreshness(cached.meta, opts.nowMs, opts.ttlMs);

  if (cached !== undefined && decision.kind === 'fresh') {
    const spec = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(spec, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'fresh',
      // A restart inside the TTL still has to surface a waiting candidate
      cached,
    });
  }

  // The refresh attempt. The last-known-good rule wraps exactly this block:
  // a failed fetch or a failed validation of the REFRESHED spec falls back to
  // the accepted baseline. The corrupt-entry throw above is deliberately outside
  // it, because a corrupt anchor is never a recoverable condition.
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
      const conditional = await fetchSpecConditional(
        source.url,
        {
          headers: opts.specHeaders,
          timeoutMs: opts.timeoutMs,
          allowPrivateNetwork: opts.allowPrivateNetwork,
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
      processedRefresh = processSpecText(refreshed.loaded.text);
    }
  } catch (err) {
    if (cached === undefined) {
      throw err;
    }
    warnings.push(
      `spec refresh failed, serving the last known good accepted baseline: ${describeCause(err)}`,
    );
    const spec = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(spec, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'stale',
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
    return await commitRefresh(processedRefresh, refreshed, cached, layout, opts, deps, warnings);
  }

  // 304 Not Modified: reuse the accepted baseline, bump only the timestamp
  if (cached === undefined) {
    throw validationError('the spec source reported no change but nothing is cached');
  }
  if (layout !== undefined) {
    // Calling writeAccepted here would rewrite the accepted entry and CLEAR
    // the candidate, silently destroying a candidate awaiting promotion
    // without ever approving it. touchRevalidated updates the timestamp and
    // validators and preserves both slots.
    //
    // Typed, like every other cache mutation, so a raw fs failure here
    // cannot surface as an unexpected exit 1. A typed OpenapiMcpError from
    // the store (notably a lock conflict, exit 5) is passed through
    // unchanged.
    await touchRevalidated(layout, deps.cacheFs, opts.nowMs, {
      ...(notModifiedValidators.etag === undefined ? {} : { etag: notModifiedValidators.etag }),
      ...(notModifiedValidators.lastModified === undefined
        ? {}
        : { lastModified: notModifiedValidators.lastModified }),
    });
  }
  const spec = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
  return finish(spec, opts, warnings, {
    contentHash: cached.meta.sourceContentHash,
    displaySource: cached.meta.displaySource,
    cacheStatus: 'revalidated',
    cached,
  });
};

interface FinishInput {
  contentHash: string;
  candidateContentHash?: string | undefined;
  displaySource: string;
  cacheStatus: CacheStatus;
  // The entry being served, when one is. A candidate recorded in it must
  // surface on EVERY such result, not only on the run that created it.
  cached?: CacheEntry | undefined;
}

const PENDING_PROMOTION_WARNING =
  'a refreshed spec is waiting as a candidate; the accepted baseline is being served — run "openapi-mcp cache promote" to accept it';

const finish = (
  spec: NormalizedSpec,
  opts: SpecPipelineOptions,
  warnings: readonly string[],
  input: FinishInput,
): SpecPipelineResult => {
  const named = assignToolNames(spec.operations);
  // One budget for the whole filtering pass
  const filtered = applyFilters(named, opts.allow, opts.deny);
  // Reporting the candidate only on the `candidate` status would mean a
  // later start inside the TTL returns `fresh` with no candidate hash and no
  // warning — the candidate would be on disk, gating the update, and
  // completely invisible. The same holds for `revalidated` and `stale`. A
  // pending candidate is a property of the ENTRY, so it is reported wherever
  // that entry is served.
  const pending = input.cached?.meta.candidate;
  const candidateContentHash = input.candidateContentHash ?? pending?.contentHash;
  const allWarnings =
    pending === undefined || input.candidateContentHash !== undefined
      ? warnings
      : [...warnings, PENDING_PROMOTION_WARNING];
  return {
    spec,
    namedOperations: filtered.exposed,
    contentHash: input.contentHash,
    ...(candidateContentHash === undefined ? {} : { candidateContentHash }),
    displaySource: input.displaySource,
    deadPatterns: filtered.deadPatterns,
    warnings: allWarnings,
    cacheStatus: input.cacheStatus,
  };
};

interface Refreshed {
  loaded: LoadedSpecText;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

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
    });
    warnings.push(
      'the spec source changed; the refreshed spec is stored as a candidate awaiting "openapi-mcp cache promote"',
    );
    const spec = processCachedDocument(cached.acceptedDocument, cached.meta.openapiVersion);
    return finish(spec, opts, warnings, {
      contentHash: cached.meta.sourceContentHash,
      candidateContentHash: written.candidateContentHash,
      displaySource: cached.meta.displaySource,
      cacheStatus: 'candidate',
    });
  }
  if (layout !== undefined) {
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
    });
  }
  const cacheStatus = acceptedCacheStatus(layout, cached, unchanged);
  return finish(processed.spec, opts, warnings, {
    contentHash: refreshed.loaded.contentHash,
    displaySource: refreshed.loaded.displaySource,
    cacheStatus,
  });
};

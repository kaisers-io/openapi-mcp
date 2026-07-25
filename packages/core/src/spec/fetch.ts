import { isIP } from 'node:net';
import { validationError } from '../errors.ts';
import { assertAllowedRedirectTarget, type DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
import {
  createPinnedAgent,
  MAX_REDIRECTS,
  validateHopUrlSync,
  type PinnedPolicy,
} from '../http/pinned-dispatcher.ts';
import {
  describeCause,
  displaySource,
  errorName,
  failureHint,
  hostnameOf,
  readBodyCapped,
  readValidator,
  REDIRECT_STATUSES,
  validateHopUrl,
  type UndiciFetch,
  type UndiciResponse,
} from './fetch-transport.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { hashContent, type LoadedSpecText } from './load.ts';

// M6 Task 6: de-duplicated — `MAX_REDIRECTS` used to be defined separately
// here and in pinned-dispatcher.ts (both `5`); this module now re-exports the
// single source of truth so index.ts's public barrel is unchanged.
export { MAX_REDIRECTS } from '../http/pinned-dispatcher.ts';

export interface FetchSpecOptions {
  headers: readonly ResolvedHeader[];
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateNetwork?: boolean;
}

export interface FetchSpecDeps {
  // M6 Task 6 (DNS-pin stretch): undici's OWN fetch, never Node's global
  // fetch (dual-package hazard: the global fetch rejects an installed-undici
  // `Agent` as its `dispatcher`, probe-confirmed in pinned-dispatcher.ts).
  fetcher: UndiciFetch;
  lookup: DnsLookup;
}

// D16(a2): a 304 carries readable headers (probed), and the round-1 draft threw
// them away — so a revalidation could not refresh the validators it replays on
// the next run. The not-modified branch carries them.
export type ConditionalFetchResult =
  | { kind: 'not-modified'; etag?: string | undefined; lastModified?: string | undefined }
  | {
      kind: 'fetched';
      loaded: LoadedSpecText;
      etag?: string | undefined;
      lastModified?: string | undefined;
    };

type ConditionalOptions = FetchSpecOptions & {
  etag?: string | undefined;
  lastModified?: string | undefined;
};

// M6 Task 6 coverage note: an inline `.catch(() => undefined)` would create a
// fresh anonymous closure per call site that a fake-fetcher-based test can
// never exercise — undici's real Agent.destroy()/close() never rejects
// against a per-hop Agent that was never handed a live connection. Named and
// exported (module-internal; not part of the public barrel) so its own
// trivial, side-effect-free body is directly unit-testable instead of
// depending on a live rejection to prove it.
export const ignoreError = (): undefined => undefined;

// Binds the chain's `lookup` into the shape createPinnedAgent's `Resolve`
// expects — `(hostname) => deps.lookup(hostname, signal)` — closing over the
// whole-chain deadline (hardening item 2). Named and exported for the same
// reason as `ignoreError` above: a fake fetcher ignores `dispatcher`
// entirely, so this closure is otherwise unreachable through this file's
// fake-transport tests.
export const chainResolve =
  (lookup: DnsLookup, signal: AbortSignal) =>
  (hostname: string): Promise<readonly string[]> =>
    lookup(hostname, signal);

const fetchChain = async (
  initialUrl: URL,
  opts: ConditionalOptions,
  deps: FetchSpecDeps,
): Promise<ConditionalFetchResult> => {
  const timeoutMs = opts.timeoutMs ?? SPEC_BUDGETS.fetchTimeoutMs;
  const maxBytes = opts.maxBytes ?? SPEC_BUDGETS.maxSpecBytes;
  const allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
  // One deadline for the whole redirect chain
  const signal = AbortSignal.timeout(timeoutMs);
  const originalOrigin = initialUrl.origin;
  // The initial URL is operator intent (D4); it was already
  // scheme/userinfo/query-checked by parseSpecSource. M6 Task 6 hardening: it
  // is NOT exempt from the synchronous IP-literal guard below (hop 0 is
  // `trusted`, so a private/loopback literal is still allowed, but
  // cloud-metadata is now denied even for an operator-supplied --spec URL —
  // a deliberate hardening, not a regression: see the design §7.4 note).
  let url = initialUrl;
  validateHopUrl(url);
  // MONOTONIC (matches the API path's monotonic stripping, M5 Task 4): once
  // the chain has left the original origin, it never regains credentials —
  // even bouncing back to the original origin later. Set once true, never
  // reset.
  let crossed = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Hop 0 (--spec) carries the operator's trust; every redirect hop is
    // untrusted, same split as pinnedRequest's baseTrusted/hop===0 rule.
    const policy: PinnedPolicy = { allowPrivateNetwork, trusted: hop === 0 };
    // M6 Task 6 hardening (plan-review, mandatory): undici SKIPS
    // connect.lookup entirely for an IP-literal hostname, so
    // createPinnedAgent's lookup below never runs for a hop whose URL is
    // already a literal — this synchronous, pre-fetch check closes that gap
    // for EVERY hop (including hop 0, which previously got no address
    // validation at all). Reuses pinnedRequest's own guard rather than
    // reimplementing it.
    const syncViolation = validateHopUrlSync(url, policy);
    if (syncViolation !== undefined) {
      throw validationError(`spec URL ${displaySource(url)} rejected: ${syncViolation}`);
    }
    // Content-negotiation default first: configured headers override it (§3.3 precedence)
    const headers = new Headers({
      accept: 'application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.1',
    });
    if (!crossed && url.origin === originalOrigin) {
      // Auth headers are never forwarded to a foreign origin (spec §5.1), and
      // neither are cache validators: they describe the original origin's copy
      for (const header of opts.headers) {
        headers.set(header.name, header.value);
      }
      if (opts.etag !== undefined) {
        headers.set('if-none-match', opts.etag);
      }
      if (opts.lastModified !== undefined) {
        headers.set('if-modified-since', opts.lastModified);
      }
    }
    // M6 Task 6: a fresh per-hop pinned Agent (never trusted past hop 0),
    // whose connect-time lookup is the SAME resolution used to validate and
    // to connect — closing the residual validate-then-resolve TOCTOU a
    // separate pre-fetch DNS lookup would leave open. Bound to the
    // whole-chain deadline (`signal`) so DNS cannot outlive the fetch budget.
    const agent = createPinnedAgent(policy, chainResolve(deps.lookup, signal));
    let response: UndiciResponse;
    try {
      response = await deps.fetcher(url, {
        // A plain Record, not the `Headers` instance built above: undici's
        // own `Headers`/`RequestInit` types (declared against its OWN
        // fetch's .d.ts) are a DIFFERENT class from Node's global `Headers`
        // (dual-package hazard, same one documented in pinned-dispatcher.ts)
        // — passing the instance across that boundary is a type error, and
        // a plain header-name/value object sidesteps it entirely.
        headers: Object.fromEntries(headers),
        dispatcher: agent,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      // Exceptional path: destroy(), never the graceful close() that may
      // await a live response (mirrors pinnedRequest's Agent lifecycle).
      await agent.destroy().catch(ignoreError);
      const name = errorName(err);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw validationError(`spec fetch timed out after ${timeoutMs}ms (${displaySource(url)})`);
      }
      throw validationError(`spec fetch failed for ${displaySource(url)}: ${describeCause(err)}`);
    }
    let exceptional = false;
    try {
      // D6, verified by probe: fetch surfaces a 304 with ok === false and
      // body === null, so it must be recognised BEFORE both the redirect branch
      // and the !response.ok branch below — otherwise a successful revalidation
      // is reported as a fetch failure, and a 304 carrying a Location header
      // would be followed. Headers survive on a 304 but there is nothing to
      // read, so the body cancel is a no-op safety net.
      if (response.status === 304) {
        await response.body?.cancel();
        // D16(a2): a 304 carries readable headers (probed: etag survives), and
        // the round-1 draft discarded them — so a revalidation could never
        // refresh the validator it replays on the next run. They are bounded by
        // the same rule as on a 200: remote-controlled, stored, and replayed.
        const etag = readValidator(response, 'etag');
        const lastModified = readValidator(response, 'last-modified');
        return {
          kind: 'not-modified',
          ...(etag === undefined ? {} : { etag }),
          ...(lastModified === undefined ? {} : { lastModified }),
        };
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (location === null) {
          throw validationError(`redirect from ${displaySource(url)} has no Location header`);
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw validationError(
            `redirect from ${displaySource(url)} has an invalid Location header`,
          );
        }
        // D8 (sensitive query params) plus scheme/userinfo, unconditionally.
        validateHopUrl(next);
        // A literal-IP redirect target is fully covered by the next
        // iteration's `validateHopUrlSync` above (undici would skip its own
        // lookup for it too), so this async, DNS-resolving check is reserved
        // for genuine hostnames — the residual defense-in-depth layer for a
        // hostile/misconfigured resolver, bound to the same whole-chain
        // deadline. Kept deliberately narrow so the synchronous guard is
        // provably what rejects a literal (Step 7 falsification).
        if (isIP(hostnameOf(next)) === 0) {
          await assertAllowedRedirectTarget(next, { allowPrivateNetwork }, deps.lookup, signal);
        }
        if (next.origin !== originalOrigin) {
          crossed = true;
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw validationError(
          `spec fetch failed with HTTP ${response.status} for ${displaySource(url)}${failureHint(
            response.status,
            opts.headers.length > 0,
          )}`,
        );
      }
      const text = await readBodyCapped(response, maxBytes, displaySource(url));
      const etag = readValidator(response, 'etag');
      const lastModified = readValidator(response, 'last-modified');
      return {
        kind: 'fetched',
        loaded: { text, contentHash: hashContent(text), displaySource: displaySource(url) },
        ...(etag === undefined ? {} : { etag }),
        ...(lastModified === undefined ? {} : { lastModified }),
      };
    } catch (err) {
      exceptional = true;
      throw err;
    } finally {
      // Every non-exceptional path (a plain 200/304, or a redirect hop whose
      // body was already cancelled above) closes gracefully; every
      // exceptional path above destroys instead. Runs even on `continue`.
      await (exceptional ? agent.destroy() : agent.close()).catch(ignoreError);
    }
  }
  throw validationError(`spec fetch exceeded ${MAX_REDIRECTS} redirects`);
};

export const fetchSpec = async (
  initialUrl: URL,
  opts: FetchSpecOptions,
  deps: FetchSpecDeps,
): Promise<LoadedSpecText> => {
  const result = await fetchChain(initialUrl, opts, deps);
  if (result.kind === 'not-modified') {
    // No validator was sent, so a 304 here is the server answering a question
    // that was never asked: there is no body and no cached copy to fall back on
    throw validationError(
      `spec fetch returned HTTP 304 for ${displaySource(initialUrl)} without a conditional request`,
    );
  }
  return result.loaded;
};

// Spec §5.4: revalidation of an expired baseline. Validators are sent only when
// the cached entry actually recorded them; with neither this is a plain GET, and
// a 304 answer is then treated as "unchanged" — the fail-safe direction, since
// the caller keeps serving its accepted baseline.
export const fetchSpecConditional = (
  initialUrl: URL,
  opts: ConditionalOptions,
  deps: FetchSpecDeps,
): Promise<ConditionalFetchResult> => fetchChain(initialUrl, opts, deps);

import { validationError } from '../errors.ts';
import { assertAllowedRedirectTarget, type DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
import { VALIDATOR_RE } from '../schemas/cache.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { findSensitiveQueryParam, hashContent, type LoadedSpecText } from './load.ts';
import { sanitizeSpecText } from './sanitize.ts';

export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchSpecOptions {
  headers: readonly ResolvedHeader[];
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateNetwork?: boolean;
}

export interface FetchSpecDeps {
  fetcher: typeof fetch;
  lookup: DnsLookup;
}

// Redacted display form (spec §5.3): origin + path, query string dropped
const displaySource = (url: URL): string => `${url.origin}${url.pathname}`;

const validateHopUrl = (url: URL): void => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationError(
      `redirect to unsupported scheme "${url.protocol}" (${displaySource(url)})`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw validationError(`redirect target contains userinfo credentials (${displaySource(url)})`);
  }
  const sensitiveParam = findSensitiveQueryParam(url);
  if (sensitiveParam !== undefined) {
    // Spec §5.3 / D8 applies to every spec URL, including redirect targets.
    // The decoded name is remote-controlled: sanitize the display copy.
    throw validationError(
      `spec URL ${displaySource(url)} carries the credential-bearing query parameter "${sanitizeSpecText(sensitiveParam, 64)}" — query-string secrets are unsupported`,
    );
  }
};

const errorName = (err: unknown): string =>
  err !== null && typeof err === 'object' && 'name' in err ? String(err.name) : '';

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const readBodyCapped = async (
  response: Response,
  maxBytes: number,
  source: string,
): Promise<string> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw validationError(
        `spec at ${source} declares ${declared} bytes — exceeds the ${maxBytes}-byte budget`,
      );
    }
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw validationError(`spec at ${source} exceeds the ${maxBytes}-byte budget (decompressed)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const failureHint = (status: number, hasHeaders: boolean): string => {
  if (status !== 401 && status !== 403) {
    return '';
  }
  return hasHeaders
    ? ' — check the env vars configured via --spec-header-env'
    : ' — the spec URL may require authentication via --spec-header-env';
};

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

// A validator is remote-controlled, is stored in meta.json, and is replayed as a
// request header on the next revalidation: keep it bounded and printable ASCII,
// and drop anything else rather than storing a header-hostile value. The bound
// matches zCacheMeta's, so a value accepted here always survives the write.
const readValidator = (response: Response, name: string): string | undefined => {
  const raw = response.headers.get(name);
  return raw !== null && VALIDATOR_RE.test(raw) ? raw : undefined;
};

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
  // The initial URL is operator intent (D4) and gets no address validation;
  // it was already scheme/userinfo/query-checked by parseSpecSource
  let url = initialUrl;
  validateHopUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Content-negotiation default first: configured headers override it (§3.3 precedence)
    const headers = new Headers({
      accept: 'application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.1',
    });
    if (url.origin === originalOrigin) {
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
    let response: Response;
    try {
      response = await deps.fetcher(url, { headers, redirect: 'manual', signal });
    } catch (err) {
      const name = errorName(err);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw validationError(`spec fetch timed out after ${timeoutMs}ms (${displaySource(url)})`);
      }
      throw validationError(`spec fetch failed for ${displaySource(url)}: ${describeCause(err)}`);
    }
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
        throw validationError(`redirect from ${displaySource(url)} has an invalid Location header`);
      }
      validateHopUrl(next);
      // Remote-controlled target: full §7.4 address validation before fetching
      // (D4), with DNS resolution bound to the same whole-chain deadline
      await assertAllowedRedirectTarget(next, { allowPrivateNetwork }, deps.lookup, signal);
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

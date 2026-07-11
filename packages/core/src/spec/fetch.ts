import { validationError } from '../errors.ts';
import { assertAllowedRedirectTarget, type DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
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

export const fetchSpec = async (
  initialUrl: URL,
  opts: FetchSpecOptions,
  deps: FetchSpecDeps,
): Promise<LoadedSpecText> => {
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
      // Auth headers are never forwarded to a foreign origin (spec §5.1)
      for (const header of opts.headers) {
        headers.set(header.name, header.value);
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
    return { text, contentHash: hashContent(text), displaySource: displaySource(url) };
  }
  throw validationError(`spec fetch exceeded ${MAX_REDIRECTS} redirects`);
};

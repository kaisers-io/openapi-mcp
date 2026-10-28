// Pure, per-hop transport helpers
// shared by fetchChain — URL/redirect validation, capped body reading, and
// validator/error mapping. No orchestration lives here.
import type { fetch as undiciFetchType } from 'undici';
import { validationError } from '../errors.ts';
import { VALIDATOR_RE } from '../schemas/cache.ts';
import { findSensitiveQueryParam } from './load.ts';
import { sanitizeSpecText } from './sanitize.ts';

// `fetcher` is undici's OWN fetch, never Node's global fetch — the global
// fetch rejects an installed-undici `Agent` as its `dispatcher` (dual-package
// hazard, probe-confirmed in pinned-dispatcher.ts). A type-only import keeps
// this module free of a module-level fetch singleton; the caller (context.ts)
// supplies the real value.
export type UndiciFetch = typeof undiciFetchType;
export type UndiciResponse = Awaited<ReturnType<UndiciFetch>>;

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Redacted display form: origin + path, query string dropped
export const displaySource = (url: URL): string => `${url.origin}${url.pathname}`;

// URL.hostname keeps brackets around an IPv6 literal; strip them for isIP()
// (mirrors pinned-dispatcher.ts's private hostnameOf / egress.ts's own copy).
export const hostnameOf = (url: URL): string => {
  const raw = url.hostname;
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
};

export const validateHopUrl = (url: URL): void => {
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
    // The sensitive-name deny-list applies to every spec URL,
    // including redirect targets. The decoded name is remote-controlled:
    // sanitize the display copy.
    throw validationError(
      `spec URL ${displaySource(url)} carries the credential-bearing query parameter "${sanitizeSpecText(sensitiveParam, 64)}" — query-string secrets are unsupported`,
    );
  }
};

export const errorName = (err: unknown): string =>
  err !== null && typeof err === 'object' && 'name' in err ? String(err.name) : '';

export const describeCause = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const readBodyCapped = async (
  response: UndiciResponse,
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
  // Imperative on purpose: a streamed body read is inherently serial — each
  // chunk must be awaited, measured against the running total, and (on
  // overrun) cause an immediate reader.cancel() before the next chunk is
  // even requested. No array/stream combinator preserves that per-chunk
  // abort point.
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

export const fetchFailedError = (status: number, source: string, hasHeaders: boolean): Error =>
  validationError(
    `spec fetch failed with HTTP ${status} for ${source}${failureHint(status, hasHeaders)}`,
    status === 401 || status === 403 ? 'spec_http_401_403' : undefined,
  );

// A validator is remote-controlled, is stored in meta.json, and is replayed as a
// request header on the next revalidation: keep it bounded and printable ASCII,
// and drop anything else rather than storing a header-hostile value. The bound
// matches zCacheMeta's, so a value accepted here always survives the write.
export const readValidator = (response: UndiciResponse, name: string): string | undefined => {
  const raw = response.headers.get(name);
  return raw !== null && VALIDATOR_RE.test(raw) ? raw : undefined;
};

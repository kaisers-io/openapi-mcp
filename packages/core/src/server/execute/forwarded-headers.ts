import { parseLinkHeader, parseRetryAfter } from '../../http/response-headers.ts';
import type { LinkValue } from '../../http/response-headers.ts';
import type { Redactor } from '../../redact.ts';
import { sanitizeSpecText } from '../../spec/sanitize.ts';
import { NO_NEXT_PAGE } from '../../toolgen/pagination.ts';
import type { PageHint } from '../../toolgen/pagination.ts';

import type { ToolCallOutcome } from '../result.ts';

export type { PageHint } from '../../toolgen/pagination.ts';

export type PageInput = {
  links?: readonly LinkValue[];
  responseUrl: string;
  data?: unknown;
};

// Turns the transport's captured response headers into what a tool result
// may carry. Every value is upstream-controlled text, so each one is
// sanitized (control/bidi characters stripped, length capped) and dropped
// outright if it contains a registered secret — dropping one header is
// enough; the response body itself is unaffected.
//
// Upstream URLs never reach the model as-is (decision D4):
// - `Link` is not forwarded at all; pagination hints are derived from it
//   as tool arguments instead.
// - `Location` is forwarded only when it resolves to the SAME origin as the
//   configured base URL, and then only as a path (+ query) — never with a
//   scheme or host that could steer the next call elsewhere.

const MAX_FORWARDED_VALUE = 512;

export type ForwardOptions = {
  headers: Readonly<Record<string, string>>;
  // The URL of the hop that produced the response (relative targets
  // resolve against it).
  responseUrl: string;
  // The configured API base; only its origin is used.
  baseUrl: string;
  redactor: Redactor;
};

const sameOriginPath = (
  location: string,
  responseUrl: string,
  baseUrl: string,
): string | undefined => {
  try {
    const target = new URL(location, responseUrl);
    if (
      target.origin !== new URL(baseUrl).origin ||
      target.username !== '' ||
      target.password !== ''
    ) {
      return undefined;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return undefined;
  }
};

const hasSecret = (redactor: Redactor, value: unknown): boolean => {
  try {
    return redactor.scanForSecret(value);
  } catch {
    return true;
  }
};

// Link never; Location only as a same-origin path; anything else as sent.
const forwardedValue = (name: string, raw: string, opts: ForwardOptions): string | undefined => {
  if (name === 'link') {
    return undefined;
  }
  return name === 'location' ? sameOriginPath(raw, opts.responseUrl, opts.baseUrl) : raw;
};

export const forwardableHeaders = (opts: ForwardOptions): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(opts.headers)) {
    const value = forwardedValue(name, raw, opts);
    const clean = value === undefined ? '' : sanitizeSpecText(value, MAX_FORWARDED_VALUE);
    if (clean !== '' && !hasSecret(opts.redactor, clean)) {
      out[name] = clean;
    }
  }
  return out;
};

// RFC 9110 §10.2.3: Retry-After is meaningful on 503 and on 3xx/429 — the
// tool result only acts on the two "slow down" statuses.
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export const upstreamRetryAfterMs = (
  status: number,
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | undefined => {
  const value = headers['retry-after'];
  return RETRY_STATUSES.has(status) && value !== undefined
    ? parseRetryAfter(value, nowMs)
    : undefined;
};

// Adds a short trailing `headers:` section to a text-only result (a
// structured success carries them inside its envelope instead), and the
// parsed upstream back-off — named `upstreamRetryAfterMs`, distinct from the
// local limiter's `retryAfterMs` (decision D6) — in `_meta`.
export const decorateTextOutcome = (
  outcome: ToolCallOutcome,
  forwarded: Readonly<Record<string, string>>,
  retryAfterMs: number | undefined,
  // A paginated text result's next-page hint, as its own block.
  pagination?: PageHint,
): ToolCallOutcome => {
  const entries = Object.entries(forwarded);
  const blocks: { type: 'text'; text: string }[] =
    entries.length === 0 || outcome.structuredContent !== undefined
      ? []
      : [
          {
            type: 'text',
            text: `headers:\n${entries.map(([name, value]) => `${name}: ${value}`).join('\n')}`,
          },
        ];
  if (pagination !== undefined) {
    blocks.push({ type: 'text', text: `pagination: ${JSON.stringify(pagination)}` });
  }
  const withHeaders: ToolCallOutcome =
    blocks.length === 0 ? outcome : { ...outcome, content: [...outcome.content, ...blocks] };
  return retryAfterMs === undefined
    ? withHeaders
    : {
        ...withHeaders,
        meta: { ...withHeaders.meta, 'openapi-mcp/upstreamRetryAfterMs': retryAfterMs },
      };
};

// Binds a paginated tool's hint callback to one successful response (its
// parsed Link header and URL), and withholds any hint that would echo a
// registered secret into the next call's arguments.
export const pageHinter = (
  paginate: (input: PageInput) => PageHint,
  redactor: Redactor,
  headers: Readonly<Record<string, string>>,
  responseUrl: string,
  status: number,
): ((data?: unknown) => PageHint) | undefined => {
  if (status < 200 || status > 299) {
    return undefined;
  }
  const linkHeader = headers['link'];
  const links = linkHeader === undefined ? undefined : (parseLinkHeader(linkHeader) ?? []);
  return (data) => {
    const hint = paginate({
      ...(links === undefined ? {} : { links }),
      responseUrl,
      ...(data === undefined ? {} : { data }),
    });
    return hasSecret(redactor, hint) ? { next: NO_NEXT_PAGE } : hint;
  };
};

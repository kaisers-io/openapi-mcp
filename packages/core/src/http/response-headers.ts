// Upstream response headers worth keeping: pagination (`Link`), the
// location of a created resource, caching validators, totals, and the
// rate-limit / back-off signals an agent needs to pace itself. Everything
// else is dropped at the transport — in particular `Set-Cookie` and any
// authentication header can never be captured, because only names on this
// fixed allowlist are read at all.
//
// Capture is bounded (count, per-value and total size) so a hostile upstream
// cannot inflate a result through its headers. These are RAW values: the
// response mapper still sanitizes, redacts and filters them before anything
// reaches a tool result, and `Link`/`Location` are never forwarded as raw
// URLs (see server/execute/forwarded-headers.ts).

const EXACT_NAMES: ReadonlySet<string> = new Set([
  'link',
  'location',
  'etag',
  'last-modified',
  'retry-after',
  'x-total-count',
]);
// `x-ratelimit-limit`/`-remaining`/`-reset` (GitHub and many others) and the
// IETF `RateLimit` / `RateLimit-Policy` fields (and their older
// `RateLimit-Limit`/`-Remaining`/`-Reset` draft spellings).
const PREFIXES: readonly string[] = ['x-ratelimit-', 'ratelimit'];

export const MAX_CAPTURED_HEADERS = 16;
// RFC 8288 Link headers on paginated APIs list four or five URLs; 4 KB keeps
// the GitHub-style first/prev/next/last set comfortably.
export const MAX_HEADER_VALUE_BYTES = 4096;
export const MAX_CAPTURED_HEADER_BYTES = 8192;

const isCapturedName = (name: string): boolean =>
  EXACT_NAMES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix));

// `headers` iterates lowercased names, with repeated fields already combined
// by `, ` (the Fetch Headers contract). A value over the per-value cap is
// dropped whole — a truncated Link or ETag would be wrong, not just short.
export const captureResponseHeaders = (
  headers: Iterable<[string, string]>,
): Record<string, string> => {
  const captured: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  let total = 0;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    const size = name.length + value.length;
    if (
      isCapturedName(name) &&
      value.length <= MAX_HEADER_VALUE_BYTES &&
      count < MAX_CAPTURED_HEADERS &&
      total + size <= MAX_CAPTURED_HEADER_BYTES
    ) {
      captured[name] = value;
      count += 1;
      total += size;
    }
  }
  return captured;
};

// Retry-After (RFC 9110 §10.2.3): either delay-seconds (1*DIGIT) or an
// HTTP-date. Returns milliseconds from `nowMs`, clamped to >= 0, or
// undefined when the value is neither form. Capped at one day so a hostile
// value cannot advertise an absurd wait.
const MAX_RETRY_AFTER_MS = 86_400_000;
export const parseRetryAfter = (value: string, nowMs: number): number | undefined => {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  // An HTTP-date always names a weekday and "GMT"; anything else (a bare
  // number with a sign or decimals, free text) is not a valid Retry-After.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(trimmed)) {
    return undefined;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
};

export type LinkValue = {
  // The target as written (a URI-reference, possibly relative).
  target: string;
  // Lowercased relation types from `rel` (space-separated in RFC 8288).
  rels: readonly string[];
};

// A strict RFC 8288 §3 parser for the `Link` field:
//   Link       = #link-value
//   link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )
//   link-param = token BWS [ "=" BWS ( token / quoted-string ) ]
// Any syntax error makes the WHOLE header unparseable (undefined): a lenient
// parser that guesses at a malformed Link could hand back a wrong "next".
const TOKEN_RE = /^[\w!#$%&'*+.^`|~-]+/u;
const QUOTED_RE = /^"(?<inner>(?:[^"\\]|\\.)*)"/u;

// One `token / quoted-string` parameter value at the start of `rest`, with
// quoted-pairs unescaped, and how many characters it used; undefined when
// neither form is there.
const readParamValue = (rest: string): { value: string; length: number } | undefined => {
  const quoted = QUOTED_RE.exec(rest);
  if (quoted !== null) {
    const inner = quoted.groups?.['inner'] ?? '';
    return { value: inner.replaceAll(/\\(?<escaped>.)/gu, '$<escaped>'), length: quoted[0].length };
  }
  const token = TOKEN_RE.exec(rest)?.[0];
  return token === undefined ? undefined : { value: token, length: token.length };
};

const skipOws = (text: string, at: number): number => {
  let index = at;
  while (text[index] === ' ' || text[index] === '\t') {
    index += 1;
  }
  return index;
};

// Imperative on purpose: a single left-to-right scan over a bounded
// (MAX_HEADER_VALUE_BYTES) string, where every step depends on the
// position the previous step reached.
export const parseLinkHeader = (value: string): LinkValue[] | undefined => {
  const links: LinkValue[] = [];
  let at = skipOws(value, 0);
  while (at < value.length) {
    if (value[at] !== '<') {
      return undefined;
    }
    const close = value.indexOf('>', at + 1);
    if (close === -1) {
      return undefined;
    }
    const target = value.slice(at + 1, close);
    if (/[\s<>"]/u.test(target)) {
      return undefined;
    }
    let rels: string[] = [];
    at = skipOws(value, close + 1);
    while (value[at] === ';') {
      at = skipOws(value, at + 1);
      const name = TOKEN_RE.exec(value.slice(at))?.[0];
      if (name === undefined) {
        return undefined;
      }
      at = skipOws(value, at + name.length);
      let paramValue = '';
      if (value[at] === '=') {
        at = skipOws(value, at + 1);
        const param = readParamValue(value.slice(at));
        if (param === undefined) {
          return undefined;
        }
        paramValue = param.value;
        at += param.length;
        at = skipOws(value, at);
      }
      // RFC 8288 §3.3: only the first `rel` parameter counts.
      if (name.toLowerCase() === 'rel' && rels.length === 0) {
        rels = paramValue
          .toLowerCase()
          .split(/[ \t]+/u)
          .filter((rel) => rel !== '');
      }
    }
    links.push({ target, rels });
    if (at >= value.length) {
      break;
    }
    if (value[at] !== ',') {
      return undefined;
    }
    at = skipOws(value, at + 1);
  }
  return links;
};

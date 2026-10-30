import { Buffer } from 'node:buffer';
import { validationError } from './errors.ts';
import { createMatcher, replaceSpans } from './redact-match.ts';
import type { Span } from './redact-match.ts';

const MAX_SECRETS = 64; // Bound construction cost
// For a caller that adds up the secrets of several sources (issue #16)
export const MAX_REDACTED_SECRETS = MAX_SECRETS;
const MAX_SECRET_LENGTH = 8192; // Bound per-needle scan cost
const MIN_VARIANT_LENGTH = 8; // Encoding variants (except JSON escaping) only for 8+ char secrets
const REDACTED = '[redacted]';

// The JSON-string-escaped forms of a secret (issue #46). For a short secret
// they are needles only when they differ from the raw value: then they
// contain an escape (`\"`, `\\`, `\n`, `\u0001`, `\/`) that the raw value
// does not. That can also match the same escape in a body without the
// secret, which redacts more, never less (fail-closed).
const jsonVariantsOf = (secret: string): string[] => {
  const json = JSON.stringify(secret).slice(1, -1);
  return [json, json.replaceAll('/', String.raw`\/`)].filter((form) => form !== secret);
};

// The literal needles for one secret: the raw value, plus (for 8+ chars) the
// bounded encoded forms an upstream plausibly echoes it in — standard
// Base64, Base64URL, percent-encoding with upper- AND lowercase hex (RFC 3986
// §2.1 makes them equivalent and some servers emit lowercase),
// application/x-www-form-urlencoded (space as `+`, per the WHATWG URL
// serializer), and the JSON-string-escaped body (`JSON.stringify` escapes,
// plus `/` as `\/`, which PHP's json_encode and others emit). The JSON forms
// matter for TEXT bodies: an `application/json` body is already covered by
// response.ts's parse-and-scan-structure path, but a text/plain or HTML
// error page that embeds a JSON snippet is only ever string-redacted.
// All literal strings — matched literally by redact-match.ts, never a built
// RegExp (no ReDoS surface; the one RegExp below is a fixed pattern applied
// to the ENCODED secret, not built from it). Callers dedupe through a Set,
// so a secret with no special characters costs no extra needles for the
// forms that collapse to the raw value.
const variantsOf = (secret: string): string[] => {
  if (secret.length < MIN_VARIANT_LENGTH) {
    return [secret, ...jsonVariantsOf(secret)];
  }
  const std = Buffer.from(secret, 'utf8').toString('base64');
  const url = std.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const pct = encodeURIComponent(secret);
  const pctLower = pct.replaceAll(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
  const form = new URLSearchParams([['', secret]]).toString().slice(1);
  return [secret, std, url, pct, pctLower, form, ...jsonVariantsOf(secret)];
};

// RFC 9110 §5.6.2 `token` (the auth-scheme) followed by whitespace and ONE
// further whitespace-free run — the `auth-scheme 1*SP token68` shape of
// RFC 9110 §11.4 (`Bearer x`, `Token x`, `Basic x`, `ApiKey x`). A fixed,
// linear pattern (the three character classes are pairwise disjoint, so
// there is no backtracking ambiguity) over a value already capped at
// MAX_SECRET_LENGTH. Deliberately NOT a generic "last whitespace-separated
// token": the scheme must be a bare token (no `/`, `(`, `;`...), so a
// static header such as `User-Agent: client/1.2 extra-info` or
// `Accept: text/html, application/json` never has a fragment of it promoted
// to a needle. The auth-param list form (`Digest username="..", ...`) is
// intentionally out of scope: its values are per-request digests, not a
// reusable credential, and it contains several spaces.
const AUTH_CREDENTIALS_RE = /^(?<scheme>[!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]+(?<credential>\S+)$/u;

// Strict UTF-8 decode for a Basic credential: a password that does not
// decode cleanly is not text an upstream could echo as text.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// RFC 7617 §2: `Basic base64(user-id ":" password)`. Returns the decoded
// `user:pass` and the password, or nothing when the credential is not
// canonical Base64 (Buffer.from is lenient — it skips invalid characters —
// so the round-trip check rejects anything that is not exactly what an
// encoder would have produced) or carries no colon.
const basicParts = (credential: string): string[] => {
  const bytes = Buffer.from(credential, 'base64');
  if (bytes.toString('base64') !== credential) {
    return [];
  }
  let decoded: string;
  try {
    decoded = strictUtf8.decode(bytes);
  } catch {
    return [];
  }
  // RFC 7617 §2: the user-id cannot contain a colon, so the FIRST colon is
  // the separator and the password may itself contain colons.
  const colon = decoded.indexOf(':');
  return colon === -1 ? [] : [decoded, decoded.slice(colon + 1)];
};

// The secrets DERIVED from one registered value, beyond the value itself.
// A header secret is registered as its whole value (`Bearer <token>`), but
// an upstream that echoes the credential ("invalid api key <token>") echoes
// only the part after the scheme — so that part is a secret in its own
// right. For Basic, the decoded `user:pass` and the password are, too
// (login-failure messages commonly name them). The user-id ALONE is never
// derived: it is an identifier, not a secret, and is often a short common
// word. Every derived part shorter than MIN_VARIANT_LENGTH is dropped, so a
// short password or token fragment cannot become a needle that redacts
// ordinary text or collides with the marker (the marker guard in
// createRedactor still runs over every derived needle — fail closed).
// Auth-scheme matching is case-insensitive (RFC 9110 §11.1).
//
// This lives HERE rather than at registration (api-options.ts) on purpose:
// createRedactor is the single choke point that every secret source feeds
// (spec-fetch headers, --header/--header-env, the HTTP bearer token — see
// serve.ts), so deriving here covers all of them uniformly and keeps the
// MAX_SECRETS / length budgets and the marker guard in one place.
const derivedSecretsOf = (secret: string): string[] => {
  const match = AUTH_CREDENTIALS_RE.exec(secret);
  if (match === null) {
    return [];
  }
  const { scheme = '', credential = '' } = match.groups ?? {};
  const parts = [credential, ...(scheme.toLowerCase() === 'basic' ? basicParts(credential) : [])];
  return parts.filter((part) => part.length >= MIN_VARIANT_LENGTH);
};

export type Redactor = {
  redactString: (value: string) => string;
  redactJson: (value: unknown) => unknown;
  scanForSecret: (value: unknown) => boolean;
};

// The redactor createRedactor returns: the read side every output channel
// uses, plus append-only registration for the one owner of runtime secrets.
export type RuntimeRedactor = Redactor & {
  // Registers a secret obtained AFTER startup (an OAuth2 access token) so
  // every later redaction covers it. Must be called before the secret is
  // first used. Throws a validationError, registering nothing, when the
  // value fails the same checks a startup secret does or the runtime budget
  // is exhausted — the caller must then not use the secret (fail closed).
  // `retainUntilMs` is when the secret stops being a usable credential
  // (its expiry); only then may it be dropped to make room for a new one.
  // `owner` identifies the registering token source (one per API); a
  // secret registered by several stays live until each has retired it.
  registerRuntimeSecret: (
    secret: string,
    retainUntilMs: number,
    nowMs: number,
    owner?: object,
  ) => void;
  // Marks a registered runtime secret as REPLACED for `owner`: it has a newer
  // credential and will never send this one again. It stays redacted, but
  // may be evicted to make room once no owner still uses it and the budget
  // is full.
  retireRuntimeSecret: (secret: string, owner?: object) => void;
};

// Bounds the runtime registrations held at once. An entry past its
// retainUntilMs is dropped first; when that is not enough, the OLDEST
// retired (replaced, no longer sent) entry makes room. A credential still in
// use is never dropped — registration fails instead.
export const MAX_RUNTIME_SECRETS = 256;

// The validated needle set for one secret. Throws on a value that cannot be
// redacted safely: empty, over the length budget, or yielding a needle
// that is a substring of the marker (the replacement would reintroduce it,
// silently defeating redaction).
const needlesOf = (secret: string): string[] => {
  if (secret === '') {
    throw validationError('cannot register an empty secret with the redactor');
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw validationError('secret exceeds the redaction length budget');
  }
  const needles = [secret, ...derivedSecretsOf(secret)].flatMap((part) => variantsOf(part));
  if (needles.some((needle) => REDACTED.includes(needle))) {
    throw validationError(
      'a configured secret is too trivial to redact safely (it is a substring of the redaction marker)',
    );
  }
  return needles;
};

// `owners` still send it: with several APIs (issue #16) two token sources
// can be issued the same token, and one replacing it must not retire it for
// the other. Retired once no owner is left.
type RuntimeSecret = { needles: readonly string[]; retainUntilMs: number; owners: Set<object> };

// The owner of a registration that names none
const SOLE_OWNER = {};

export const createRedactor = (rawSecrets: readonly string[]): RuntimeRedactor => {
  if (rawSecrets.length > MAX_SECRETS) {
    throw validationError(`too many secrets to redact (${rawSecrets.length} > ${MAX_SECRETS})`);
  }
  // Each secret is validated — and, on failure, THROWS — in encounter order.
  const staticNeedles = rawSecrets.flatMap((secret) => needlesOf(secret));
  const runtime = new Map<string, RuntimeSecret>();
  // Longest first: an encoding variant that contains a shorter needle as a
  // substring must still redact as the whole variant (createMatcher takes
  // the first — longest — needle matching at each position). Rebuilt only
  // when the runtime set changes (a token refresh, minutes apart), never
  // per redaction.
  const build = (): ((value: string, firstOnly: boolean) => Span[]) => {
    const needles = new Set([
      ...staticNeedles,
      ...[...runtime.values()].flatMap((entry) => entry.needles),
    ]);
    return createMatcher([...needles].toSorted((first, second) => second.length - first.length));
  };
  let findSpans = build();
  const registerRuntimeSecret = (
    secret: string,
    retainUntilMs: number,
    nowMs: number,
    owner: object = SOLE_OWNER,
  ): void => {
    const needles = needlesOf(secret);
    for (const [value, entry] of runtime) {
      if (entry.retainUntilMs <= nowMs) {
        runtime.delete(value);
      }
    }
    if (!runtime.has(secret) && runtime.size >= MAX_RUNTIME_SECRETS) {
      // Map iteration is insertion order: the first retired entry is the
      // oldest replaced credential.
      const oldestRetired = [...runtime].find(([, entry]) => entry.owners.size === 0)?.[0];
      if (oldestRetired === undefined) {
        // Rebuild anyway: expired entries may have been pruned above.
        findSpans = build();
        throw validationError('too many unexpired runtime secrets to redact');
      }
      runtime.delete(oldestRetired);
    }
    const existing = runtime.get(secret);
    runtime.set(secret, {
      needles,
      retainUntilMs: Math.max(existing?.retainUntilMs ?? retainUntilMs, retainUntilMs),
      owners: new Set([...(existing?.owners ?? []), owner]),
    });
    findSpans = build();
  };
  const retireRuntimeSecret = (secret: string, owner: object = SOLE_OWNER): void => {
    runtime.get(secret)?.owners.delete(owner);
  };
  // `value` is unbounded untrusted text (a response body, a request, etc.):
  // one matcher pass over it, then one join — a clean value is returned
  // as-is without any copy.
  const redactString = (value: string): string => {
    const spans = findSpans(value, false);
    return spans.length === 0 ? value : replaceSpans(value, spans, REDACTED);
  };
  const stringHasSecret = (value: string): boolean => findSpans(value, true).length > 0;
  // Contract: operates on JSON-compatible data only (JSON.parse output or the
  // built envelope) — symbol/non-enumerable keys and cycles are out of
  // contract; a pathologically deep input throws, mapped by the executor to
  // a generic isError.
  const scanForSecret = (value: unknown): boolean => {
    if (typeof value === 'string') {
      return stringHasSecret(value);
    }
    // A JSON number can echo a secret made of digits, in any spelling
    // (`987654321`, `9.87654321e8`): its canonical text is what the client
    // reads back.
    if (typeof value === 'number') {
      return stringHasSecret(String(value));
    }
    if (Array.isArray(value)) {
      return value.some((item) => scanForSecret(item));
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).some(([key, val]) => stringHasSecret(key) || scanForSecret(val));
    }
    return false;
  };
  // Contract: operates on JSON-compatible data only (JSON.parse output or the
  // built envelope) — symbol/non-enumerable keys and cycles are out of
  // contract; a pathologically deep input throws, mapped by the executor to
  // a generic isError.
  const redactJson = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactJson(item));
    }
    if (value !== null && typeof value === 'object') {
      // Null-prototype record: bracket assignment must always create an own
      // key, even for a hostile own-enumerable `__proto__` key from
      // JSON.parse — a plain `{}` would invoke the prototype setter instead.
      // Imperative on purpose: `value` is an unbounded, arbitrarily nested
      // untrusted JSON structure — the explicit loop mirrors scanForSecret's
      // recursive-streaming shape rather than building an intermediate
      // entries array via `.map`/Object.fromEntries.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, val] of Object.entries(value)) {
        out[redactString(key)] = redactJson(val);
      }
      return out;
    }
    return value;
  };
  return { redactString, redactJson, scanForSecret, registerRuntimeSecret, retireRuntimeSecret };
};

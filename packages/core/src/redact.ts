import { Buffer } from 'node:buffer';
import { validationError } from './errors.ts';

const MAX_SECRETS = 64; // Bound construction cost
const MAX_SECRET_LENGTH = 8192; // Bound per-needle scan cost
const MIN_VARIANT_LENGTH = 8; // Encoding variants only for 8+ char secrets
const REDACTED = '[redacted]';

// The literal needles for one secret: the raw value, plus (for 8+ chars) the
// bounded standard-Base64, Base64URL, and percent-encoded forms. All literal
// strings — matched via split/join, never a built RegExp (no ReDoS surface).
const variantsOf = (secret: string): string[] => {
  if (secret.length < MIN_VARIANT_LENGTH) {
    return [secret];
  }
  const std = Buffer.from(secret, 'utf8').toString('base64');
  const url = std.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return [secret, std, url, encodeURIComponent(secret)];
};

export type Redactor = {
  redactString: (value: string) => string;
  redactJson: (value: unknown) => unknown;
  scanForSecret: (value: unknown) => boolean;
};

export const createRedactor = (rawSecrets: readonly string[]): Redactor => {
  if (rawSecrets.length > MAX_SECRETS) {
    throw validationError(`too many secrets to redact (${rawSecrets.length} > ${MAX_SECRETS})`);
  }
  const needles = new Set<string>();
  // Imperative on purpose (like headers.ts's mapping loop): each secret is
  // validated — and, on failure, THROWS — in encounter order, while
  // `needles` accumulates variant strings across iterations. A `flatMap`
  // whose callback threw would be technically equivalent but would hide
  // that side effect inside a mapping; the explicit loop keeps it visible.
  for (const secret of rawSecrets) {
    if (secret === '') {
      throw validationError('cannot register an empty secret with the redactor');
    }
    if (secret.length > MAX_SECRET_LENGTH) {
      throw validationError('secret exceeds the redaction length budget');
    }
    for (const variant of variantsOf(secret)) {
      needles.add(variant);
    }
  }
  // Longest first: an encoding variant that contains a shorter needle as a
  // substring must still redact as the whole variant.
  const ordered = [...needles].toSorted((first, second) => second.length - first.length);
  // Fail closed at construction: a needle that is itself a substring of the
  // marker would be reintroduced into the output by the very replacement
  // meant to remove it, silently defeating redaction.
  for (const needle of ordered) {
    if (REDACTED.includes(needle)) {
      throw validationError(
        'a configured secret is too trivial to redact safely (it is a substring of the redaction marker)',
      );
    }
  }
  // Imperative on purpose: `value` is unbounded untrusted text (a response
  // body, a request, etc.) — the streaming replace-in-place shape here
  // avoids building intermediate closures/arrays over that text beyond what
  // split/join already require per matched needle.
  const redactString = (value: string): string => {
    let out = value;
    for (const needle of ordered) {
      if (out.includes(needle)) {
        out = out.split(needle).join(REDACTED);
      }
    }
    return out;
  };
  const stringHasSecret = (value: string): boolean =>
    ordered.some((needle) => value.includes(needle));
  // Contract: operates on JSON-compatible data only (JSON.parse output or the
  // built envelope) — symbol/non-enumerable keys and cycles are out of
  // contract; a pathologically deep input throws, mapped by the executor to
  // a generic isError.
  const scanForSecret = (value: unknown): boolean => {
    if (typeof value === 'string') {
      return stringHasSecret(value);
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
  return { redactString, redactJson, scanForSecret };
};

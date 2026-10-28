import { usageError } from '../errors.ts';

// RFC 9110 token grammar for header field names
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// The names every `*-env` flag accepts
export const isEnvVarName = (name: string): boolean => ENV_VAR_NAME_RE.test(name);
// Any C0 control or DEL in a header value is a request-smuggling vector
// oxlint-disable-next-line no-control-regex -- matching control characters is this regex's purpose (it rejects them)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;
// A header value travels as bytes (RFC 9110 §5.5); undici, like the Fetch
// standard, requires a ByteString and only throws when the request is sent,
// as an opaque transport failure on every call. U+0080..U+00FF pass and are
// sent as single bytes, which the receiver reads as Latin-1 (ISO-8859-1).
// oxlint-disable-next-line no-control-regex -- the range starts at U+0000 only to state "every Latin-1 code point"; the negated class matches nothing below U+0100
export const NON_LATIN1_RE = /[^\u0000-\u00FF]/u;

export type HeaderEnvMapping = {
  headerName: string;
  envVar: string;
};

export const parseHeaderEnvMapping = (raw: string): HeaderEnvMapping => {
  const separatorIndex = raw.indexOf('=');
  if (separatorIndex === -1) {
    throw usageError(`invalid header mapping "${raw}" — expected <Header>=<ENV_VAR>`);
  }
  const headerName = raw.slice(0, separatorIndex);
  const envVar = raw.slice(separatorIndex + 1);
  if (!HEADER_NAME_RE.test(headerName)) {
    throw usageError(
      `invalid header name "${headerName}" in "${raw}" — must match the RFC 9110 token grammar`,
    );
  }
  if (!ENV_VAR_NAME_RE.test(envVar)) {
    throw usageError(`invalid env var name "${envVar}" in "${raw}"`);
  }
  return { headerName, envVar };
};

export type ResolvedHeader = {
  name: string;
  value: string;
};

export const resolveHeaderEnvMappings = (
  mappings: readonly HeaderEnvMapping[],
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedHeader[] => {
  const seen = new Set<string>();
  const resolved: ResolvedHeader[] = [];
  // Imperative on purpose: each mapping validates (and, on failure, throws)
  // in encounter order while `seen` accumulates duplicate-detection state.
  // A `map` whose callback mutated that dedup state and threw would be
  // technically equivalent, but it would hide the side effects inside a
  // mapping — the explicit loop keeps them visible.
  for (const mapping of mappings) {
    const lower = mapping.headerName.toLowerCase();
    if (seen.has(lower)) {
      throw usageError(
        `duplicate header "${mapping.headerName}" — header names must be unique (case-insensitive)`,
      );
    }
    seen.add(lower);
    const value = env[mapping.envVar];
    if (value === undefined || value === '') {
      throw usageError(
        `environment variable "${mapping.envVar}" (for header "${mapping.headerName}") is not set or empty`,
        'env_missing',
      );
    }
    if (CONTROL_CHAR_RE.test(value)) {
      // Never echo the value: it is a secret
      throw usageError(
        `value of environment variable "${mapping.envVar}" contains control characters`,
      );
    }
    if (NON_LATIN1_RE.test(value)) {
      // Never echo the value: it is a secret
      throw usageError(
        `value of environment variable "${mapping.envVar}" (for header "${mapping.headerName}") contains a character above U+00FF, which an HTTP header cannot carry — set it to ASCII or Latin-1 text`,
      );
    }
    resolved.push({ name: mapping.headerName, value });
  }
  return resolved;
};

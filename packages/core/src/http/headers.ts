import { usageError } from '../errors.ts';

// RFC 9110 token grammar for header field names
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// Any C0 control or DEL in a header value is a request-smuggling vector
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;

export interface HeaderEnvMapping {
  headerName: string;
  envVar: string;
}

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

export interface ResolvedHeader {
  name: string;
  value: string;
}

export const resolveHeaderEnvMappings = (
  mappings: readonly HeaderEnvMapping[],
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedHeader[] => {
  const seen = new Set<string>();
  const resolved: ResolvedHeader[] = [];
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
      );
    }
    if (CONTROL_CHAR_RE.test(value)) {
      // Never echo the value: it is a secret
      throw usageError(
        `value of environment variable "${mapping.envVar}" contains control characters`,
      );
    }
    resolved.push({ name: mapping.headerName, value });
  }
  return resolved;
};

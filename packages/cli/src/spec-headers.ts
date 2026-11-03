import {
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { ResolvedHeader } from '@kaisers-io/openapi-mcp-core';
import { parseBasicAuth } from './api-options.ts';

export const SPEC_BASIC_AUTH_HELP =
  'HTTP Basic auth for the spec fetch, user name and password read from env (password optional)';

// The spec fetch's credential headers: --spec-header-env, and the
// Authorization header --spec-basic-auth-env builds (issue #132). Both are
// spec headers, so the cleartext gate, the cache isolation and the
// redaction (which also covers the decoded user and password) apply alike.
export const resolveSpecHeaders = (
  opts: { specHeaderEnv: readonly string[]; specBasicAuthEnv?: string },
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedHeader[] => {
  const headers = resolveHeaderEnvMappings(
    opts.specHeaderEnv.map((raw) => parseHeaderEnvMapping(raw)),
    env,
  );
  const basic = parseBasicAuth(opts.specBasicAuthEnv, env, '--spec-basic-auth-env');
  if (basic === undefined) {
    return headers;
  }
  if (headers.some((header) => header.name.toLowerCase() === 'authorization')) {
    throw usageError(
      '--spec-basic-auth-env cannot be combined with --spec-header-env Authorization=... (both set the Authorization header)',
    );
  }
  return [...headers, { name: basic.name, value: basic.value }];
};

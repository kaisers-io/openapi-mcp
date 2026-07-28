import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { notFoundError, usageError, validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';

// Any RFC 3986 scheme prefix, not just "://" forms — "file:/x" is a URL, not a path
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
// Same sensitive-name deny-list as the --header rule, applied to query names
const SENSITIVE_NAME_RE = /auth|token|secret|key|session|credential|cookie|signature/iu;

export type SpecSource = { kind: 'url'; url: URL } | { kind: 'file'; path: string };

// Shared with the redirect-hop validation in fetch.ts: this deny-list applies
// to every spec URL, not just the initial one
export const findSensitiveQueryParam = (url: URL): string | undefined => {
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_NAME_RE.test(name)) {
      return name;
    }
  }
  return undefined;
};

export const parseSpecSource = (raw: string, opts: { cwd: string }): SpecSource => {
  if (raw === '') {
    throw usageError('--spec must not be empty');
  }
  if (SCHEME_RE.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      // Do not echo the raw input: an unparsable URL may still carry a credential
      throw usageError('invalid spec URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw usageError(
        `unsupported URL scheme "${url.protocol}" for --spec — only http: and https: are allowed` +
          ' (prefix a relative file path containing ":" with "./")',
      );
    }
    if (url.username !== '' || url.password !== '') {
      // Do not echo the raw URL: userinfo may contain a credential
      throw usageError(
        'spec URLs must not contain userinfo credentials — use --spec-header-env for authentication',
      );
    }
    const sensitiveParam = findSensitiveQueryParam(url);
    if (sensitiveParam !== undefined) {
      // Query-string secrets are unsupported; never echo the value
      throw usageError(
        `spec URL query parameter "${sanitizeSpecText(sensitiveParam, 64)}" looks credential-bearing — query-string secrets are unsupported, use --spec-header-env`,
      );
    }
    return { kind: 'url', url };
  }
  // Resolve() also canonicalizes already-absolute paths (drops "..", ".")
  return { kind: 'file', path: resolve(opts.cwd, raw) };
};

export const hashContent = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export interface LoadedSpecText {
  text: string;
  contentHash: string;
  displaySource: string;
}

export interface FileLoadDeps {
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
}

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const loadSpecFromFile = async (
  path: string,
  maxBytes: number,
  deps: FileLoadDeps,
): Promise<LoadedSpecText> => {
  let size: number;
  try {
    size = await deps.fileSizeBytes(path);
  } catch (err) {
    throw notFoundError(`cannot read spec file "${path}": ${describeCause(err)}`);
  }
  if (size > maxBytes) {
    throw validationError(
      `spec file "${path}" is ${size} bytes — exceeds the ${maxBytes}-byte budget`,
    );
  }
  let text: string;
  try {
    text = await deps.readFileText(path);
  } catch (err) {
    throw notFoundError(`cannot read spec file "${path}": ${describeCause(err)}`);
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) {
    // TOCTOU guard: the file may have grown between stat and read
    throw validationError(
      `spec file "${path}" is ${byteLength} bytes — exceeds the ${maxBytes}-byte budget`,
    );
  }
  return { text, contentHash: hashContent(text), displaySource: path };
};

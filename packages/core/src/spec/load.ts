import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { notFoundError, usageError, validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';

// Any RFC 3986 scheme prefix, not just "://" forms — "file:/x" is a URL, not a path
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
// On Windows an absolute path starts with a drive letter and a colon, which SCHEME_RE alone takes
// for a one-letter URL scheme ("C:\specs\api.json" would be refused as scheme "c:"). A drive
// letter followed by a separator is a path (Microsoft, "File path formats on Windows systems");
// no registered URL scheme has one letter. A drive-relative "C:api.json" stays a scheme error
// with the "./" hint, and UNC paths ("\\server\share\api.json") never matched SCHEME_RE.
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/iu;
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

const parseUrlOrThrow = (raw: string): URL => {
  try {
    return new URL(raw);
  } catch {
    // Do not echo the raw input: an unparsable URL may still carry a credential
    throw usageError('invalid spec URL');
  }
};

// `platform` defaults to the running one; tests pass it to cover the other path grammar.
// Linux and macOS keep exactly the POSIX behaviour: there "C:/x" is still scheme "c:".
export const parseSpecSource = (
  raw: string,
  opts: { cwd: string; platform?: NodeJS.Platform },
): SpecSource => {
  if (raw === '') {
    throw usageError('--spec must not be empty');
  }
  const isWindows = (opts.platform ?? process.platform) === 'win32';
  if (SCHEME_RE.test(raw) && !(isWindows && WINDOWS_DRIVE_PATH_RE.test(raw))) {
    const url = parseUrlOrThrow(raw);
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
  return { kind: 'file', path: (isWindows ? win32 : posix).resolve(opts.cwd, raw) };
};

export const hashContent = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// For bytes as read from disk: equal to hashContent(text) whenever the bytes
// are text's UTF-8 encoding, without decoding and re-encoding them first
export const hashBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export type LoadedSpecText = {
  text: string;
  contentHash: string;
  displaySource: string;
};

export type FileLoadDeps = {
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
};

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Named seam wrapper: `read` is an injected async dependency (fileSizeBytes /
// readFileText) that the caller may swap for a fake in tests, so the
// try/catch stays — collapsing it to `.catch()` would narrow the catch
// boundary around a Promise-typed seam that a fake can still reject or throw
// through in ways the real implementation wouldn't.
const readOrNotFound = async <T>(read: () => Promise<T>, path: string): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    throw notFoundError(`cannot read spec file "${path}": ${describeCause(error)}`);
  }
};

export const loadSpecFromFile = async (
  path: string,
  maxBytes: number,
  deps: FileLoadDeps,
): Promise<LoadedSpecText> => {
  const size = await readOrNotFound(() => deps.fileSizeBytes(path), path);
  if (size > maxBytes) {
    throw validationError(
      `spec file "${path}" is ${size} bytes — exceeds the ${maxBytes}-byte budget`,
    );
  }
  const text = await readOrNotFound(() => deps.readFileText(path), path);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) {
    // TOCTOU guard: the file may have grown between stat and read
    throw validationError(
      `spec file "${path}" is ${byteLength} bytes — exceeds the ${maxBytes}-byte budget`,
    );
  }
  return { text, contentHash: hashContent(text), displaySource: path };
};

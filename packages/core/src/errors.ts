export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// Stable causes a user can fix in the config (issue #79), documented in
// docs/configuration.md. Removing one or changing its meaning is a breaking
// change; `code` and the exit code stay what they were.
export type ErrorReason =
  | 'env_missing'
  | 'base_url_unresolved'
  | 'spec_http_401_403'
  | 'spec_external_ref'
  | 'filter_no_selector';

export class OpenapiMcpError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly reason: ErrorReason | undefined;

  constructor(code: string, message: string, exitCode: ExitCode, reason?: ErrorReason) {
    super(message);
    this.name = 'OpenapiMcpError';
    this.code = code;
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

export const reasonOf = (err: unknown): ErrorReason | undefined =>
  err instanceof OpenapiMcpError ? err.reason : undefined;

export const usageError = (message: string, reason?: ErrorReason): OpenapiMcpError =>
  new OpenapiMcpError('usage', message, EXIT.USAGE, reason);

export const validationError = (message: string, reason?: ErrorReason): OpenapiMcpError =>
  new OpenapiMcpError('validation', message, EXIT.VALIDATION, reason);

// A dedicated code for "a namespace-shaped path exists but is not a real
// directory" (a planted file or symlink), distinct from `validationError`.
// It carries the SAME exit code (3) — a single-namespace `cache clear` on
// such a path must still fail exactly as it did before this type split. The
// separate code exists so a caller (the `--all` sweep) can discriminate on
// THIS specific signal by CODE rather than by matching substrings in the
// message, which an attacker-controlled path could otherwise spoof: a path
// containing the literal text "is not a directory" would make an unrelated
// validationError (e.g. an over-budget lock file read) collide with a
// message-based match.
export const cachePathTypeError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('cache_path_type', message, EXIT.VALIDATION);

export const notFoundError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('not_found', message, EXIT.NOT_FOUND);

export const conflictError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('conflict', message, EXIT.CONFLICT);

export type RenderedError = {
  code: string;
  reason?: ErrorReason;
  exitCode: ExitCode;
  message: string;
  stack?: string;
};

export const renderError = (err: unknown, opts: { verbose: boolean }): RenderedError => {
  if (err instanceof OpenapiMcpError) {
    return {
      code: err.code,
      ...(err.reason === undefined ? {} : { reason: err.reason }),
      exitCode: err.exitCode,
      message: err.message,
      ...(opts.verbose && err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return {
    code: 'unexpected',
    exitCode: EXIT.UNEXPECTED,
    message,
    ...(opts.verbose && stack !== undefined ? { stack } : {}),
  };
};

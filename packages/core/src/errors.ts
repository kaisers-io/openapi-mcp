export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class OpenapiMcpError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;

  constructor(code: string, message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'OpenapiMcpError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('usage', message, EXIT.USAGE);

export const validationError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('validation', message, EXIT.VALIDATION);

export const notFoundError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('not_found', message, EXIT.NOT_FOUND);

export const conflictError = (message: string): OpenapiMcpError =>
  new OpenapiMcpError('conflict', message, EXIT.CONFLICT);

export interface RenderedError {
  code: string;
  exitCode: ExitCode;
  message: string;
  stack?: string;
}

export const renderError = (err: unknown, opts: { verbose: boolean }): RenderedError => {
  if (err instanceof OpenapiMcpError) {
    return {
      code: err.code,
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

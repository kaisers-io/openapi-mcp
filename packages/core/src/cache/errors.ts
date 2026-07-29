import { OpenapiMcpError, validationError } from '../errors.ts';

// The only errors read as "nothing here" (ENOENT/ENOTDIR). A miss is the one
// outcome that may become trust-on-first-use, so anything else is a real
// failure rather than an absence.
export const isCacheAbsence = (err: unknown): boolean =>
  err !== null &&
  typeof err === 'object' &&
  'code' in err &&
  (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// Types a persistent-cache I/O failure as a validationError so it exits 3 as
// the Global Constraints declare, rather than surfacing as an unexpected exit 1.
export const cacheIoError = (operation: string, err: unknown): Error =>
  validationError(
    `the spec cache could not ${operation}: ${err instanceof Error ? err.message : String(err)}`,
  );

// A store operation can fail two ways: with a typed OpenapiMcpError it raised
// deliberately (a lock conflictError, exit 5; a corrupt-object validationError,
// exit 3), or with a raw filesystem error. The first MUST pass through
// unchanged — flattening a conflict into a validation error would lose the exit
// code the Global Constraints promise — and only the second is translated.
export const asCacheError = (operation: string, err: unknown): unknown =>
  err instanceof OpenapiMcpError ? err : cacheIoError(operation, err);

// The boundary is applied at each public DEFINITION rather than at call sites,
// so coverage is structural. Generic over the whole signature so it preserves
// withNamespaceLock's own type parameter.
export const withCacheErrors =
  <A extends unknown[], R>(
    operation: string,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      throw asCacheError(operation, error);
    }
  };

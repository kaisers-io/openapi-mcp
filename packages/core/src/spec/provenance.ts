import type { OmittedOperation } from './normalize.ts';
import { isRecord } from './refs.ts';

// An omitted operation keeps its operationId and tags (issue #41), so a filter
// pattern that names it by either is recognized as naming an operation that
// is not supported, instead of getting a suggestion for a different one
export const withProvenance = <T extends OmittedOperation | object>(entry: T, op: unknown): T => {
  if (!('reason' in entry) || !isRecord(op)) {
    return entry;
  }
  const { operationId, tags } = op;
  const named = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    ...entry,
    ...(typeof operationId === 'string' && operationId !== '' ? { operationId } : {}),
    ...(named.length === 0 ? {} : { tags: named }),
  };
};

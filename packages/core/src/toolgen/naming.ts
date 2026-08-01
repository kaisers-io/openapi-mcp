import { createHash } from 'node:crypto';
import { validationError } from '../errors.ts';
import type { OperationRecord } from '../spec/normalize.ts';

// 64 is a deliberate compatibility cap (MCP allows up to 128)
export const TOOL_NAME_MAX_LENGTH = 64;

const INVALID_CHARS_RE = /[^A-Za-z0-9_.-]/gu;

const sanitizeName = (raw: string): string =>
  raw.replaceAll(INVALID_CHARS_RE, '_').slice(0, TOOL_NAME_MAX_LENGTH);

const methodPathName = (method: string, path: string): string => {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      const paramMatch = /^\{(?<name>.+)\}$/u.exec(segment);
      return paramMatch?.groups === undefined ? segment : `by_${paramMatch.groups['name']}`;
    });
  return sanitizeName([method, ...segments].join('_').toLowerCase());
};

const operationKey = (operation: OperationRecord): string =>
  `${operation.method.toUpperCase()} ${operation.path}`;

const hashSuffix = (operation: OperationRecord, length: number): string =>
  `_${createHash('sha256').update(operationKey(operation)).digest('hex').slice(0, length)}`;

const withSuffix = (base: string, suffix: string): string =>
  `${base.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;

export type NamedOperation = {
  operation: OperationRecord;
  toolName: string;
};

const collisionCounts = (entries: readonly { toolName: string }[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
  }
  return counts;
};

export const assignToolNames = (
  operations: readonly OperationRecord[],
): readonly NamedOperation[] => {
  const entries = operations.map((operation) => {
    const fromId = operation.operationId === undefined ? '' : sanitizeName(operation.operationId);
    const base = fromId === '' ? methodPathName(operation.method, operation.path) : fromId;
    return { operation, base, toolName: base };
  });
  // Collisions get a stable content-hash suffix derived from METHOD + path, so
  // names never change when the spec is reordered. The second,
  // longer pass covers operationIds crafted to mimic a suffixed name.
  for (const suffixLength of [8, 16]) {
    const counts = collisionCounts(entries);
    if (![...counts.values()].some((count) => count > 1)) {
      break;
    }
    for (const entry of entries) {
      if ((counts.get(entry.toolName) ?? 0) > 1) {
        entry.toolName = withSuffix(entry.base, hashSuffix(entry.operation, suffixLength));
      }
    }
  }
  const finalCounts = collisionCounts(entries);
  if ([...finalCounts.values()].some((count) => count > 1)) {
    throw validationError('could not derive unique tool names — rename the colliding operationIds');
  }
  return entries.map(({ operation, toolName }) => ({ operation, toolName }));
};

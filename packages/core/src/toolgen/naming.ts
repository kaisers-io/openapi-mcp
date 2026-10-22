import { createHash } from 'node:crypto';
import { validationError } from '../errors.ts';
import type { OperationRecord } from '../spec/normalize.ts';

// 64 is a deliberate compatibility cap (MCP allows up to 128)
export const TOOL_NAME_MAX_LENGTH = 64;

// The charset the major tool-calling APIs accept: OpenAI requires
// ^[a-zA-Z0-9_-]{1,64}$ and Anthropic ^[a-zA-Z0-9_-]{1,128}$. MCP itself also
// allows `.`, but a host forwards our names to such an API, so a dot is
// replaced like any other character outside the set.
const INVALID_RUN_RE = /[^A-Za-z0-9_-]+/gu;
const EDGE_INVALID_RE = /^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/gu;
const COMBINING_MARK_RE = /\p{M}/gu;
const HAS_ALPHANUMERIC_RE = /[A-Za-z0-9]/u;

// NFKD splits accented letters into base letter + combining mark and folds
// compatibility forms (full-width `ｇ` to `g`), so dropping the marks keeps
// `Ünïcödé` readable as `Unicode` instead of `_n_c_d_`. What is still outside
// the charset becomes ONE underscore per run, and runs at the ends are
// dropped; underscores the author wrote are kept as they are. A result with no
// ASCII letter or digit (a CJK operationId, say) carries no meaning for the
// model, so it is reported as empty and the caller falls back to method+path.
const cleanPiece = (raw: string): string =>
  raw
    .normalize('NFKD')
    .replaceAll(COMBINING_MARK_RE, '')
    .replaceAll(EDGE_INVALID_RE, '')
    .replaceAll(INVALID_RUN_RE, '_');

const sanitizeName = (raw: string): string => {
  const cleaned = cleanPiece(raw).slice(0, TOOL_NAME_MAX_LENGTH);
  return HAS_ALPHANUMERIC_RE.test(cleaned) ? cleaned : '';
};

// Every `{name}` becomes `by_name`, also inside a segment with static text:
// `{id}.json` -> `by_id_json` (Rails-style and file-extension routes). Each
// placeholder and each static piece is cleaned on its own and the non-empty
// ones are joined with one underscore, so the `.` between them does not leave
// a double underscore behind.
const PLACEHOLDER_SPLIT_RE = /(?<placeholder>\{[^{}]+\})/u;

const segmentName = (segment: string): string =>
  segment
    .split(PLACEHOLDER_SPLIT_RE)
    .map((piece) =>
      piece.startsWith('{') && piece.endsWith('}')
        ? `by_${cleanPiece(piece.slice(1, -1))}`
        : cleanPiece(piece),
    )
    .filter((piece) => piece !== '' && piece !== 'by_')
    .join('_');

const methodPathName = (method: string, path: string): string => {
  const segments = path
    .split('/')
    .map((segment) => segmentName(segment))
    .filter((segment) => segment !== '');
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

const collisionCounts = (entries: readonly { toolName: string }[]): Map<string, number> =>
  entries.reduce((counts, entry) => {
    counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

export const assignToolNames = (
  operations: readonly OperationRecord[],
): readonly NamedOperation[] => {
  const entries = operations.map((operation) => {
    const fromId = operation.operationId === undefined ? '' : sanitizeName(operation.operationId);
    const base = fromId === '' ? methodPathName(operation.method, operation.path) : fromId;
    return { operation, base, toolName: base };
  });
  // Imperative on purpose: this is a two-pass fixed-point rename (try an
  // 8-char suffix, escalate to 16 only if collisions remain) with an early
  // `break` once a pass resolves everything — a map/reduce restatement would
  // still need to mutate-or-rebuild `entries` between passes and would hide
  // the early exit that skips the second, more expensive hashing pass
  // entirely. `entries` was just built by the `.map` above and is never
  // observed outside this function before the final `.map` below returns
  // fresh `{ operation, toolName }` records, so renaming `.toolName` in
  // place carries no caller-visible side effect.
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

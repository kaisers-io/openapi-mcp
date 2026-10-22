import type { CacheFs } from '../cache/fs.ts';
import type { CacheLayout } from '../cache/paths.ts';
import { corruptEntryError, readCandidateDocument } from '../cache/store.ts';
import type { CacheEntry } from '../cache/store.ts';
import { conflictError } from '../errors.ts';
import type { NamedOperation } from '../toolgen/naming.ts';
import { HTTP_METHODS } from './normalize.ts';
import type { OmittedOperation } from './normalize.ts';
import { sanitizeSpecText } from './sanitize.ts';

// While a changed spec waits as a candidate, the accepted baseline keeps
// serving — but an operation the candidate no longer has is withheld at once
// (#60). That is the one automatic change the cache allows, because it only
// ever narrows what a model can do: the API provider removed the endpoint
// (deprecated, unsafe, gone), and keeping it callable until someone runs
// `cache promote` would be the unsafe direction. Everything else in the
// candidate — new operations, changed schemas or descriptions — still waits:
// an operation present in both keeps its ACCEPTED definition.
//
// Operations are matched by `METHOD path`, the identity the spec itself
// gives them (an operationId can be added, renamed or dropped without the
// endpoint changing). Path parameter NAMES are not part of that identity:
// OpenAPI treats templated paths that differ only in parameter names as the
// same path, so `/pets/{petId}` renamed to `/pets/{id}` is the same endpoint,
// not a removal. Each `{…}` is therefore normalized to `{}` for matching.
//
// `servers` (the base URL / base path) is not part of the key either: a
// candidate that moves the API from `/v1` to `/v2` but keeps `paths` removes
// nothing here; the move itself waits for `cache promote` like any change.
const TEMPLATE_PARAM_RE = /\{[^{}]*\}/gu;
const operationKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.replaceAll(TEMPLATE_PARAM_RE, '{}')}`;
const displayKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

// Every `METHOD path` the candidate document declares. Read from the
// validated, dereferenced document's own `paths`, not from its normalized
// form: an operation present there is present for this purpose even if this
// build would omit it as a tool, so it is never withheld by mistake.
export const operationKeysOf = (document: Record<string, unknown>): ReadonlySet<string> => {
  const keys = new Set<string>();
  const { paths } = document;
  if (typeof paths !== 'object' || paths === null) {
    return keys;
  }
  for (const [path, item] of Object.entries(paths)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (typeof operation === 'object' && operation !== null) {
        keys.add(operationKey(method, path));
      }
    }
  }
  return keys;
};

// The candidate's operation keys for an entry served with a pending
// candidate, or undefined when none is waiting. Fails closed: the candidate
// decides what is NOT exposed, so a candidate that cannot be verified is
// treated like any other damaged cache object, and one replaced by a
// concurrent commit while this run read it asks for a rerun.
export const pendingCandidateKeys = async (
  layout: CacheLayout | undefined,
  fs: CacheFs,
  cached: CacheEntry,
): Promise<ReadonlySet<string> | undefined> => {
  const { candidate } = cached.meta;
  if (candidate === undefined || layout === undefined) {
    return undefined;
  }
  const read = await readCandidateDocument(layout, fs, candidate.contentHash);
  if (read.kind === 'changed') {
    throw conflictError(
      `cache entry ${layout.namespace} changed while this run was reading it (another openapi-mcp process promoted, refreshed or cleared it) — run the command again`,
    );
  }
  if (read.kind === 'corrupt') {
    throw corruptEntryError(read.reason);
  }
  return operationKeysOf(read.document);
};

const WITHHELD_REASON =
  'removed in the pending candidate spec; withheld until "openapi-mcp cache promote" (or the source restores it)';

// Bounds the warning line; the full list is in the result and the meta tool
const WITHHELD_WARNING_MAX = 20;
const PATH_DISPLAY_MAX = 256;

export const withholdRemoved = (
  exposed: readonly NamedOperation[],
  candidateKeys: ReadonlySet<string> | undefined,
): {
  exposed: readonly NamedOperation[];
  withheld: readonly OmittedOperation[];
  warning?: string | undefined;
} => {
  if (candidateKeys === undefined) {
    return { exposed, withheld: [] };
  }
  const keep = (named: NamedOperation): boolean =>
    candidateKeys.has(operationKey(named.operation.method, named.operation.path));
  const removed = exposed.filter((named) => !keep(named));
  if (removed.length === 0) {
    return { exposed, withheld: [] };
  }
  // Spec-derived paths reach the operator's terminal: sanitized and bounded
  const listed = removed
    .slice(0, WITHHELD_WARNING_MAX)
    .map(
      (named) =>
        `${displayKey(named.operation.method, sanitizeSpecText(named.operation.path, PATH_DISPLAY_MAX))} (${named.toolName})`,
    );
  const more = removed.length - listed.length;
  return {
    exposed: exposed.filter((named) => keep(named)),
    withheld: removed.map((named) => ({
      method: named.operation.method,
      path: named.operation.path,
      reason: WITHHELD_REASON,
    })),
    warning: `${String(removed.length)} operation(s) removed in the pending candidate spec are withheld until "openapi-mcp cache promote": ${listed.join(', ')}${
      more > 0 ? `, and ${String(more)} more` : ''
    }`,
  };
};

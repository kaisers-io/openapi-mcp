import { Buffer } from 'node:buffer';
import { SPEC_BUDGETS } from './budgets.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const PLACEHOLDER_RE = /\{(?<name>[^{}]+)\}/gu;

const defaultOf = (variables: Record<string, unknown>, name: string): string | undefined => {
  const variable = variables[name];
  const defaultValue = isRecord(variable) ? variable['default'] : undefined;
  return typeof defaultValue === 'string' ? defaultValue : undefined;
};

// The UTF-8 byte length the expansion WILL have, computed without building it:
// the template's bytes, minus each placeholder, plus its default. Undefined
// when a placeholder has no string default (the expansion is unresolvable
// anyway). One scan of the template; each distinct default is measured once.
//
// Why this exists (issue #37): one-pass replacement prevents recursive
// expansion, but not placeholder count x default length. An 11 kB spec with
// 2000 `{x}` and a 5000-character default is valid and expanded to a
// 10,000,018-character URL; source-byte and node-count budgets do not bound
// that product, so it has to be bounded here, before the allocation.
const expandedByteLength = (
  template: string,
  variables: Record<string, unknown>,
): number | undefined => {
  const defaultBytes = new Map<string, number | undefined>();
  let bytes = Buffer.byteLength(template, 'utf8');
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match.groups?.['name'] ?? '';
    if (!defaultBytes.has(name)) {
      const value = defaultOf(variables, name);
      defaultBytes.set(name, value === undefined ? undefined : Buffer.byteLength(value, 'utf8'));
    }
    const replacement = defaultBytes.get(name);
    if (replacement === undefined) {
      return undefined;
    }
    bytes += replacement - Buffer.byteLength(match[0], 'utf8');
  }
  return bytes;
};

export type ServerUrlExpansion =
  | { kind: 'expanded'; url: string }
  // A placeholder without a string default, or a residual brace: no URL
  | { kind: 'unresolvable' }
  // The result would exceed SPEC_BUDGETS.maxServerUrlBytes; nothing was built
  | { kind: 'over-budget'; bytes: number };

// The operator-facing warning for an over-budget server URL. It names only the
// byte count and the budget: the template and defaults are spec content,
// possibly huge, and warnings reach stderr and MCP hosts.
export const serverUrlRejectedWarning = (bytes: number): string =>
  `servers[0].url expands to ${String(bytes)} bytes after variable substitution, over the ` +
  `${String(SPEC_BUDGETS.maxServerUrlBytes)}-byte budget for a server URL, so it is ignored; ` +
  'pass --base-url <url>, or shorten the URL or its variable defaults in the spec';

// Substitute every `{name}` placeholder in a server URL template with
// `variables[name].default`. Unresolvable if any placeholder lacks a matching
// `variables` entry with a string default. Over-budget, before anything is
// built, when the result would exceed SPEC_BUDGETS.maxServerUrlBytes. That is
// reported, not thrown: the check already bounds the work, and a throw would
// reject a spec whose only problem is a URL that `--base-url` overrides
// (normalize.ts marks it `serverUrlRejected`; serve requires --base-url then).
//
// No early exit on the running total in expandedByteLength: a placeholder
// longer than its default shrinks the result, so a running total over the
// budget can still end under it. The scan is bounded by the template, which
// the source-byte budget already bounds.
//
// Single-pass only: `String.replace` with a global regex scans the ORIGINAL
// template left-to-right exactly once and never re-scans replacement text.
// A prior per-match `split(placeholder).join(defaultValue)` loop re-scanned
// the growing ACCUMULATOR on every iteration; a hostile spec with a
// placeholder repeated k times whose own default re-injects that placeholder
// (e.g. `url: "{x}{x}...{x}"`, `variables.x.default = "{x}{x}"`) doubled the
// placeholder count each iteration, an exponential (~k*2^k) CPU/memory DoS
// at spec-normalization time on untrusted spec content. A residual `{`/`}`
// after the single pass (malformed template, or a default that itself
// injected a brace) is fail-closed to unresolvable rather than resolved.
export const expandServerUrlTemplate = (
  template: string,
  variables: Record<string, unknown>,
): ServerUrlExpansion => {
  const bytes = expandedByteLength(template, variables);
  if (bytes === undefined) {
    return { kind: 'unresolvable' };
  }
  if (bytes > SPEC_BUDGETS.maxServerUrlBytes) {
    return { kind: 'over-budget', bytes };
  }
  // Every placeholder has a string default here: expandedByteLength checked it
  const expanded = template.replaceAll(
    PLACEHOLDER_RE,
    (_whole: string, name: string) => defaultOf(variables, name) ?? '',
  );
  return expanded.includes('{') || expanded.includes('}')
    ? { kind: 'unresolvable' }
    : { kind: 'expanded', url: expanded };
};

// The NormalizedSpec fields extractServerUrl fills (see normalize.ts).
export type ServerUrlFields = {
  serverUrl?: string;
  serverUrlRejected?: { expandedBytes: number };
  serverUrlIsRelative?: boolean;
};

// Absolute iff the candidate URL has a leading URI scheme (RFC 3986 §3.1).
const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

// Extracts the base-URL candidate from ROOT `document.servers[0]` only
// (path/operation-level `servers` overrides stay omitted in normalize.ts). Fail-closed: any malformed shape yields `{}` rather than
// throwing, and never affects the generated operation set. An expansion over
// the byte budget is marked `serverUrlRejected` instead.
export const extractServerUrl = (document: Record<string, unknown>): ServerUrlFields => {
  const { servers } = document;
  if (!Array.isArray(servers) || servers.length === 0) {
    return {};
  }
  const [first] = servers;
  if (!isRecord(first) || typeof first['url'] !== 'string') {
    return {};
  }
  const variables = isRecord(first['variables']) ? first['variables'] : {};
  const expansion = expandServerUrlTemplate(first['url'], variables);
  if (expansion.kind === 'over-budget') {
    return { serverUrlRejected: { expandedBytes: expansion.bytes } };
  }
  if (expansion.kind === 'unresolvable') {
    return {};
  }
  const serverUrl = expansion.url;
  return ABSOLUTE_SCHEME_PATTERN.test(serverUrl)
    ? { serverUrl }
    : { serverUrl, serverUrlIsRelative: true };
};

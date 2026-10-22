import { Buffer } from 'node:buffer';
import { validationError } from '../errors.ts';
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

// Substitute every `{name}` placeholder in a server URL template with
// `variables[name].default`. Returns undefined (unresolvable) if any
// placeholder lacks a matching `variables` entry with a string default.
// Throws a validation error, before building anything, when the result would
// exceed SPEC_BUDGETS.maxServerUrlBytes. The message names neither the
// template nor a default: both are spec content, possibly huge, and the error
// reaches stderr and MCP hosts.
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
// injected a brace) is fail-closed to undefined rather than resolved.
export const expandServerUrlTemplate = (
  template: string,
  variables: Record<string, unknown>,
): string | undefined => {
  const bytes = expandedByteLength(template, variables);
  if (bytes === undefined) {
    return undefined;
  }
  if (bytes > SPEC_BUDGETS.maxServerUrlBytes) {
    throw validationError(
      `servers[0].url expands to ${String(bytes)} bytes after variable substitution — ` +
        `exceeds the ${String(SPEC_BUDGETS.maxServerUrlBytes)}-byte budget for a server URL; ` +
        'shorten the URL or its variable defaults in the spec',
    );
  }
  // Every placeholder has a string default here: expandedByteLength checked it
  const expanded = template.replaceAll(
    PLACEHOLDER_RE,
    (_whole: string, name: string) => defaultOf(variables, name) ?? '',
  );
  return expanded.includes('{') || expanded.includes('}') ? undefined : expanded;
};

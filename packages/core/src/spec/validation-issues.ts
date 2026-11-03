import { sanitizeSpecText } from './sanitize.ts';

// The locations where a spec fails OpenAPI schema validation, one entry
// each (issue #131). Ajv runs with allErrors, so it reports every failing
// location at once, plus noise: an object that fails also fails the
// `oneOf` of "this object or a $ref", and every parent of a failing node
// fails the same way. Only the deepest locations are kept, each with the
// messages that say what is wrong there.

export type ValidationIssue = { path: string; messages: readonly string[] };

type AjvErrorLike = {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
};

// Paths and property names are spec text: bounded and stripped like any
const PATH_MAX = 256;
const NAME_MAX = 64;
export const MAX_ISSUES = 20;

// The "or a $ref" half of a Reference-or-Object `oneOf`, and the `oneOf`
// itself: true but never the cause when anything else failed there. An
// `anyOf` stays: it says that its alternatives, listed next to it, are
// alternatives (3.1 needs one of `paths`, `components`, `webhooks`).
const isNoise = (error: AjvErrorLike): boolean =>
  error.keyword === 'oneOf' ||
  (error.keyword === 'required' && error.params?.['missingProperty'] === '$ref');

const messageOf = (error: AjvErrorLike): string => {
  const base = error.message ?? 'invalid';
  const extra = error.params?.['additionalProperty'];
  return typeof extra === 'string' ? `${base} ("${sanitizeSpecText(extra, NAME_MAX)}")` : base;
};

// Every proper ancestor of each path, in time linear in the paths' length:
// a hostile spec can fail at thousands of locations
const ancestorsOf = (paths: Iterable<string>): Set<string> => {
  const ancestors = new Set<string>();
  for (const path of paths) {
    for (let slash = path.lastIndexOf('/'); slash >= 0; slash = path.lastIndexOf('/', slash - 1)) {
      ancestors.add(path.slice(0, slash));
      if (slash === 0) {
        break;
      }
    }
  }
  return ancestors;
};

export const validationIssues = (errors: readonly AjvErrorLike[]): ValidationIssue[] => {
  const byPath = new Map<string, AjvErrorLike[]>();
  for (const error of errors) {
    const path = error.instancePath ?? '';
    const group = byPath.get(path);
    if (group === undefined) {
      byPath.set(path, [error]);
    } else {
      group.push(error);
    }
  }
  // A parent fails because a child does; the child says why
  const ancestors = ancestorsOf(byPath.keys());
  const deepest = [...byPath.keys()].filter((path) => !ancestors.has(path));
  return deepest.map((path) => {
    const all = byPath.get(path) ?? [];
    const causes = all.filter((error) => !isNoise(error));
    const shown = causes.length === 0 ? all : causes;
    return {
      path: path === '' ? '/' : sanitizeSpecText(path, PATH_MAX),
      messages: [...new Set(shown.map((error) => messageOf(error)))],
    };
  });
};

export const formatValidationIssues = (issues: readonly ValidationIssue[]): string => {
  const lines = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `  ${issue.path}: ${issue.messages.join('; ')}`);
  const more =
    issues.length > MAX_ISSUES ? `\n  … and ${issues.length - MAX_ISSUES} more locations` : '';
  return `${lines.join('\n')}${more}`;
};

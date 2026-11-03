import { sanitizeSpecText } from './sanitize.ts';

// The locations where a spec fails OpenAPI schema validation, one entry
// each (issue #131). Ajv runs with allErrors, so it reports every failing
// location at once, plus noise: an object that fails also fails the
// `oneOf` of "this object or a $ref" and the `if` that picks its shape, at
// its own location and at every parent. A location keeps its own causes,
// such as a missing required property; one with only that noise is
// dropped when a deeper location says why.

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

// Errors that follow from another one: the "or a $ref" half of a
// Reference-or-Object `oneOf`, the `oneOf` itself, and an `if` whose `then`
// failed. An `anyOf` is not a cause either, but it stays next to its
// alternatives (3.1 needs one of `paths`, `components`, `webhooks`).
const isNoise = (error: AjvErrorLike): boolean =>
  error.keyword === 'oneOf' ||
  error.keyword === 'if' ||
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
  const ancestors = ancestorsOf(byPath.keys());
  const issues: ValidationIssue[] = [];
  for (const [path, all] of byPath) {
    const causes = all.filter((error) => !isNoise(error) && error.keyword !== 'anyOf');
    // Only noise here, and a deeper location says why: nothing of its own
    if (causes.length === 0 && ancestors.has(path)) {
      continue;
    }
    const shown = causes.length === 0 ? all : all.filter((error) => !isNoise(error));
    issues.push({
      path: path === '' ? '/' : sanitizeSpecText(path, PATH_MAX),
      messages: [...new Set(shown.map((error) => messageOf(error)))],
    });
  }
  return issues;
};

export const formatValidationIssues = (
  issues: readonly ValidationIssue[],
  capped = false,
): string => {
  const lines = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `  ${issue.path}: ${issue.messages.join('; ')}`);
  const hidden = issues.length - Math.min(issues.length, MAX_ISSUES);
  // A capped run stopped collecting, so how many more is not known
  if (capped) {
    return `${lines.join('\n')}\n  … and more locations`;
  }
  return hidden > 0
    ? `${lines.join('\n')}\n  … and ${String(hidden)} more locations`
    : lines.join('\n');
};

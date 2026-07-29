import { parseDocument } from 'yaml';
import { validationError } from '../errors.ts';
import type { OpenapiMcpError } from '../errors.ts';
import { SPEC_BUDGETS } from './budgets.ts';

const stripBom = (text: string): string => (text.startsWith('\uFEFF') ? text.slice(1) : text);

// Iterative depth check: never recurses, so it cannot itself overflow
const checkDepth = (root: unknown, maxDepth: number): void => {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (entry.depth > maxDepth) {
      // Wording covers both budget language ("depth") and the deep-nesting
      // language of the RangeError branch below ("deep") — on current V8,
      // JSON.parse no longer recurses (and cannot stack-overflow) even at
      // extreme nesting, so this iterative check is what actually fires
      throw validationError(`spec nesting is too deep: exceeds the maximum depth of ${maxDepth}`);
    }
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (entry.value !== null && typeof entry.value === 'object') {
      for (const value of Object.values(entry.value)) {
        stack.push({ value, depth: entry.depth + 1 });
      }
    }
  }
};

const combinedError = (jsonError: unknown, yamlProblem: unknown): OpenapiMcpError => {
  const yamlMessage = yamlProblem instanceof Error ? yamlProblem.message : String(yamlProblem);
  if (jsonError === undefined) {
    return validationError(`spec is not valid YAML: ${yamlMessage}`);
  }
  const jsonMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
  return validationError(
    `spec is neither valid JSON (${jsonMessage}) nor valid YAML (${yamlMessage})`,
  );
};

const parseAsYaml = (text: string, jsonError: unknown): unknown => {
  // Fail-closed YAML: parseDocument surfaces unresolved tags as warnings and
  // duplicate keys / multi-doc streams as errors; parse() would only warn
  const doc = parseDocument(text, { schema: 'core', version: '1.2', uniqueKeys: true });
  const firstProblem = doc.errors[0] ?? doc.warnings[0];
  if (firstProblem !== undefined) {
    throw combinedError(jsonError, firstProblem);
  }
  try {
    return doc.toJS({ maxAliasCount: SPEC_BUDGETS.maxYamlAliases });
  } catch (error) {
    if (error instanceof RangeError) {
      throw error;
    }
    if (error instanceof ReferenceError) {
      throw validationError(`spec exceeds the YAML alias budget of ${SPEC_BUDGETS.maxYamlAliases}`);
    }
    throw combinedError(jsonError, error);
  }
};

const parseJsonFirst = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    if (jsonError instanceof RangeError) {
      throw jsonError;
    }
    // Flow-style YAML also starts with "{" — try YAML before failing
    return parseAsYaml(text, jsonError);
  }
};

export const parseSpecText = (raw: string): Record<string, unknown> => {
  const text = stripBom(raw);
  const sniffed = text.trimStart();
  if (sniffed === '') {
    throw validationError('spec document is empty');
  }
  let parsed: unknown;
  try {
    parsed =
      sniffed.startsWith('{') || sniffed.startsWith('[')
        ? parseJsonFirst(text)
        : // oxlint-disable-next-line unicorn/no-useless-undefined -- parseAsYaml's jsonError is a required (non-optional) parameter; dropping the argument changes call arity and fails to type-check (TS2554)
          parseAsYaml(text, undefined);
  } catch (error) {
    if (error instanceof RangeError) {
      // V8 recursion limit hit before the depth budget below could run
      throw validationError('spec nesting is too deep to parse');
    }
    throw error;
  }
  checkDepth(parsed, SPEC_BUDGETS.maxParseDepth);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationError('spec root must be a JSON/YAML object');
  }
  return parsed as Record<string, unknown>;
};

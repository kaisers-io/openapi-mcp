import { SPEC_BUDGETS } from './budgets.ts';
import { sanitizeSpecText } from './sanitize.ts';
import type { OpenapiVersion } from './validate.ts';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// Spec §3.2: OPTIONS and TRACE operations are never exposed in v1
const NEVER_EXPOSED_METHODS = ['options', 'trace'] as const;

const TITLE_MAX_LENGTH = 256;

export interface OperationRecord {
  method: HttpMethod;
  path: string;
  operationId?: string;
  tags: readonly string[];
  summary?: string;
  description?: string;
  deprecated: boolean;
  parameters: readonly Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
}

export interface OmittedOperation {
  method: string;
  path: string;
  reason: string;
}

export interface NormalizedSpec {
  title: string;
  specVersion: string;
  openapiVersion: OpenapiVersion;
  operations: readonly OperationRecord[];
  omitted: readonly OmittedOperation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const mergeParameters = (
  pathLevel: readonly unknown[],
  opLevel: readonly unknown[],
): { parameters: Record<string, unknown>[]; unresolvable: boolean } => {
  const merged = new Map<string, Record<string, unknown>>();
  for (const source of [pathLevel, opLevel]) {
    for (const param of source) {
      if (
        !isRecord(param) ||
        typeof param['name'] !== 'string' ||
        typeof param['in'] !== 'string'
      ) {
        // Covers cyclic { $ref } markers and malformed parameter shapes
        return { parameters: [], unresolvable: true };
      }
      merged.set(`${param['in']} ${param['name']}`, param);
    }
  }
  return { parameters: [...merged.values()], unresolvable: false };
};

const buildOperation = (
  method: HttpMethod,
  path: string,
  op: Record<string, unknown>,
  pathParameters: readonly unknown[],
): OperationRecord | OmittedOperation => {
  const upper = method.toUpperCase();
  if (op['servers'] !== undefined) {
    return { method: upper, path, reason: 'per-operation servers overrides are not supported' };
  }
  if (isRecord(op['callbacks']) && Object.keys(op['callbacks']).length > 0) {
    return { method: upper, path, reason: 'callbacks are not supported' };
  }
  const opParameters = Array.isArray(op['parameters']) ? op['parameters'] : [];
  const { parameters, unresolvable } = mergeParameters(pathParameters, opParameters);
  if (unresolvable) {
    return {
      method: upper,
      path,
      reason: 'a parameter could not be resolved (unsupported shape or cyclic $ref)',
    };
  }
  if (parameters.some((param) => param['in'] === 'cookie')) {
    return { method: upper, path, reason: 'cookie parameters are not supported' };
  }
  const tags = Array.isArray(op['tags'])
    ? op['tags'].filter((tag): tag is string => typeof tag === 'string')
    : [];
  const summary =
    typeof op['summary'] === 'string'
      ? sanitizeSpecText(op['summary'], SPEC_BUDGETS.maxTextLength)
      : undefined;
  const description =
    typeof op['description'] === 'string'
      ? sanitizeSpecText(op['description'], SPEC_BUDGETS.maxTextLength)
      : undefined;
  return {
    method,
    path,
    ...(typeof op['operationId'] === 'string' && op['operationId'] !== ''
      ? { operationId: op['operationId'] }
      : {}),
    tags,
    ...(summary !== undefined && summary !== '' ? { summary } : {}),
    ...(description !== undefined && description !== '' ? { description } : {}),
    deprecated: op['deprecated'] === true,
    parameters,
    ...(isRecord(op['requestBody']) ? { requestBody: op['requestBody'] } : {}),
    responses: isRecord(op['responses']) ? op['responses'] : {},
  };
};

export const normalizeSpec = (
  document: Record<string, unknown>,
  version: OpenapiVersion,
): NormalizedSpec => {
  const info = isRecord(document['info']) ? document['info'] : {};
  const title =
    typeof info['title'] === 'string'
      ? sanitizeSpecText(info['title'], TITLE_MAX_LENGTH)
      : 'untitled';
  const specVersion =
    typeof info['version'] === 'string'
      ? sanitizeSpecText(info['version'], TITLE_MAX_LENGTH)
      : '0.0.0';
  const operations: OperationRecord[] = [];
  const omitted: OmittedOperation[] = [];
  const paths = isRecord(document['paths']) ? document['paths'] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/') || !isRecord(item)) {
      // Path-object extension keys (x-*) are not paths
      continue;
    }
    const pathParameters = Array.isArray(item['parameters']) ? item['parameters'] : [];
    const pathHasServers = item['servers'] !== undefined;
    for (const method of NEVER_EXPOSED_METHODS) {
      if (item[method] !== undefined) {
        omitted.push({
          method: method.toUpperCase(),
          path,
          reason: `${method.toUpperCase()} operations are never exposed in v1`,
        });
      }
    }
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op === undefined) {
        continue;
      }
      if (!isRecord(op)) {
        omitted.push({ method: method.toUpperCase(), path, reason: 'operation is not an object' });
        continue;
      }
      if (pathHasServers) {
        omitted.push({
          method: method.toUpperCase(),
          path,
          reason: 'path-level servers overrides are not supported',
        });
        continue;
      }
      const built = buildOperation(method, path, op, pathParameters);
      if ('reason' in built) {
        omitted.push(built);
      } else {
        operations.push(built);
      }
    }
  }
  const webhooks = isRecord(document['webhooks']) ? document['webhooks'] : {};
  for (const name of Object.keys(webhooks)) {
    omitted.push({ method: '*', path: `webhook:${name}`, reason: 'webhooks are not supported' });
  }
  return { title, specVersion, openapiVersion: version, operations, omitted };
};

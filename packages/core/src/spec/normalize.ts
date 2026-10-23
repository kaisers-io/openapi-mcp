import { SPEC_BUDGETS } from './budgets.ts';
import { mergeParameters } from './merge-parameters.ts';
import type { Resolve } from './merge-parameters.ts';
import { isRecord, resolveShallowOrSelf } from './refs.ts';
import { sanitizeSpecText } from './sanitize.ts';
import { extractSecuritySchemes, parseSecurityRequirements } from './security.ts';
import type { SecurityRequirement, SecurityScheme } from './security.ts';
import { extractServerUrl } from './server-url.ts';
import type { OpenapiVersion } from './validate.ts';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// OPTIONS and TRACE operations are never exposed
const NEVER_EXPOSED_METHODS = ['options', 'trace'] as const;

const TITLE_MAX_LENGTH = 256;

export type OperationRecord = {
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
  // The operation's own `security` (overrides the root one); absent when
  // not declared or malformed. Read for operator hints only.
  security?: readonly SecurityRequirement[];
};

export type OmittedOperation = {
  method: string;
  path: string;
  reason: string;
};

export type NormalizedSpec = {
  title: string;
  specVersion: string;
  openapiVersion: OpenapiVersion;
  operations: readonly OperationRecord[];
  omitted: readonly OmittedOperation[];
  // The resolved-or-absolute base-URL candidate from root `document.servers[0]`
  // (variable-default expanded). Undefined when unresolvable — fail-closed.
  serverUrl?: string;
  // Set (with `serverUrl` undefined) when servers[0].url would expand past
  // SPEC_BUDGETS.maxServerUrlBytes. Unlike a plain undefined, the consumer
  // must NOT fall back to the document origin: it requires --base-url.
  // `expandedBytes` feeds the warning (serverUrlRejectedWarning).
  serverUrlRejected?: { expandedBytes: number };
  // True when `serverUrl` is a relative reference (no scheme) that still
  // needs a document base to resolve into an absolute URL.
  serverUrlIsRelative?: boolean;
  // `components.securitySchemes` and the root `security` (see security.ts);
  // absent when the spec declares none.
  securitySchemes?: readonly SecurityScheme[];
  security?: readonly SecurityRequirement[];
};

// Normalization reads the document BEFORE it is dereferenced (issue
// kaisers-io/openapi-mcp-archive#89): a path item or parameter `{ $ref }` is
// followed only as far as needed to read it (the Resolve callback); contents
// stay raw until the pipeline dereferences exposed operations.

const buildOperation = (
  method: HttpMethod,
  path: string,
  op: Record<string, unknown>,
  pathParameters: readonly unknown[],
  resolve: Resolve,
): OperationRecord | OmittedOperation => {
  const upper = method.toUpperCase();
  if (op['servers'] !== undefined) {
    return { method: upper, path, reason: 'per-operation servers overrides are not supported' };
  }
  if (isRecord(op['callbacks']) && Object.keys(op['callbacks']).length > 0) {
    return { method: upper, path, reason: 'callbacks are not supported' };
  }
  const opParameters = Array.isArray(op['parameters']) ? op['parameters'] : [];
  const { parameters, unresolvable, cookie } = mergeParameters(
    pathParameters,
    opParameters,
    resolve,
  );
  if (unresolvable) {
    return {
      method: upper,
      path,
      reason: 'a parameter could not be resolved (unsupported shape or cyclic $ref)',
    };
  }
  if (cookie) {
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
  const security = parseSecurityRequirements(op['security']);
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
    ...(security === undefined ? {} : { security }),
  };
};

// Per-path slice of what normalizeSpec's old nested loop did in one iteration
// of its outer `for (const [path, item] of ...)`: everything this returns for
// a single path, in the SAME internal order (never-exposed omissions first,
// then one entry per HTTP_METHODS method, in HTTP_METHODS order) as the
// original push sequence for that path.
const buildPathEntries = (
  path: string,
  item: unknown,
  resolve: Resolve,
): { operations: OperationRecord[]; omitted: OmittedOperation[] } => {
  if (!path.startsWith('/') || !isRecord(item)) {
    // Path-object extension keys (x-*) are not paths
    return { operations: [], omitted: [] };
  }
  const pathParameters = Array.isArray(item['parameters']) ? item['parameters'] : [];
  const pathHasServers = item['servers'] !== undefined;
  const neverExposed: OmittedOperation[] = NEVER_EXPOSED_METHODS.filter(
    (method) => item[method] !== undefined,
  ).map((method) => ({
    method: method.toUpperCase(),
    path,
    reason: `${method.toUpperCase()} operations are never exposed`,
  }));
  const perMethod = HTTP_METHODS.flatMap((method): (OperationRecord | OmittedOperation)[] => {
    const op = item[method];
    if (op === undefined) {
      return [];
    }
    if (!isRecord(op)) {
      return [{ method: method.toUpperCase(), path, reason: 'operation is not an object' }];
    }
    if (pathHasServers) {
      return [
        {
          method: method.toUpperCase(),
          path,
          reason: 'path-level servers overrides are not supported',
        },
      ];
    }
    return [buildOperation(method, path, op, pathParameters, resolve)];
  });
  return {
    operations: perMethod.filter((entry): entry is OperationRecord => !('reason' in entry)),
    omitted: [
      ...neverExposed,
      ...perMethod.filter((entry): entry is OmittedOperation => 'reason' in entry),
    ],
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
  const paths = isRecord(document['paths']) ? document['paths'] : {};
  // One buildPathEntries call per path, in Object.entries order — matches the
  // original outer for-of's iteration order exactly.
  const resolve: Resolve = (node) => resolveShallowOrSelf(document, node);
  const perPath = Object.entries(paths).map(([path, item]) =>
    buildPathEntries(path, resolve(item), resolve),
  );
  const operations = perPath.flatMap((entry) => entry.operations);
  const webhooks = isRecord(document['webhooks']) ? document['webhooks'] : {};
  const omitted = [
    ...perPath.flatMap((entry) => entry.omitted),
    // Webhook omissions are appended last, exactly as the original trailing
    // for-of loop did after the path loop completed.
    ...Object.keys(webhooks).map((name): OmittedOperation => ({
      method: '*',
      path: `webhook:${name}`,
      reason: 'webhooks are not supported',
    })),
  ];
  const securitySchemes = extractSecuritySchemes(document);
  const security = parseSecurityRequirements(document['security']);
  return {
    title,
    specVersion,
    openapiVersion: version,
    operations,
    omitted,
    ...extractServerUrl(document),
    ...(securitySchemes.length === 0 ? {} : { securitySchemes }),
    ...(security === undefined ? {} : { security }),
  };
};

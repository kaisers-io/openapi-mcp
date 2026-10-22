import { z } from 'zod';
import type { OmittedOperation, OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { deriveAnnotations } from './annotations.ts';
import type { ToolAnnotations } from './annotations.ts';
import { composeDescription } from './description.ts';
import { buildLayout } from './layout.ts';
import type { RequestMapper } from './layout.ts';
import type { NamedOperation } from './naming.ts';
import { deriveOutputSchema } from './output-schema.ts';
import type { JsonSchemaRecord } from './output-schema.ts';
import { detectPagination } from './pagination.ts';
import type { PaginationPlan } from './pagination.ts';

export type WireSchema = ReturnType<typeof z.toJSONSchema<z.ZodType>>;

export type GeneratedTool = {
  toolName: string;
  operation: OperationRecord;
  inputSchema: z.ZodType;
  wireSchema: WireSchema;
  mapper: RequestMapper;
  description: string;
  annotations: ToolAnnotations;
  outputSchema?: JsonSchemaRecord;
  // Present only for a paginated GET (see toolgen/pagination.ts).
  pagination?: PaginationPlan;
  // True when the tool takes the optional `_fields` projection argument
  // (toolgen/projection.ts).
  projection?: boolean;
};

export type BuildToolsResult = {
  tools: readonly GeneratedTool[];
  omitted: readonly OmittedOperation[];
};

// Request headers the tool boundary never exposes as inputs: the auth header
// is injected from env at request time; hop/entity headers are managed by the
// HTTP client; Cookie/Set-Cookie carry credentials. Lowercased for
// case-insensitive matching. Callers union additional operator-configured
// auth-header names into the reservedHeaders set passed to buildTools.
// `accept` is derived from the operation's declared response media types
// (an operator may still override it with --header); OpenAPI itself says a
// header parameter named Accept, Content-Type or Authorization "SHALL be
// ignored" (OAS 3.1 Parameter Object, `name`).
export const SYSTEM_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  // W3C trace context: forwarded from the MCP request's `_meta` only.
  'traceparent',
  'tracestate',
  'upgrade',
  'expect',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Projection applies to JSON bodies only: a tool gets `_fields` when any of
// its success responses declares a JSON media type.
const declaresJsonSuccess = (operation: OperationRecord): boolean =>
  Object.entries(operation.responses).some(
    ([status, response]) =>
      /^2(?:\d\d|xx)$/iu.test(status) &&
      isRecord(response) &&
      isRecord(response['content']) &&
      Object.keys(response['content']).some((type) =>
        /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/iu.test(type.trim()),
      ),
  );

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Isolates the one throwing step (z.toJSONSchema) behind a pure result type so
// the caller never needs a `let` to survive the try/catch.
const toWireSchema = (inputSchema: z.ZodType): { ok: WireSchema } | { error: string } => {
  try {
    return { ok: z.toJSONSchema(inputSchema) };
  } catch (error) {
    // Defensive: our schemas are representable (proven), but fail closed if a
    // future construct is not — omit rather than emit a nonconforming schema.
    return { error: describeCause(error) };
  }
};

// One operation in, one outcome out: either the generated tool or its omission
// reason. `buildTools` below maps every named operation through this and then
// splits the results — the per-operation gate order (layout, then wire-schema
// representability) is unchanged, just no longer entangled with array mutation.
const buildToolEntry = (
  named: NamedOperation,
  reservedHeaders: ReadonlySet<string>,
  openapiVersion: OpenapiVersion,
): GeneratedTool | OmittedOperation => {
  const method = named.operation.method.toUpperCase();
  const layout = buildLayout(
    named.operation,
    reservedHeaders,
    openapiVersion,
    declaresJsonSuccess(named.operation),
  );
  if (!('ok' in layout)) {
    return { method, path: named.operation.path, reason: layout.unrepresentable };
  }
  const wireResult = toWireSchema(layout.ok.inputSchema);
  if ('error' in wireResult) {
    return {
      method,
      path: named.operation.path,
      reason: `input schema cannot be represented as JSON Schema: ${wireResult.error}`,
    };
  }
  const description = composeDescription(named.operation);
  const annotations = deriveAnnotations(named.operation.method);
  const pagination = detectPagination(
    named.operation,
    layout.ok.mapper,
    wireResult.ok as Record<string, unknown>,
  );
  const outputSchema = deriveOutputSchema(named.operation, openapiVersion, {
    pagination: pagination !== undefined,
    projection: layout.ok.projection,
  });
  return {
    toolName: named.toolName,
    operation: named.operation,
    inputSchema: layout.ok.inputSchema,
    wireSchema: wireResult.ok,
    mapper: layout.ok.mapper,
    description,
    annotations,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(pagination === undefined ? {} : { pagination }),
    ...(layout.ok.projection ? { projection: true } : {}),
  };
};

export const buildTools = (
  namedOperations: readonly NamedOperation[],
  // `openapiVersion` is required (no default): the caller threads the spec's
  // version so a 3.0 `nullable: true` is honoured only under 3.0. buildLayout and
  // its convertSchema descendants receive it explicitly.
  opts: { reservedHeaders: ReadonlySet<string>; openapiVersion: OpenapiVersion },
): BuildToolsResult => {
  // HTTP header names are case-insensitive, and the header drop in paramFields
  // looks up `reservedHeaders.has(name.toLowerCase())`. The caller's set contents
  // are NOT guaranteed lowercase — a caller unions operator-configured
  // auth-header names (which may be mixed-case) into this set (see
  // SYSTEM_HEADERS above). A mixed-case entry like 'X-API-Key' would otherwise
  // fail to match and the auth header would be exposed as a tool input.
  // Normalize once here (fail-closed).
  const reservedHeaders = new Set([...opts.reservedHeaders].map((name) => name.toLowerCase()));
  // One buildToolEntry call per operation, in namedOperations order — matches
  // the original for-of's iteration (and thus toolName/omission) order exactly.
  const entries = namedOperations.map((named) =>
    buildToolEntry(named, reservedHeaders, opts.openapiVersion),
  );
  return {
    tools: entries.filter((entry): entry is GeneratedTool => !('reason' in entry)),
    omitted: entries.filter((entry): entry is OmittedOperation => 'reason' in entry),
  };
};

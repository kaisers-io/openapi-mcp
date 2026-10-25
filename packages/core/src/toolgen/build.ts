import { z } from 'zod';
import type { OmittedOperation, OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { deriveAnnotations } from './annotations.ts';
import type { ToolAnnotations } from './annotations.ts';
import { completeTool } from './complete.ts';
import { buildLayout } from './layout.ts';
import type { RequestMapper } from './layout.ts';
import type { NamedOperation } from './naming.ts';
import type { JsonSchemaRecord, NullableFieldScope } from './output-schema.ts';
import { detectPagination } from './pagination.ts';
import type { PaginationPlan } from './pagination.ts';
import { withConvertMemo } from './schema.ts';

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
  // Set when the outputSchema exists ONLY because the operator opted into
  // `defaultResponseIsError` (the operation documents a `default` response).
  // Surfaced by `tools`, and used at runtime to name the flag when an
  // undocumented 2xx arrives.
  outputSchemaAssumesDefaultIsError?: true;
  // Set when `nullableResponseFields` (issue #3) widened this tool's
  // outputSchema, i.e. some response property now also admits null.
  // Surfaced by `tools`.
  outputSchemaAdmitsNullFields?: true;
  // Set when the operator opted this tool out of its output schema
  // (--omit-output-schema, issue #13; see applyOutputSchemaOptOut): one was
  // derived but is not declared, so results are returned as text. Surfaced
  // by `tools`.
  outputSchemaOptedOut?: true;
  // Why the tool has no outputSchema, when the agent should know
  // (kaisers-io/openapi-mcp-archive#39: a response `pattern` with nested
  // quantifiers). Also folded into the description.
  outputSchemaWithheld?: string;
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

// The fields that come from the operation's responses: built together, on
// demand under `--tool-mode discover` (issue #47)
export type OutputSide =
  | 'description'
  | 'outputSchema'
  | 'outputSchemaAssumesDefaultIsError'
  | 'outputSchemaAdmitsNullFields'
  | 'outputSchemaOptedOut'
  | 'outputSchemaWithheld';

// A tool without its output side. Which operations become tools, their
// input schemas and their omission reasons are all decided here; only the
// output side waits for `complete`, which builds it once and returns the
// whole tool on every call.
export type DeferredTool = Omit<GeneratedTool, OutputSide> & {
  // `seen` is shared by the completions of one build, so an output schema
  // node several tools share is frozen in one walk
  complete: (seen?: WeakSet<object>) => GeneratedTool;
};

export type DeferredToolsResult = {
  tools: readonly DeferredTool[];
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

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Isolates the one throwing step (z.toJSONSchema) behind a pure result type so
// the caller never needs a `let` to survive the try/catch.
const toWireSchema = (inputSchema: z.ZodType): { ok: WireSchema } | { error: string } => {
  try {
    // A shallow copy: zod adds a hidden `~standard` property to the result
    // that keeps the zod schema alive for as long as the JSON Schema (#47)
    return { ok: { ...z.toJSONSchema(inputSchema) } };
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
  defaultResponseIsError: boolean,
  nullableResponseFields: NullableFieldScope | undefined,
  projection: boolean,
  uploadDir: string | undefined,
): DeferredTool | OmittedOperation => {
  const method = named.operation.method.toUpperCase();
  // Provenance for filter diagnostics (issue #41)
  const omitted = (reason: string): OmittedOperation => ({
    method,
    path: named.operation.path,
    reason,
    ...(named.operation.operationId === undefined
      ? {}
      : { operationId: named.operation.operationId }),
    ...(named.operation.tags.length === 0 ? {} : { tags: named.operation.tags }),
    toolName: named.toolName,
  });
  const layout = buildLayout(
    named.operation,
    reservedHeaders,
    openapiVersion,
    projection,
    uploadDir,
  );
  if (!('ok' in layout)) {
    return omitted(layout.unrepresentable);
  }
  const wireResult = toWireSchema(layout.ok.inputSchema);
  if ('error' in wireResult) {
    return omitted(`input schema cannot be represented as JSON Schema: ${wireResult.error}`);
  }
  const pagination = detectPagination(named.operation, layout.ok.mapper, wireResult.ok);
  const core = {
    toolName: named.toolName,
    operation: named.operation,
    inputSchema: layout.ok.inputSchema,
    wireSchema: wireResult.ok,
    mapper: layout.ok.mapper,
    annotations: deriveAnnotations(named.operation.method),
    ...(pagination === undefined ? {} : { pagination }),
    ...(layout.ok.projection ? { projection: true } : {}),
  };
  let completed: GeneratedTool | undefined;
  return {
    ...core,
    complete: (seen) => {
      completed ??= completeTool(
        core,
        { openapiVersion, defaultResponseIsError, nullableResponseFields },
        seen,
      );
      return completed;
    },
  };
};

export const buildToolsDeferred = (
  namedOperations: readonly NamedOperation[],
  // `openapiVersion` is required (no default): the caller threads the spec's
  // version so a 3.0 `nullable: true` is honoured only under 3.0. buildLayout and
  // its convertSchema descendants receive it explicitly.
  // `defaultResponseIsError`: see OutputSchemaOptions (opt-in, default off).
  opts: {
    reservedHeaders: ReadonlySet<string>;
    openapiVersion: OpenapiVersion;
    defaultResponseIsError?: boolean;
    // Admit null for object properties in derived output schemas (serve/tools
    // --nullable-response-fields, issues #3 and #17): every property
    // (`all`) or those not listed in `required` (`optional`). Off by
    // default: without it the output schemas are exactly the strict ones.
    nullableResponseFields?: NullableFieldScope;
    // Offer the optional `_fields` argument on JSON tools (serve
    // --response-projection). Off by default: it grows tools/list by about
    // a third, paid in every session.
    projection?: boolean;
    // --uploads (#29): binary fields also take a file name in this folder
    uploadDir?: string;
  },
): DeferredToolsResult => {
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
  // One memo scope per build: shared schema nodes convert once (issue
  // kaisers-io/openapi-mcp-archive#90)
  const entries = withConvertMemo(() =>
    namedOperations.map((named) =>
      buildToolEntry(
        named,
        reservedHeaders,
        opts.openapiVersion,
        opts.defaultResponseIsError === true,
        opts.nullableResponseFields,
        opts.projection === true,
        opts.uploadDir,
      ),
    ),
  );
  return {
    tools: entries.filter((entry): entry is DeferredTool => !('reason' in entry)),
    omitted: entries.filter((entry): entry is OmittedOperation => 'reason' in entry),
  };
};

// Every tool with its output side, in one memo scope so shared response
// schemas convert once
export const completeTools = (built: DeferredToolsResult): BuildToolsResult => ({
  tools: withConvertMemo(() => {
    const seen = new WeakSet<object>();
    return built.tools.map((tool) => tool.complete(seen));
  }),
  omitted: built.omitted,
});

export const buildTools = (
  namedOperations: readonly NamedOperation[],
  opts: Parameters<typeof buildToolsDeferred>[1],
): BuildToolsResult => completeTools(buildToolsDeferred(namedOperations, opts));

import { z } from 'zod';
import type { OmittedOperation, OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { deriveAnnotations, type ToolAnnotations } from './annotations.ts';
import { composeDescription } from './description.ts';
import { buildLayout, type RequestMapper } from './layout.ts';
import type { NamedOperation } from './naming.ts';
import { deriveOutputSchema, type JsonSchemaRecord } from './output-schema.ts';

export type WireSchema = ReturnType<typeof z.toJSONSchema<z.ZodType>>;

export interface GeneratedTool {
  toolName: string;
  operation: OperationRecord;
  inputSchema: z.ZodType;
  wireSchema: WireSchema;
  mapper: RequestMapper;
  description: string;
  annotations: ToolAnnotations;
  outputSchema?: JsonSchemaRecord;
}

export interface BuildToolsResult {
  tools: readonly GeneratedTool[];
  omitted: readonly OmittedOperation[];
}

// Request headers the tool boundary never exposes as inputs: the auth header
// is injected from env at request time; hop/entity headers are managed by the
// HTTP client; Cookie/Set-Cookie carry credentials. Lowercased for
// case-insensitive matching. Callers union additional operator-configured
// auth-header names into the reservedHeaders set passed to buildTools.
export const SYSTEM_HEADERS: ReadonlySet<string> = new Set([
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
  'upgrade',
  'expect',
]);

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const buildTools = (
  namedOperations: readonly NamedOperation[],
  // `openapiVersion` is required (no default): the caller threads the spec's
  // version so a 3.0 `nullable: true` is honoured only under 3.0. buildLayout and
  // its convertSchema descendants receive it explicitly.
  opts: { reservedHeaders: ReadonlySet<string>; openapiVersion: OpenapiVersion },
): BuildToolsResult => {
  const tools: GeneratedTool[] = [];
  const omitted: OmittedOperation[] = [];
  // HTTP header names are case-insensitive, and the header drop in paramFields
  // looks up `reservedHeaders.has(name.toLowerCase())`. The caller's set contents
  // are NOT guaranteed lowercase — a caller unions operator-configured
  // auth-header names (which may be mixed-case) into this set (see
  // SYSTEM_HEADERS above). A mixed-case entry like 'X-API-Key' would otherwise
  // fail to match and the auth header would be exposed as a tool input.
  // Normalize once here (fail-closed).
  const reservedHeaders = new Set([...opts.reservedHeaders].map((name) => name.toLowerCase()));
  for (const named of namedOperations) {
    const method = named.operation.method.toUpperCase();
    const layout = buildLayout(named.operation, reservedHeaders, opts.openapiVersion);
    if (!('ok' in layout)) {
      omitted.push({ method, path: named.operation.path, reason: layout.unrepresentable });
      continue;
    }
    let wireSchema: WireSchema;
    try {
      wireSchema = z.toJSONSchema(layout.ok.inputSchema);
    } catch (err) {
      // Defensive: our schemas are representable (proven), but fail closed if a
      // future construct is not — omit rather than emit a nonconforming schema.
      omitted.push({
        method,
        path: named.operation.path,
        reason: `input schema cannot be represented as JSON Schema: ${describeCause(err)}`,
      });
      continue;
    }
    const description = composeDescription(named.operation);
    const annotations = deriveAnnotations(named.operation.method);
    const outputSchema = deriveOutputSchema(named.operation, opts.openapiVersion);
    tools.push({
      toolName: named.toolName,
      operation: named.operation,
      inputSchema: layout.ok.inputSchema,
      wireSchema,
      mapper: layout.ok.mapper,
      description,
      annotations,
      ...(outputSchema === undefined ? {} : { outputSchema }),
    });
  }
  return { tools, omitted };
};

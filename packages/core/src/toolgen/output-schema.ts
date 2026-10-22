import { z } from 'zod';
import type { OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { convertSchema, UNSAFE_PATTERN_REASON } from './schema.ts';

export type JsonSchemaRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// V1 scope: only application/json (or an application/*+json variant, e.g.
// application/problem+json) success responses are represented. Fail-closed:
// the WHOLE outputSchema (not a partial envelope) is omitted whenever ANY
// reachable success cannot be PROVABLY bounded by concrete, JSON-only
// branches below —
//   - a wildcard/range status key (a literal "2XX") or a "default" response
//     is documented at all: either MAY cover an undocumented success status
//     this function has no way to enumerate, so the envelope could describe
//     less than the tool can actually return;
//   - a 2xx response has no `content` at all (e.g. 204): nothing to encode;
//   - a 2xx response's content map has ANY non-JSON sibling media type
//     (e.g. both application/json AND text/plain): content negotiation could
//     return the unmodelled one, which the envelope would then misrepresent;
//   - a 2xx response's content map has MORE THAN ONE JSON media type (e.g.
//     both application/json AND application/problem+json): both pass the
//     "is this JSON" test, but content negotiation could return EITHER, and
//     they may carry different schemas — modeling only the first would
//     misrepresent the second;
//   - a 2xx response's JSON schema is unrepresentable via convertSchema.
// A partial envelope that silently drops one of these cases would let
// `structuredContent` violate the tool's own advertised outputSchema at
// runtime — omitting entirely is the only sound fallback.
const isJsonContentType = (contentType: string): boolean =>
  /^application\/(?:[\w.+-]+\+)?json$/u.test(contentType);

const SUCCESS_STATUS_RE = /^2\d\d$/u;
// A literal OpenAPI 3.1 status-code RANGE key ("2XX"/"2xx"), or the "default"
// response — either is treated as "might cover a success we cannot bound".
const WILDCARD_OR_DEFAULT_SUCCESS_RE = /^2xx$/iu;
const hasUnboundedSuccess = (responses: Record<string, unknown>): boolean =>
  Object.keys(responses).some(
    (key) => key === 'default' || WILDCARD_OR_DEFAULT_SUCCESS_RE.test(key),
  );

// Isolates the one throwing step (z.toJSONSchema) behind an Option-shaped
// result so the caller never needs a `let` to survive the try/catch.
const toDataSchema = (schema: z.ZodType): JsonSchemaRecord | undefined => {
  try {
    return z.toJSONSchema(schema) as JsonSchemaRecord;
  } catch {
    // Defensive: our schemas are representable (proven upstream); fail
    // closed rather than emit a nonconforming outputSchema.
    return undefined;
  }
};

// Why an operation has no output schema, when that is worth telling the
// agent. Only the #39 regex policy is reported: the other omissions (no JSON
// success, a `default` response, ...) are ordinary and need no explanation.
export const OUTPUT_SCHEMA_WITHHELD_UNSAFE_PATTERN =
  'No output schema: a response regex "pattern" has nested quantifiers (unbounded matching cost), so results are returned as text only.';

export type OutputSchemaDerivation = {
  outputSchema?: JsonSchemaRecord;
  // Agent-facing sentence explaining a withheld output schema (see above).
  withheld?: string;
};

export const explainOutputSchema = (
  operation: OperationRecord,
  version: OpenapiVersion,
): OutputSchemaDerivation => {
  if (hasUnboundedSuccess(operation.responses)) {
    return {};
  }
  const successKeys = Object.keys(operation.responses).filter((key) => SUCCESS_STATUS_RE.test(key));
  if (successKeys.length === 0) {
    return {};
  }
  const branches: JsonSchemaRecord[] = [];
  // Imperative on purpose: ANY single malformed/unbounded response branch
  // aborts the WHOLE envelope (fail-closed, see the comment above) before
  // later keys are even converted. `successKeys` is attacker-influenced (a
  // hostile spec can declare arbitrarily many 2xx statuses, each with a deep
  // schema) — mapping every key through convertSchema/z.toJSONSchema first
  // and checking afterward would turn this short-circuit into forced O(n)
  // conversion work on hostile input for no behavioural gain.
  for (const key of successKeys) {
    const response = operation.responses[key];
    if (!isRecord(response)) {
      return {};
    }
    const content = isRecord(response['content']) ? response['content'] : undefined;
    if (content === undefined) {
      // No content at all (e.g. 204) — nothing to encode for this branch.
      return {};
    }
    const contentKeys = Object.keys(content);
    const jsonKeys = contentKeys.filter((type) => isJsonContentType(type));
    // Exactly one JSON media type, and no OTHER (non-JSON) sibling — a 200
    // documenting both application/json and text/plain cannot be uniformly
    // represented, since either could actually be returned. The
    // `jsonKeys.length !== 1` check is what enforces "exactly one": without
    // it, a 200 documenting BOTH application/json AND
    // application/problem+json would pass the `jsonKeys.length ===
    // contentKeys.length` check below (both are JSON, so nothing was
    // filtered out) and silently model only `jsonKeys[0]`, even though the
    // other JSON media type could be the one actually returned.
    const [contentType] = jsonKeys;
    if (
      contentType === undefined ||
      jsonKeys.length !== 1 ||
      jsonKeys.length !== contentKeys.length
    ) {
      return {};
    }
    const entry = content[contentType];
    if (!isRecord(entry)) {
      return {};
    }
    // Response mode: undeclared fields stay allowed unless the spec says
    // `additionalProperties: false`, and writeOnly properties are optional —
    // see SchemaMode in schema.ts.
    const converted = convertSchema(entry['schema'] ?? {}, version, 0, 'response');
    if (!('ok' in converted)) {
      return converted.unrepresentable.includes(UNSAFE_PATTERN_REASON)
        ? { withheld: OUTPUT_SCHEMA_WITHHELD_UNSAFE_PATTERN }
        : {};
    }
    const dataSchema = toDataSchema(converted.ok);
    if (dataSchema === undefined) {
      return {};
    }
    branches.push({
      type: 'object',
      properties: {
        status: { const: Number(key) },
        contentType: { const: contentType },
        data: dataSchema,
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    });
  }
  return { outputSchema: { type: 'object', oneOf: branches } };
};

export const deriveOutputSchema = (
  operation: OperationRecord,
  version: OpenapiVersion,
): JsonSchemaRecord | undefined => explainOutputSchema(operation, version).outputSchema;

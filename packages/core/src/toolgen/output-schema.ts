import { z } from 'zod';
import type { OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { PAGINATION_SCHEMA } from './pagination.ts';
import { convertSchema } from './schema.ts';

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
// The ONE JSON media-type test of the response side: output-schema
// derivation, response mapping (server/execute/response.ts) and tool
// selection for `_fields` (build.ts) all use it, so they cannot disagree.
// `application/json` or any `+json` structured-syntax suffix (RFC 6839).
const JSON_ESSENCE_RE = /^application\/(?:[\w.+-]+\+)?json$/u;
export const isJsonContentType = (contentType: string): boolean =>
  JSON_ESSENCE_RE.test(contentType);

// The lowercased `type/subtype` of a media type, parameters dropped.
export const mediaEssence = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase();

const SUCCESS_STATUS_RE = /^2\d\d$/u;

// Deliberately minimal: it is repeated in every success branch of every
// tool, and tools/list size is paid in every session. Declaring it once per
// tool (top-level property + `true` per branch) costs MORE for the common
// single-branch tool; typing the values (always strings, produced by this
// server) adds bytes without helping the caller.
const RESPONSE_HEADERS_SCHEMA: JsonSchemaRecord = { type: 'object' };
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

// Minimal on purpose: the projected values come from `data` that already
// passed the strict branch, so this branch only has to tell the two shapes
// apart (`projection` required here, `data` required and extra keys refused
// there) — exactly one branch matches either shape.
const PROJECTION_BRANCH: JsonSchemaRecord = {
  type: 'object',
  properties: { projection: { type: 'object' } },
  required: ['status', 'contentType', 'projection'],
};

export const deriveOutputSchema = (
  operation: OperationRecord,
  version: OpenapiVersion,
  // A paginated tool's envelope also declares the `pagination` hint; a
  // projectable tool also gets ONE `projection` branch.
  options: { pagination?: boolean; projection?: boolean } = {},
): JsonSchemaRecord | undefined => {
  if (hasUnboundedSuccess(operation.responses)) {
    return undefined;
  }
  const successKeys = Object.keys(operation.responses).filter((key) => SUCCESS_STATUS_RE.test(key));
  if (successKeys.length === 0) {
    return undefined;
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
      return undefined;
    }
    const content = isRecord(response['content']) ? response['content'] : undefined;
    if (content === undefined) {
      // No content at all (e.g. 204) — nothing to encode for this branch.
      return undefined;
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
      return undefined;
    }
    const entry = content[contentType];
    if (!isRecord(entry)) {
      return undefined;
    }
    const converted = convertSchema(entry['schema'] ?? {}, version);
    if (!('ok' in converted)) {
      return undefined;
    }
    const dataSchema = toDataSchema(converted.ok);
    if (dataSchema === undefined) {
      return undefined;
    }
    branches.push({
      type: 'object',
      properties: {
        status: { const: Number(key) },
        contentType: { const: contentType },
        data: dataSchema,
        // Allowlisted upstream response headers (pagination, rate limits,
        // validators), present only when the upstream sent any — see
        // server/execute/forwarded-headers.ts. Optional, so a result
        // without them still conforms.
        headers: RESPONSE_HEADERS_SCHEMA,
        ...(options.pagination === true ? { pagination: PAGINATION_SCHEMA } : {}),
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    });
  }
  // A projected result (`_fields`) carries `projection` INSTEAD of `data`:
  // subtrees of data already validated against the strict branch above, so
  // their values are unconstrained here. `data` is required on the strict
  // branches and absent here, so exactly one branch matches either shape.
  // ONE branch for every success status/content type: it only has to
  // validate, not discriminate, and tools/list size is paid in every session.
  return {
    type: 'object',
    oneOf: options.projection === true ? [...branches, PROJECTION_BRANCH] : branches,
  };
};

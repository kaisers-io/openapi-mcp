import type { OperationRecord } from '../spec/normalize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { factorRepeatedSubschemas } from './compact-schema.ts';
import { admitNullProperties } from './nullable-fields.ts';
import type { NullableFieldScope } from './nullable-fields.ts';
import { PAGINATION_SCHEMA } from './pagination.ts';
import { isSequenceContentType, responseDataSchema, sequenceDataSchema } from './output-data.ts';

// Re-exported so build.ts reads these from the module it already depends on
export type { NullableFieldScope } from './nullable-fields.ts';
export { OUTPUT_SCHEMA_WITHHELD_UNSAFE_PATTERN } from './output-data.ts';

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
//     less than the tool can actually return (the operator may opt out for
//     `default` only — see OutputSchemaOptions);
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

// Deliberately minimal: it is repeated in every success branch of every
// tool, and tools/list size is paid in every session. Declaring it once per
// tool (top-level property + `true` per branch) costs MORE for the common
// single-branch tool; typing the values (always strings, produced by this
// server) adds bytes without helping the caller.
const RESPONSE_HEADERS_SCHEMA: JsonSchemaRecord = { type: 'object' };
// A literal OpenAPI 3.1 status-code RANGE key ("2XX"/"2xx"), or the "default"
// response — either is treated as "might cover a success we cannot bound".
// With `defaultResponseIsError` (an explicit operator opt-in,
// kaisers-io/openapi-mcp-archive#72) the `default` key is assumed to document
// error statuses only and no longer counts; a "2XX" range key always does — it
// is a success range by definition.
const WILDCARD_OR_DEFAULT_SUCCESS_RE = /^2xx$/iu;
const hasUnboundedSuccess = (
  responses: Record<string, unknown>,
  defaultResponseIsError: boolean,
): boolean =>
  Object.keys(responses).some(
    (key) =>
      (key === 'default' && !defaultResponseIsError) || WILDCARD_OR_DEFAULT_SUCCESS_RE.test(key),
  );

// The CLI flag that sets `defaultResponseIsError`, named in the runtime
// error for an undocumented 2xx so the operator can find the assumption.
export const DEFAULT_RESPONSE_IS_ERROR_FLAG = '--default-response-is-error';

export type OutputSchemaOptions = {
  // Treat an operation's `default` response as covering error statuses only,
  // so it no longer suppresses the outputSchema. OAS 3.1.1 §4.8.16.1: `default`
  // is "the documentation of responses other than the ones declared for
  // specific HTTP response codes" — it MAY cover an undocumented success, which
  // is why this is opt-in. At runtime such an undocumented 2xx still fails
  // closed (`isError`), never a nonconforming structuredContent.
  defaultResponseIsError?: boolean;
  // A paginated tool's envelope also declares the `pagination` hint.
  pagination?: boolean;
  // A projectable tool (`_fields`) also gets ONE `projection` branch.
  projection?: boolean;
  // Every value under an object's `properties` in the derived `data` schema
  // also admits null (issue #3; see admitNullProperties). For specs whose
  // generator omits `nullable` while the server serializes unset fields as
  // null: OAS 3.0.3 §4.7.24.1 defaults `nullable` to false, so the strict
  // schema rejects such a response even though the data is usable. Scope
  // `optional` leaves properties their object lists in `required` strict
  // (issue #17).
  nullableResponseFields?: NullableFieldScope;
};

// Minimal on purpose: the projected values come from `data` that already
// passed the strict branch, so this branch only has to tell the two shapes
// apart (`projection` required here, `data` required and extra keys refused
// there) — exactly one branch matches either shape. ONE branch for every
// success status/content type: it only has to validate, not discriminate,
// and tools/list size is paid in every session.
const PROJECTION_BRANCH: JsonSchemaRecord = {
  type: 'object',
  properties: { projection: { type: 'object' } },
  required: ['status', 'contentType', 'projection'],
};

export type OutputSchemaDerivation = {
  outputSchema?: JsonSchemaRecord;
  // Set when nullableResponseFields changed at least one `data` schema.
  admitsNullFields?: true;
  // Agent-facing sentence explaining a withheld output schema (see above).
  withheld?: string;
};

// --output-schema defs (issue #9): a derived output schema with its repeated
// subschemas once under `$defs`, for what a host is shown (tools/list,
// describe_operation). It accepts exactly the same values as the inline form,
// so validation results do not depend on which one a validator is compiled
// from. The branches and their `status`/`contentType`
// schemas stay inline: the executor reads those consts off the schema itself
// (see branchesOf in server/execute/response.ts).
export const compactOutputSchema = (outputSchema: JsonSchemaRecord): JsonSchemaRecord => {
  const pinned = new Set<JsonSchemaRecord>();
  const { oneOf } = outputSchema;
  for (const branch of Array.isArray(oneOf) ? (oneOf as unknown[]) : []) {
    if (branch === null || typeof branch !== 'object') {
      continue;
    }
    pinned.add(branch as JsonSchemaRecord);
    const { properties } = branch as JsonSchemaRecord;
    if (properties !== null && typeof properties === 'object') {
      for (const key of ['status', 'contentType']) {
        const value = (properties as JsonSchemaRecord)[key];
        if (value !== null && typeof value === 'object') {
          pinned.add(value as JsonSchemaRecord);
        }
      }
    }
  }
  return factorRepeatedSubschemas(outputSchema, pinned);
};

export const explainOutputSchema = (
  operation: OperationRecord,
  version: OpenapiVersion,
  options: OutputSchemaOptions = {},
): OutputSchemaDerivation => {
  if (hasUnboundedSuccess(operation.responses, options.defaultResponseIsError === true)) {
    return {};
  }
  const successKeys = Object.keys(operation.responses).filter((key) => SUCCESS_STATUS_RE.test(key));
  if (successKeys.length === 0) {
    return {};
  }
  const branches: JsonSchemaRecord[] = [];
  // Per branch: did nullableResponseFields change its data schema?
  const widened: boolean[] = [];
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
    // From OpenAPI 3.2 on, a sequential media type is an array of its items
    // (OAS 3.2.1 §4.14.3.1, issue #33); 3.0 and 3.1 define no such mapping
    const jsonKeys = contentKeys.filter(
      (type) => isJsonContentType(type) || (version === '3.2' && isSequenceContentType(type)),
    );
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
    // An unresolved (cyclic) Media Type $ref, possible from OpenAPI 3.2 on, is
    // no schema-less media type: withhold the output schema, as for a cyclic
    // response $ref, instead of advertising any JSON (issue #33)
    if (!isRecord(entry) || Object.hasOwn(entry, '$ref')) {
      return {};
    }
    const derived = isSequenceContentType(contentType)
      ? sequenceDataSchema(entry, version)
      : responseDataSchema(entry['schema'] ?? {}, version);
    if (!('ok' in derived)) {
      return derived.withheld === undefined ? {} : { withheld: derived.withheld };
    }
    const strictData = derived.ok;
    // The root value is never widened: only object properties are
    const dataSchema =
      options.nullableResponseFields === undefined
        ? strictData
        : admitNullProperties(strictData, options.nullableResponseFields);
    widened.push(dataSchema !== strictData);
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
  return {
    outputSchema: {
      type: 'object',
      oneOf: options.projection === true ? [...branches, PROJECTION_BRANCH] : branches,
    },
    ...(widened.includes(true) ? { admitsNullFields: true as const } : {}),
  };
};

export const deriveOutputSchema = (
  operation: OperationRecord,
  version: OpenapiVersion,
  options: OutputSchemaOptions = {},
): JsonSchemaRecord | undefined => explainOutputSchema(operation, version, options).outputSchema;

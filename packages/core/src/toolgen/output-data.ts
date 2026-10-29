import type { z } from 'zod';
import type { OpenapiVersion } from '../spec/validate.ts';
import { sequenceKind } from './media-type.ts';
import {
  convertSchema,
  hasControlOrBidi,
  memoizedJsonSchema,
  toWireJsonSchema,
  UNSAFE_PATTERN_REASON,
} from './schema.ts';

// The `data` part of a derived output schema (output-schema.ts): one
// response Media Type Object as JSON Schema.

type JsonSchemaRecord = Record<string, unknown>;

// The sequential media types with a JSON data model (see media-type.ts),
// written as a bare lower-case key, like a JSON key in output-schema.ts
export const isSequenceContentType = (contentType: string): boolean =>
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType) &&
  sequenceKind(contentType) !== undefined;

// Stands in for a data schema with a control or bidi character in a name or
// value. Memoized like any emitted schema, so a shared node is walked once.
const UNSAFE_TEXT_SCHEMA: JsonSchemaRecord = Object.freeze({});

// Isolates the one throwing step (z.toJSONSchema) behind an Option-shaped
// result so the caller never needs a `let` to survive the try/catch.
const toDataSchema = (schema: z.ZodType): JsonSchemaRecord | undefined => {
  try {
    // A shallow copy drops zod's hidden `~standard` property, which keeps
    // the zod schema alive (#47). `$schema` goes too: JSON Schema 2020-12
    // allows it only at a resource root, and `data` sits inside the
    // envelope (it cost 3 KB per GitHub tool list, issue #49).
    const { $schema: _dialect, ...data } = toWireJsonSchema(schema);
    return hasControlOrBidi(data) ? UNSAFE_TEXT_SCHEMA : data;
  } catch {
    // Defensive: our schemas are representable (proven upstream); fail
    // closed rather than emit a nonconforming outputSchema.
    return undefined;
  }
};

// Why an operation has no output schema, when that is worth telling the
// agent. Only the kaisers-io/openapi-mcp-archive#39 regex policy is reported:
// the other omissions (no JSON success, a `default` response, ...) are ordinary
// and need no explanation.
export const OUTPUT_SCHEMA_WITHHELD_UNSAFE_PATTERN =
  'No output schema: a response regex "pattern" has nested quantifiers (unbounded matching cost), so results are returned as text only.';

export const OUTPUT_SCHEMA_WITHHELD_UNSAFE_TEXT =
  'No output schema: a name or value in a response schema has a control or bidirectional-override character, so results are returned as text only.';

// One response schema as the JSON Schema of `data`, or why it cannot be.
// Response mode: undeclared fields stay allowed unless the spec says
// `additionalProperties: false`, and writeOnly properties are optional —
// see SchemaMode in schema.ts.
export type DataSchema = { ok: JsonSchemaRecord } | { withheld?: string };
export const responseDataSchema = (schema: unknown, version: OpenapiVersion): DataSchema => {
  const converted = convertSchema(schema, version, 0, 'response');
  if (!('ok' in converted)) {
    return converted.unrepresentable.includes(UNSAFE_PATTERN_REASON)
      ? { withheld: OUTPUT_SCHEMA_WITHHELD_UNSAFE_PATTERN }
      : {};
  }
  // The same response schema (one shared node, one memoized Zod schema) is
  // emitted once per build, not once per operation that returns it
  const json = memoizedJsonSchema(converted.ok, toDataSchema);
  if (json === UNSAFE_TEXT_SCHEMA) {
    return { withheld: OUTPUT_SCHEMA_WITHHELD_UNSAFE_TEXT };
  }
  return json === undefined ? {} : { ok: json };
};

// A sequential media type's `data` is the array of its items: `schema`
// describes that whole array, `itemSchema` each item (OAS 3.2.1 §4.14.1).
// Both apply when both are declared; neither leaves the items open.
export const sequenceDataSchema = (
  entry: Record<string, unknown>,
  version: OpenapiVersion,
): DataSchema => {
  const parts: JsonSchemaRecord[] = [];
  for (const [key, wrap] of [
    ['schema', (json: JsonSchemaRecord) => json],
    ['itemSchema', (json: JsonSchemaRecord) => ({ type: 'array', items: json })],
  ] as const) {
    if (entry[key] === undefined) {
      continue;
    }
    const derived = responseDataSchema(entry[key], version);
    if (!('ok' in derived)) {
      return derived;
    }
    parts.push(wrap(derived.ok));
  }
  const [only, second] = parts;
  if (only === undefined) {
    return { ok: { type: 'array' } };
  }
  return { ok: second === undefined ? only : { allOf: parts } };
};

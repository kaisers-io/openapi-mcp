import { z } from 'zod';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { GeneratedTool } from '../toolgen/build.ts';
import { withoutDescriptions } from '../toolgen/compact-schema.ts';
import { compactOutputSchema } from '../toolgen/output-schema.ts';
import { deriveAccept } from './execute/accept.ts';
import type { RuntimeTool, WireTool } from './types.ts';

// The wire shape of listed tools: the status tool's definition and the
// display helpers (title, stable order) for the generated ones.

export const META_TOOL_NAME = 'openapi_mcp_status';

// Bounds the omitted-reason list carried in the meta summary — the omitted
// COUNT is always exact; the reason list is a diagnostic sample, capped so a
// pathological spec cannot inflate the in-memory snapshot.
export const OMITTED_REASONS_CAP = 50;

export const META_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    specTitle: { type: 'string' },
    specVersion: { type: 'string' },
    displaySource: { type: 'string' },
    toolCount: { type: 'integer' },
    omittedCount: { type: 'integer' },
    omittedReasons: {
      type: 'array',
      maxItems: OMITTED_REASONS_CAP,
      items: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['method', 'path', 'reason'],
        additionalProperties: false,
      },
    },
    acceptedContentHash: { type: 'string' },
    deadPatternCount: { type: 'integer' },
    // Every operation that is not a tool, counted by why (issue #41): denied,
    // not-allowed, read-only-default, omitted and withheld. Kept small, as
    // this schema is part of every tools/list.
    notExposedCounts: { type: 'object', additionalProperties: { type: 'integer' } },
    // Process-local call counters (server/telemetry.ts), when collected.
    calls: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        byOutcome: { type: 'object', additionalProperties: { type: 'integer' } },
        upstreamLatencyMs: {
          type: 'object',
          properties: {
            samples: { type: 'integer' },
            p50: { type: 'number' },
            p95: { type: 'number' },
          },
          required: ['samples'],
          additionalProperties: false,
        },
      },
      required: ['total', 'byOutcome', 'upstreamLatencyMs'],
      additionalProperties: false,
    },
    // Present only when start-up could not record the spec revalidation
    // because another process holds the cache lock
    // (kaisers-io/openapi-mcp-archive#65). Host users rarely see stderr, so the
    // stuck case is surfaced here too.
    cacheLock: {
      type: 'string',
      enum: ['held', 'stale'],
      description:
        'Cache metadata not updated at start-up. stale: a dead process left the lock; run "openapi-mcp cache unlock". Tools still work.',
    },
  },
  required: [
    'specTitle',
    'specVersion',
    'displaySource',
    'toolCount',
    'omittedCount',
    'omittedReasons',
    'acceptedContentHash',
    'deadPatternCount',
  ],
  additionalProperties: false,
};

// With several APIs (issue #16) the status also lists each one. Only then:
// a single API's tools/list stays byte-identical.
const API_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    specTitle: { type: 'string' },
    specVersion: { type: 'string' },
    displaySource: { type: 'string' },
    toolCount: { type: 'integer' },
    omittedCount: { type: 'integer' },
    acceptedContentHash: { type: 'string' },
    deadPatternCount: { type: 'integer' },
    notExposedCounts: { type: 'object', additionalProperties: { type: 'integer' } },
  },
  required: ['name', 'specTitle', 'specVersion', 'displaySource', 'toolCount'],
  additionalProperties: false,
};
const MULTI_API_OUTPUT_SCHEMA: Record<string, unknown> = {
  ...META_OUTPUT_SCHEMA,
  properties: {
    ...(META_OUTPUT_SCHEMA['properties'] as Record<string, unknown>),
    apis: { type: 'array', items: API_SUMMARY_SCHEMA },
  },
};

export const META_INPUT_SCHEMA = z.strictObject({});

export const metaWireTool = (multiApi = false): WireTool => ({
  name: META_TOOL_NAME,
  title: 'Server status',
  description: 'Server spec, tools, omissions and exposure counts; not spec-derived.',
  inputSchema: z.toJSONSchema(META_INPUT_SCHEMA),
  outputSchema: multiApi ? MULTI_API_OUTPUT_SCHEMA : META_OUTPUT_SCHEMA,
  // Not the OpenAPI-method heuristic (this is our own tool, not a wrapped
  // operation): explicitly read-only and NOT open-world — it only reads local
  // process state, it never talks to an external system.
  annotations: { readOnlyHint: true, openWorldHint: false },
});

// Clients show `title` in tool pickers and approval prompts, so it is kept
// short. `summary` already went through normalizeSpec's sanitizeSpecText;
// it is re-capped here for display.
const TITLE_MAX = 80;
export const titleOf = (generated: GeneratedTool): string | undefined => {
  const { summary } = generated.operation;
  const title = summary === undefined ? '' : sanitizeSpecText(summary, TITLE_MAX);
  return title === '' ? undefined : title;
};

// What a snapshot keeps of an operation (see RuntimeTool).
export const runtimeOperationOf = (operation: OperationRecord): RuntimeTool['operation'] => ({
  method: operation.method,
  path: operation.path,
  tags: operation.tags,
  ...(operation.summary === undefined ? {} : { summary: operation.summary }),
  ...(operation.description === undefined ? {} : { description: operation.description }),
});

// What a snapshot keeps of a generated tool (see RuntimeTool).
export const runtimeToolOf = ({ operation, ...tool }: GeneratedTool): RuntimeTool => ({
  ...tool,
  operation: runtimeOperationOf(operation),
  accept: deriveAccept(operation.responses),
});

// Code-point order (never locale-dependent): `<` on strings compares UTF-16
// code units, identical everywhere.
export const byToolName = (
  first: { readonly name: string },
  second: { readonly name: string },
): number => {
  if (first.name === second.name) {
    return 0;
  }
  return first.name < second.name ? -1 : 1;
};

// The outputSchema a host is shown (tools/list, describe_operation): under
// --output-schema defs (issue #9) its repeated subschemas once under `$defs`,
// and under --no-output-schema-descriptions (issue #49) without its
// `description` keywords; computed once per schema object and form. Under
// per-operation the executor compiles this form too (it validates the listed
// wire tool); under discover it keeps the inline one. Every form accepts
// exactly the same values.
export type OutputSchemaForm = { compact: boolean; descriptions: boolean };

const presented = new Map<string, WeakMap<Record<string, unknown>, Record<string, unknown>>>();
export const presentedOutputSchema = (
  outputSchema: Record<string, unknown>,
  form: OutputSchemaForm,
): Record<string, unknown> => {
  if (!form.compact && form.descriptions) {
    return outputSchema;
  }
  const key = `${String(form.compact)}:${String(form.descriptions)}`;
  let cache = presented.get(key);
  if (cache === undefined) {
    cache = new WeakMap();
    presented.set(key, cache);
  }
  let shown = cache.get(outputSchema);
  if (shown === undefined) {
    const bare = form.descriptions
      ? outputSchema
      : (withoutDescriptions(outputSchema) as Record<string, unknown>);
    shown = form.compact ? compactOutputSchema(bare) : bare;
    cache.set(outputSchema, shown);
  }
  return shown;
};

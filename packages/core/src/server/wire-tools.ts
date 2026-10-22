import { z } from 'zod';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { GeneratedTool } from '../toolgen/build.ts';
import type { SnapshotTool, WireTool } from './types.ts';

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
    // because another process holds the cache lock (#65). Host users rarely
    // see stderr, so the stuck case is surfaced here too.
    cacheLock: {
      type: 'string',
      enum: ['held', 'stale'],
      description:
        'Cache metadata not updated at start-up. stale: a dead process left the cache lock; the operator should run "openapi-mcp cache unlock". Tools still work.',
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

export const META_INPUT_SCHEMA = z.strictObject({});

export const metaWireTool = (): WireTool => ({
  name: META_TOOL_NAME,
  title: 'Server status',
  description:
    "Report this server's accepted spec, tool inventory, and omissions. Read-only, package-authored — never spec-derived.",
  inputSchema: z.toJSONSchema(META_INPUT_SCHEMA) as Record<string, unknown>,
  outputSchema: META_OUTPUT_SCHEMA,
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

// Code-point order (never locale-dependent): `<` on strings compares UTF-16
// code units, identical everywhere.
export const byToolName = (first: SnapshotTool, second: SnapshotTool): number => {
  if (first.name === second.name) {
    return 0;
  }
  return first.name < second.name ? -1 : 1;
};

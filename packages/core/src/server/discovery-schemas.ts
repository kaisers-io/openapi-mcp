import { z } from 'zod';
import { HTTP_METHODS } from '../spec/normalize.ts';

// Input and output schemas of the three discovery tools (issue #38). Every
// field a caller controls is bounded here, before any search or lookup runs.

// Caller-controlled search input is bounded before any work: the query's
// length (the 500-character cap a hosted BM25 tool search applies too),
// its distinct token count, the tag filter list and the result count.
export const SEARCH_QUERY_MAX_LENGTH = 500;
export const SEARCH_QUERY_MAX_TOKENS = 32;
const SEARCH_TAG_MAX_LENGTH = 128;
const SEARCH_TAGS_MAX_COUNT = 16;
export const SEARCH_LIMIT_MAX = 25;
export const SEARCH_LIMIT_DEFAULT = 10;

// Matches MCP's own 128-character tool name ceiling; every generated tool
// name is at most 64 (toolgen/naming.ts), so this never rejects a real one.
const OPERATION_NAME_MAX_LENGTH = 128;
// An unknown name is reflected back to the model, capped below its input cap.
export const REFLECTED_NAME_MAX = 100;

const OPERATION_NAME_DESCRIPTION = 'An operation name returned by search_operations.';

export const DESCRIBE_INPUT_SCHEMA = z.strictObject({
  name: z.string().min(1).max(OPERATION_NAME_MAX_LENGTH).describe(OPERATION_NAME_DESCRIPTION),
});

// `arguments` is deliberately `unknown` here: it is validated exactly once,
// by the TARGET operation's own closed Zod schema in the dispatcher — the same
// schema, with the same error rendering, a direct tool call uses. An object
// schema here would rebuild the value first, so the target would no longer
// validate the caller's arguments as sent. The wire schema below still
// advertises it as an object.
export const CALL_INPUT_SCHEMA = z.strictObject({
  name: z.string().min(1).max(OPERATION_NAME_MAX_LENGTH),
  arguments: z.unknown().optional(),
});

export type CallInput = z.infer<typeof CALL_INPUT_SCHEMA>;

export const CALL_WIRE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: OPERATION_NAME_MAX_LENGTH,
      description: OPERATION_NAME_DESCRIPTION,
    },
    arguments: {
      type: 'object',
      description:
        "The operation's arguments, matching the inputSchema describe_operation returns for it. Omit for an operation without inputs.",
    },
  },
  required: ['name'],
  additionalProperties: false,
};

// Open (no additionalProperties:false): the payload IS the operation's wire
// tool, so a wire field added later (e.g. `title`) passes through unchanged.
export const DESCRIBE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: { type: 'object' },
  },
  required: ['name', 'description', 'inputSchema', 'annotations'],
};

const UPPER_METHODS = HTTP_METHODS.map((method) => method.toUpperCase()) as [string, ...string[]];

export const SEARCH_INPUT_SCHEMA = z.strictObject({
  query: z
    .string()
    .max(SEARCH_QUERY_MAX_LENGTH)
    .optional()
    .describe(
      'Keywords matched against operation names, HTTP paths, tags, parameter names, summaries and descriptions. Omit to list operations by name.',
    ),
  tags: z
    .array(z.string().min(1).max(SEARCH_TAG_MAX_LENGTH))
    .max(SEARCH_TAGS_MAX_COUNT)
    .optional()
    .describe('Only operations carrying at least one of these tags (case-insensitive).'),
  method: z.enum(UPPER_METHODS).optional().describe('Only operations with this HTTP method.'),
  limit: z
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .optional()
    .describe(`Maximum number of results (default ${String(SEARCH_LIMIT_DEFAULT)}).`),
  detail: z
    .enum(['names', 'summary'])
    .optional()
    .describe(
      '"names": operation names only; "summary" (default): also method, path, summary and tags.',
    ),
});

export const SEARCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      maxItems: SEARCH_LIMIT_MAX,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          method: { type: 'string' },
          path: { type: 'string' },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    totalMatches: { type: 'integer' },
  },
  required: ['results', 'totalMatches'],
  additionalProperties: false,
};

export type SearchInput = z.infer<typeof SEARCH_INPUT_SCHEMA>;
export type DescribeInput = z.infer<typeof DESCRIBE_INPUT_SCHEMA>;

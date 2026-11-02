// The large-response fixtures of the benchmark (issue #22), split from
// fixtures.ts, which lists them with the others

import type { Fixture, ToolCall } from './fixtures.ts';

// Large responses (issue #22): one spec, two shapes. `/report` returns many
// small objects, `/blob` one object with a single huge string. Both declare
// an output schema, so a call validates the whole result and keeps it as
// structuredContent next to a text preview of at most 8 KiB.
const ok = (schema: Record<string, unknown>) => ({
  200: { description: 'ok', content: { 'application/json': { schema } } },
});

const largeSpec = (): Record<string, unknown> => {
  const row = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' } },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'large', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/report': {
        get: { operationId: 'getReport', responses: ok({ type: 'array', items: row }) },
      },
      '/blob': {
        get: {
          operationId: 'getBlob',
          responses: ok({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' }, blob: { type: 'string' } },
          }),
        },
      },
    },
  };
};

const KIB = 1024;
const MIB = 1024 * KIB;

// Rows of `{id, name, note}` until the JSON body reaches `bytes`. `text`
// fills each note: plain ASCII, characters JSON escapes, or characters of 2
// to 4 UTF-8 bytes, so the 8 KiB preview cut lands inside a multi-byte one
const rows = (bytes: number, text: string): unknown[] => {
  const result: unknown[] = [];
  let size = 2;
  for (let index = 0; size < bytes; index += 1) {
    const entry = { id: `r${String(index)}`, name: `row ${String(index)}`, note: text };
    size += Buffer.byteLength(JSON.stringify(entry)) + 1;
    result.push(entry);
  }
  return result;
};

const PLAIN = 'lorem ipsum dolor sit amet '.repeat(4);
const ESCAPED = 'a "quoted" \\ path\n\ttab \u0001 '.repeat(4);
const UNICODE = 'ü€😀𝄞'.repeat(16);

const report = (bytes: number, text = PLAIN): ToolCall => ({
  tool: 'getReport',
  args: {},
  response: () => rows(bytes, text),
});

const largeFixture = (
  name: string,
  description: string,
  call: ToolCall,
  suite: Fixture['suite'],
  extra: Partial<Fixture> = {},
): Fixture => ({
  name,
  description,
  spec: () => Promise.resolve({ text: JSON.stringify(largeSpec()), extension: 'json' }),
  filterArgs: [],
  call,
  suite,
  ...extra,
});

export const LARGE_FIXTURES: readonly Fixture[] = [
  largeFixture(
    'large-1mb',
    '1 MiB JSON of small objects with an output schema: validation, structuredContent, preview',
    report(MIB),
    'ci',
  ),
  largeFixture(
    'large-120kb',
    '120 KiB of small objects: below the size where the preview stops serializing everything',
    report(120 * KIB),
    'heavy',
  ),
  largeFixture(
    'large-136kb',
    '136 KiB of small objects: above the size where the preview stops serializing everything',
    report(136 * KIB),
    'heavy',
  ),
  largeFixture(
    'large-1mb-leaf',
    '1 MiB in a single string field',
    { tool: 'getBlob', args: {}, response: () => ({ id: 'b', blob: 'x'.repeat(MIB) }) },
    'heavy',
  ),
  largeFixture(
    'large-1mb-escaped',
    '1 MiB of small objects whose strings JSON escapes (quotes, backslashes, controls)',
    report(MIB, ESCAPED),
    'heavy',
  ),
  largeFixture(
    'large-1mb-unicode',
    '1 MiB of small objects with 2- to 4-byte UTF-8 characters',
    report(MIB, UNICODE),
    'heavy',
  ),
  largeFixture(
    'large-1mb-fields',
    '1 MiB of small objects, with _fields selecting one field per object',
    { tool: 'getReport', args: { _fields: ['/*/id'] }, response: () => rows(MIB, PLAIN) },
    'heavy',
    { serveArgs: ['--response-projection'] },
  ),
  largeFixture(
    'large-1mb-slow',
    '1 MiB of small objects from an upstream that sends it in 16 chunks, 20 ms apart',
    report(MIB),
    'heavy',
    { slowBody: { chunks: 16, delayMs: 20 } },
  ),
  largeFixture('large-5mb', '5 MiB of small objects', report(5 * MIB), 'heavy'),
  largeFixture(
    'large-10mb',
    '10 MiB of small objects, under a raised --max-response-bytes',
    report(10 * MIB),
    'heavy',
    { serveArgs: ['--max-response-bytes', '16MB'] },
  ),
];

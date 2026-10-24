import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildRequest,
  buildTools,
  compileEnvelopeValidator,
  createDereferencer,
  createRedactor,
  deriveOutputSchema,
  mapResponse,
  normalizeSpec,
  SYSTEM_HEADERS,
  validateOpenApiDocument,
} from '../src/index.ts';
import type { BuildToolsResult, OperationRecord, ToolCallOutcome } from '../src/index.ts';
import { parseSequence } from '../src/server/execute/response-media.ts';
import { sequenceBody } from '../src/server/execute/sequence-body.ts';

// Issue #33: sequential media types (OAS 3.2.1 §4.14.3.1) map to the JSON
// data model as the array of their items: JSON Lines, NDJSON, JSON text
// sequences (RFC 7464) and Server-Sent Events.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const budgets = { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 };
const order = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, note: { type: ['string', 'null'] } },
  additionalProperties: false,
};

describe('parseSequence — reading a sequential response body', () => {
  it('reads JSON Lines and NDJSON line by line, skipping blank lines and CRs', () => {
    expect(parseSequence('{"a":1}\r\n\n[2]\n"x"', 'json-lines')).toEqual([{ a: 1 }, [2], 'x']);
    expect(parseSequence('', 'json-lines')).toEqual([]);
    expect(parseSequence('{"a":1}\n{"a":', 'json-lines')).toBeUndefined();
  });

  it('reads JSON text sequences (RFC 7464) and fails closed on a truncated record', () => {
    expect(parseSequence('\u001E{"a":1}\n\u001E\u001E2\n', 'json-seq')).toEqual([{ a: 1 }, 2]);
    // A record without its closing LF may be truncated (RFC 7464 §2.4)
    expect(parseSequence('\u001E{"a":1}\n\u001E12', 'json-seq')).toBeUndefined();
    // Text before the first RS belongs to no record
    expect(parseSequence('x\u001E1\n', 'json-seq')).toBeUndefined();
    expect(parseSequence('\u001E{\n', 'json-seq')).toBeUndefined();
  });

  // The example of OAS 3.2.1 §4.14.6.3 and its JSON Lines equivalent
  it('reads Server-Sent Events as the spec example shows', () => {
    const stream = [
      'event: addString',
      'data: This data is formatted',
      'data: across two lines',
      'retry: 5',
      '',
      'event: addInt64',
      'data: 1234',
      'unknownField: this is ignored',
      '',
      ': This is a comment',
      'event: addJSON',
      'data: {"foo": 42}',
      '',
      '',
    ].join('\n');
    expect(parseSequence(stream, 'event-stream')).toEqual([
      { event: 'addString', data: 'This data is formatted\nacross two lines', retry: 5 },
      { event: 'addInt64', data: '1234' },
      { event: 'addJSON', data: '{"foo": 42}' },
    ]);
  });

  it('follows the event stream rules for line ends, fields and dispatch', () => {
    const stream =
      '﻿data:a\r\rdata\rid: x\u0000y\rretry: 1.5\rid: 7\r\r: only a comment\r\rdata: tail';
    expect(parseSequence(stream, 'event-stream')).toEqual([
      // No space after the colon: the value is taken as is
      { data: 'a' },
      // A bare field name has an empty value; an id with NULL and a
      // non-integer retry are ignored
      { data: '', id: '7' },
      // A block without data dispatches nothing, and an event not closed by
      // a blank line is discarded
    ]);
  });
});

const operation = (content: Record<string, unknown>): OperationRecord => ({
  method: 'get',
  path: '/orders/export',
  tags: [],
  deprecated: false,
  parameters: [],
  responses: { '200': { description: 'ok', content } },
});

describe('output schema for a sequential response', () => {
  it('is the array of items: itemSchema per item, schema for the whole array', () => {
    const data = (content: Record<string, unknown>): unknown => {
      const schema = deriveOutputSchema(operation(content), '3.2');
      const [branch] = (schema?.['oneOf'] ?? []) as Record<string, unknown>[];
      return branch?.['properties'];
    };
    expect(data({ 'application/jsonl': { itemSchema: order } })).toMatchObject({
      contentType: { const: 'application/jsonl' },
      data: { type: 'array', items: { type: 'object', required: ['id'] } },
    });
    expect(
      data({ 'application/json-seq': { schema: { type: 'array', maxItems: 2 } } }),
    ).toMatchObject({ data: { type: 'array', maxItems: 2 } });
    expect(
      data({
        'application/x-ndjson': { schema: { type: 'array', maxItems: 2 }, itemSchema: order },
      }),
    ).toMatchObject({
      data: {
        allOf: [
          { type: 'array', maxItems: 2 },
          { type: 'array', items: { type: 'object' } },
        ],
      },
    });
    expect(data({ 'text/event-stream': {} })).toMatchObject({ data: { type: 'array' } });
  });

  it('is withheld before 3.2, next to another media type, and for an unusual key', () => {
    expect(
      deriveOutputSchema(operation({ 'application/jsonl': { itemSchema: order } }), '3.1'),
    ).toBeUndefined();
    expect(
      deriveOutputSchema(
        operation({ 'application/jsonl': { itemSchema: order }, 'application/json': {} }),
        '3.2',
      ),
    ).toBeUndefined();
    expect(
      deriveOutputSchema(operation({ 'Application/JSONL': { itemSchema: order } }), '3.2'),
    ).toBeUndefined();
  });
});

describe('mapResponse — a sequential response', () => {
  const outcome = (contentType: string, body: string) => ({
    kind: 'response' as const,
    status: 200,
    contentType,
    bodyBytes: encoder.encode(body),
    headers: {},
    url: 'https://api.example.test/',
  });
  const structured = (contentType: string, body: string, secret?: string): ToolCallOutcome => {
    const outputSchema = deriveOutputSchema(
      operation({ [contentType]: { itemSchema: order } }),
      '3.2',
    )!;
    return mapResponse({
      outcome: outcome(`${contentType}; charset=utf-8`, body),
      outputSchema,
      validator: compileEnvelopeValidator(outputSchema),
      redactor: createRedactor(secret === undefined ? [] : [secret]),
      maxTextBytes: 4096,
    });
  };

  it('returns the items as structured data, validated item by item', () => {
    const ok = structured('application/jsonl', '{"id":"o1","note":null}\n{"id":"o2"}\n');
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toEqual({
      status: 200,
      contentType: 'application/jsonl',
      data: [{ id: 'o1', note: null }, { id: 'o2' }],
    });
    const invalid = structured('application/jsonl', '{"id":"o1"}\n{"id":2}\n');
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("did not match the tool's declared output schema");
  });

  it('fails closed on a malformed sequence and on a secret in an item', () => {
    const broken = structured('application/json-seq', '\u001E{"id":"o1"}');
    expect(broken.content[0]?.text).toBe(
      'upstream response for status 200 was not a valid application/json-seq sequence',
    );
    const secret = 'sk/live/not-a-real-secret';
    const leaked = structured(
      'application/jsonl',
      `{"id":"${secret.replaceAll('/', '\\/')}"}\n`,
      secret,
    );
    expect(leaked.isError).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain('not-a-real-secret');
  });

  it('returns a sequence without an output schema as text instead of refusing its media type', () => {
    const text = mapResponse({
      outcome: outcome('application/x-ndjson', '{"id":"o1"}\n'),
      outputSchema: undefined,
      validator: undefined,
      redactor: createRedactor([]),
      maxTextBytes: 4096,
    });
    expect(text).toMatchObject({ isError: false, content: [{ text: '{"id":"o1"}\n' }] });
    // An escaped secret inside an item is found in the parsed items
    const secret = 'sk/live/not-a-real-secret';
    const leaked = mapResponse({
      outcome: outcome('application/jsonl', `{"id":"${secret.replaceAll('/', '\\/')}"}\n`),
      outputSchema: undefined,
      validator: undefined,
      redactor: createRedactor([secret]),
      maxTextBytes: 4096,
    });
    expect(leaked.isError).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain('not-a-real-secret');
  });
});

const doc32 = (
  requestBody: Record<string, unknown>,
  version = '3.2.0',
): Record<string, unknown> => ({
  openapi: version,
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/orders/import': { post: { requestBody, responses: { '204': { description: 'ok' } } } },
  },
});

const build = (document: Record<string, unknown>): BuildToolsResult => {
  const { version } = validateOpenApiDocument(document);
  const normalized = normalizeSpec(document, version);
  const dereferencer = createDereferencer(document, {
    collapseCycles: true,
    openapiVersion: version,
  });
  const operations: OperationRecord[] = [];
  for (const record of normalized.operations) {
    const { requestBody } = record;
    operations.push({
      ...record,
      ...(requestBody === undefined
        ? {}
        : { requestBody: dereferencer.resolve(requestBody) as Record<string, unknown> }),
    });
  }
  return buildTools(assignToolNames(operations), {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: version,
  });
};

describe('a sequential request body', () => {
  it('becomes one array argument, validated per item, and is sent in its framing', () => {
    const { tools, omitted } = build(
      doc32({ required: true, content: { 'application/jsonl': { itemSchema: order } } }),
    );
    expect(omitted).toEqual([]);
    const [tool] = tools;
    expect(tool?.wireSchema).toMatchObject({
      required: ['body'],
      properties: { body: { type: 'array', items: { type: 'object' } } },
    });
    const request = buildRequest(
      tool!.mapper,
      'POST',
      '/orders/import',
      { body: [{ id: 'o1' }, { id: 'o2', note: 'a\nb' }] },
      budgets,
    );
    expect(request).toMatchObject({ ok: { contentType: 'application/jsonl' } });
    expect(decoder.decode((request as { ok: { body: Uint8Array } }).ok.body)).toBe(
      '{"id":"o1"}\n{"id":"o2","note":"a\\nb"}\n',
    );
  });

  it.each([
    [
      'both schema and itemSchema',
      { 'application/jsonl': { schema: { type: 'array' }, itemSchema: order } },
      'a sequential request body with both "schema" and "itemSchema" is not supported',
    ],
    [
      'two sequential media types',
      { 'application/jsonl': {}, 'application/x-ndjson': {} },
      'the request body declares several sequential media types (application/jsonl, application/x-ndjson) with no deterministic choice',
    ],
  ])('omits an operation with %s', (_label, content, reason) => {
    expect(build(doc32({ content })).omitted).toEqual([
      { method: 'POST', path: '/orders/import', reason },
    ]);
  });

  it('takes any items without a schema, and writes events for text/event-stream', () => {
    const [open] = build(doc32({ content: { 'application/x-ndjson': {} } })).tools;
    expect(open?.wireSchema).toMatchObject({ properties: { body: { type: 'array' } } });
    const anything = buildRequest(
      open!.mapper,
      'POST',
      '/orders/import',
      { body: [1, 'a'] },
      budgets,
    );
    expect(decoder.decode((anything as { ok: { body: Uint8Array } }).ok.body)).toBe('1\n"a"\n');
    // Optional and absent: no body at all
    expect(buildRequest(open!.mapper, 'POST', '/orders/import', {}, budgets)).toMatchObject({
      ok: { headers: {} },
    });
    const event = {
      type: 'object',
      required: ['data'],
      properties: { data: { type: 'string' }, event: { type: 'string', enum: ['add'] } },
      additionalProperties: false,
    };
    const [events] = build(
      doc32({ required: true, content: { 'text/event-stream': { itemSchema: event } } }),
    ).tools;
    const sent = buildRequest(
      events!.mapper,
      'POST',
      '/orders/import',
      { body: [{ event: 'add', data: 'o1' }] },
      budgets,
    );
    expect(sent).toMatchObject({ ok: { contentType: 'text/event-stream' } });
    expect(decoder.decode((sent as { ok: { body: Uint8Array } }).ok.body)).toBe(
      'event: add\ndata: o1\n\n',
    );
  });

  it('prefers JSON when both are declared, and stays omitted before 3.2', () => {
    const both = build(
      doc32({ content: { 'application/json': { schema: order }, 'application/jsonl': {} } }),
    );
    expect(both.tools[0]?.mapper.bodyContentType).toBe('application/json');
    const before = build(doc32({ content: { 'application/jsonl': { schema: order } } }, '3.1.0'));
    expect(before.tools).toEqual([]);
    expect(before.omitted[0]?.reason).toContain('the request body has no JSON');
  });
});

describe('sequenceBody — writing a sequential request body', () => {
  const text = (payload: unknown, kind: Parameters<typeof sequenceBody>[1]): string => {
    const result = sequenceBody(payload, kind);
    return 'ok' in result ? decoder.decode(result.ok) : `error: ${result.error}`;
  };

  it('writes JSON text sequences and event streams', () => {
    expect(text([{ a: 1 }, 2], 'json-seq')).toBe('\u001E{"a":1}\n\u001E2\n');
    expect(text([], 'json-lines')).toBe('');
    expect(
      text([{ event: 'add', id: '1', retry: 5, data: 'two\nlines' }, { data: '' }], 'event-stream'),
    ).toBe('event: add\nid: 1\nretry: 5\ndata: two\ndata: lines\n\ndata: \n\n');
  });

  // What the receiver parses back is what was sent
  it('round-trips through the response-side reader', () => {
    const events = [
      { event: 'x', data: ' padded\r\nline' },
      { data: '{"a":1}', id: '9' },
    ];
    const sent = text(events, 'event-stream');
    expect(parseSequence(sent, 'event-stream')).toEqual([
      { event: 'x', data: ' padded\nline' },
      { data: '{"a":1}', id: '9' },
    ]);
  });

  it.each([
    [{ notAnArray: true }, 'json-lines', 'must be an array of its items'],
    [[1], 'event-stream', 'event 0 of the event-stream body must be an object'],
    [
      [{ data: 'x', name: 'y' }],
      'event-stream',
      'has a field other than data, event, id and retry',
    ],
    [[{ event: 'x' }], 'event-stream', 'needs a string "data"'],
    [[{ data: 'x', event: 'a\nid: 2' }], 'event-stream', 'has an invalid "event"'],
    [[{ data: 'x', id: 'a\u0000' }], 'event-stream', 'has an invalid "id"'],
    [[{ data: 'x', retry: -1 }], 'event-stream', 'has an invalid "retry"'],
    [[{ data: 'x', retry: 1.5 }], 'event-stream', 'has an invalid "retry"'],
  ] as const)('refuses %j as %s', (payload, kind, message) => {
    expect(text(payload, kind)).toContain(message);
  });
});

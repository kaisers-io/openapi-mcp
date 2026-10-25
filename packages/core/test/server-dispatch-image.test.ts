import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createDispatcher,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { DispatchResult, ToolCallOutcome } from '../src/index.ts';
import { BOUNDARY_WITHHELD_SUCCESS_TEXT } from '../src/server/withheld.ts';
import { markSecretScanned } from '../src/server/result.ts';
import type { ImageBlock } from '../src/server/result.ts';
import { pngOf } from './helpers/images.ts';

// The dispatch boundary for image results (#14): an image block passes
// unchanged, and one whose bytes carry a registered secret withholds the
// whole result, since an image cannot be redacted without breaking it.

const SECRET = 'example-token-not-a-secret';
const redactor = createRedactor([SECRET]);

const snapshot = buildSnapshot(
  buildTools(
    [
      {
        toolName: 'getItemImage',
        operation: {
          method: 'get',
          path: '/items/{id}/image',
          tags: [],
          deprecated: false,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', content: { 'image/png': {} } } },
        },
      },
    ],
    { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
  ),
  {
    spec: { title: 'Shop', specVersion: '1', omitted: [] },
    contentHash: 'hash',
    displaySource: 'https://api.example.test/openapi.json',
    deadPatterns: [],
  },
);

const callWith = async (image: Uint8Array, scanned = false): Promise<ToolCallOutcome> => {
  const block: ImageBlock = {
    type: 'image',
    data: Buffer.from(image).toString('base64'),
    mimeType: 'image/png',
  };
  if (scanned) {
    markSecretScanned(block, redactor);
  }
  const outcome: ToolCallOutcome = {
    isError: false,
    content: [{ type: 'text', text: 'image image/png' }, block],
  };
  const dispatcher = createDispatcher({
    snapshot,
    limiter: { consume: () => true, retryAfterMs: () => 0 },
    now: () => 0,
    executor: () => Promise.resolve(outcome),
    metaExecutor: createMetaExecutor(),
    redactor,
  });
  const result: DispatchResult = await dispatcher.call({
    name: 'getItemImage',
    arguments: { id: '1' },
    signal: new AbortController().signal,
  });
  if (result.kind !== 'outcome') {
    throw new Error(result.kind);
  }
  return result.outcome;
};

describe('dispatch boundary for images (#14)', () => {
  it('passes an image block unchanged', async () => {
    const png = pngOf(3, 3);
    const outcome = await callWith(png);
    expect(outcome.isError).toBe(false);
    expect(outcome.content[1]).toStrictEqual({
      type: 'image',
      data: Buffer.from(png).toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('withholds a result whose image carries a registered secret', async () => {
    const png = Uint8Array.from([...pngOf(1, 1), ...new TextEncoder().encode(SECRET)]);
    const outcome = await callWith(png);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toStrictEqual([{ type: 'text', text: BOUNDARY_WITHHELD_SUCCESS_TEXT }]);
  });

  // Review of #57: an image the executor scanned is not decoded and scanned
  // again at the boundary. A marked block passes even with secret bytes,
  // which shows the boundary skipped it.
  it('does not scan an image block again that the executor already scanned', async () => {
    const png = Uint8Array.from([...pngOf(1, 1), ...new TextEncoder().encode(SECRET)]);
    const outcome = await callWith(png, true);
    expect(outcome.isError).toBe(false);
  });
});

import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../src/redact.ts';
import { createImageStore } from '../src/images/store.ts';
import {
  IMAGE_MAX_BYTES,
  imageOutcome,
  isImageResponse,
} from '../src/server/execute/image-result.ts';
import { BOUNDARY_WITHHELD_SUCCESS_TEXT } from '../src/server/withheld.ts';
import { pngOf } from './helpers/images.ts';

// --image-responses (#14)

type Response = Parameters<typeof imageOutcome>[0];
const responseOf = (bodyBytes: Uint8Array, contentType = 'image/png', status = 200): Response => ({
  kind: 'response',
  status,
  contentType,
  bodyBytes,
  headers: {},
  url: 'https://api.example.test/items/1/image',
});

const redactor = createRedactor(['example-token-not-a-secret']);

describe('image responses (#14)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('takes the image path only for a 2xx image without an output schema', () => {
    const png = pngOf(2, 2);
    expect(isImageResponse(responseOf(png), false)).toBe(true);
    expect(isImageResponse(responseOf(png, 'image/png; charset=binary'), false)).toBe(true);
    expect(isImageResponse(responseOf(png), true)).toBe(false);
    expect(isImageResponse(responseOf(png, 'application/octet-stream'), false)).toBe(false);
    expect(isImageResponse(responseOf(png, 'image/png', 404), false)).toBe(false);
  });

  it('returns an inline image after a short text line, without structured content', async () => {
    const png = pngOf(640, 480);
    const outcome = await imageOutcome(responseOf(png), { mode: 'inline' }, redactor);
    expect(outcome).toStrictEqual({
      isError: false,
      content: [
        { type: 'text', text: `image image/png, 640x480, ${String(png.byteLength)} bytes` },
        { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      ],
    });
  });

  it('saves the image and returns only its path in file mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oamcp-image-'));
    roots.push(root);
    const store = await createImageStore(join(root, 'images'), 10_000_000);
    const png = pngOf(10, 20);
    const outcome = await imageOutcome(responseOf(png), { mode: 'file', store }, redactor);
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toHaveLength(1);
    const text = outcome.content[0]?.text ?? '';
    const path = /saved to (?<path>.+)$/u.exec(text)?.groups?.['path'] ?? '';
    expect(text).toContain(`image image/png, 10x20, ${String(png.byteLength)} bytes`);
    expect(Buffer.from(await readFile(path))).toStrictEqual(Buffer.from(png));
  });

  it.each([
    [
      'an SVG',
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'is not a PNG, JPEG, GIF or WebP image',
    ],
    [
      'bytes that are no image',
      new TextEncoder().encode('not an image at all'),
      'is not a PNG, JPEG, GIF or WebP image',
    ],
    ['an image too wide', pngOf(8001, 10), 'is an image over 8000 pixels per side'],
    ['an image too large', new Uint8Array(IMAGE_MAX_BYTES + 1), 'is an image over the'],
  ])('refuses %s with a tool error', async (_name, body, reason) => {
    const outcome = await imageOutcome(responseOf(body), { mode: 'inline' }, redactor);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toContain(`upstream response for status 200 ${reason}`);
  });

  it('withholds an image that contains a registered secret', async () => {
    const png = Uint8Array.from([
      ...pngOf(1, 1),
      ...new TextEncoder().encode('tEXtComment\u0000example-token-not-a-secret'),
    ]);
    const outcome = await imageOutcome(responseOf(png), { mode: 'inline' }, redactor);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toBe(BOUNDARY_WITHHELD_SUCCESS_TEXT);
  });

  it('reports an image that could not be saved as a tool error', async () => {
    const store = {
      dir: '/nowhere',
      save: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    };
    const outcome = await imageOutcome(responseOf(pngOf(1, 1)), { mode: 'file', store }, redactor);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toBe(
      'upstream response for status 200 is an image that could not be saved (EACCES)',
    );
  });
});

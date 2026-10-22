import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheLayout,
  hashContent,
  objectPath,
  readCacheEntry,
  writeAccepted,
} from '@kaisers-io/openapi-mcp-core';
import { realContext } from '../src/context.ts';

// #88 item 3: verified cache reads hash the raw bytes instead of decoding and
// re-encoding them. Fail-closed behaviour must be exactly what it was.
describe('readFileBytesCapped and raw-byte verification', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-bytes-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the file bytes verbatim, invalid UTF-8 included', async () => {
    const path = join(dir, 'raw');
    const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x7d]);
    await writeFile(path, bytes);
    const read = await realContext().cacheFs.readFileBytesCapped!(path, 64);
    expect(Buffer.compare(Buffer.from(read), bytes)).toBe(0);
  });

  it('enforces the cap before reading, exactly like the text variant', async () => {
    const path = join(dir, 'big');
    await writeFile(path, 'x'.repeat(10));
    const fs = realContext().cacheFs;
    const atCap = await fs.readFileBytesCapped!(path, 10);
    expect(atCap.byteLength).toBe(10);
    await expect(fs.readFileBytesCapped!(path, 9)).rejects.toMatchObject({ code: 'validation' });
    await expect(fs.readFileTextCapped(path, 9)).rejects.toMatchObject({ code: 'validation' });
  });

  const seed = async (): Promise<{ object: string }> => {
    const fs = realContext().cacheFs;
    const layout = cacheLayout(dir, 'abcdef0123456789');
    // Multibyte text, so raw-byte and re-encoded hashing must agree on it
    const { acceptedContentHash } = await writeAccepted(layout, fs, {
      document: { openapi: '3.1.0', info: { title: 'Ünïcödé ✓', version: '1' }, paths: {} },
      sourceContentHash: hashContent('s'),
      displaySource: 'https://api.example.com/openapi.json',
      title: 't',
      specVersion: '1',
      fetchedAt: 1,
      expected: 'unchecked',
    });
    return { object: objectPath(layout, acceptedContentHash) };
  };

  it('verifies an intact multibyte object as a hit', async () => {
    await seed();
    const result = await readCacheEntry(
      cacheLayout(dir, 'abcdef0123456789'),
      realContext().cacheFs,
    );
    expect(result.kind).toBe('hit');
  });

  it.each([
    [
      'a flipped byte',
      (bytes: Buffer): void => {
        bytes[10] = (bytes[10] ?? 0) ^ 0x01;
      },
    ],
    [
      'an invalid UTF-8 sequence',
      (bytes: Buffer): void => {
        // 0xFF never occurs in UTF-8; decoding would turn it into U+FFFD
        bytes[10] = 0xff;
      },
    ],
    [
      'a truncated multibyte character',
      (bytes: Buffer): void => {
        const at = bytes.indexOf(Buffer.from('✓'));
        bytes[at + 2] = 0x20;
      },
    ],
  ])('still reports %s in the accepted object as corrupt', async (_label, damage) => {
    const { object } = await seed();
    const bytes = await readFile(object);
    damage(bytes);
    await writeFile(object, bytes);
    const result = await readCacheEntry(
      cacheLayout(dir, 'abcdef0123456789'),
      realContext().cacheFs,
    );
    expect(result).toMatchObject({
      kind: 'corrupt',
      reason: expect.stringContaining('does not match its recorded content hash') as string,
    });
  });
});

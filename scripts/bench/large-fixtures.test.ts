import { describe, expect, it } from 'vitest';
import { PREVIEW_NATIVE_FACTOR } from '../../packages/core/src/server/execute/response.ts';
import { DISPLAY_TEXT_MAX } from '../../packages/core/src/spec/sanitize.ts';
import { LARGE_FIXTURES } from './large-fixtures.ts';

describe('large bodies', () => {
  const body = (name: string): string => {
    const fixture = LARGE_FIXTURES.find((candidate) => candidate.name === name);
    const response = fixture?.call?.response as () => unknown;
    return JSON.stringify(response());
  };

  it.each([
    ['large-120kb', 120 * 1024],
    ['large-136kb', 136 * 1024],
    ['large-1mb', 1024 * 1024],
    ['large-1mb-escaped', 1024 * 1024],
    ['large-1mb-unicode', 1024 * 1024],
  ])('%s reaches its size, by less than one row more, every time', (name, bytes) => {
    const text = body(name);
    const size = Buffer.byteLength(text);
    expect(size).toBeGreaterThanOrEqual(bytes);
    expect(size).toBeLessThan(bytes + 2048);
    expect(body(name)).toBe(text);
  });

  it('straddles the size where the preview stops serializing everything', () => {
    // The text preview serializes the whole result below 16 x 8 KiB (jsonPreview)
    const limit = PREVIEW_NATIVE_FACTOR * DISPLAY_TEXT_MAX;
    expect(limit).toBe(128 * 1024);
    expect(Buffer.byteLength(body('large-120kb'))).toBeLessThan(limit);
    expect(Buffer.byteLength(body('large-136kb'))).toBeGreaterThan(limit);
  });
});

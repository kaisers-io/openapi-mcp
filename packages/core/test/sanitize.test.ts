import { describe, expect, it } from 'vitest';
import { TRUNCATION_MARKER, sanitizeSpecText } from '../src/index.ts';

describe('sanitizeSpecText', () => {
  it('returns short clean text unchanged', () => {
    expect(sanitizeSpecText('List all pets', 100)).toBe('List all pets');
  });

  it('strips C0 and C1 control characters', () => {
    expect(sanitizeSpecText('a\u0000b\u0007c\u009Fd', 100)).toBe('abcd');
  });

  it('strips bidi control characters', () => {
    expect(sanitizeSpecText('safe\u202Eevil\u202C text\u2066x\u2069', 100)).toBe('safeevil textx');
  });

  it('collapses tabs and newlines into single spaces and trims', () => {
    expect(sanitizeSpecText('  line one\r\n\tline two\n\nline three  ', 100)).toBe(
      'line one line two line three',
    );
  });

  it('collapses Unicode line and paragraph separators', () => {
    expect(sanitizeSpecText('a\u2028b\u2029c', 100)).toBe('a b c');
  });

  it('truncates to maxLength including the marker', () => {
    const out = sanitizeSpecText('x'.repeat(50), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.startsWith('xxxxxxxx')).toBe(true);
  });

  it('handles empty input', () => {
    expect(sanitizeSpecText('', 10)).toBe('');
  });

  it('does not truncate text exactly at maxLength', () => {
    expect(sanitizeSpecText('y'.repeat(20), 20)).toBe('y'.repeat(20));
  });

  it('hard-cuts without a marker when maxLength is smaller than the marker', () => {
    expect(sanitizeSpecText('abcdefghijklmnop', 4)).toBe('abcd');
    expect(sanitizeSpecText('abcdefghijklmnop', 4)).toHaveLength(4);
  });
});

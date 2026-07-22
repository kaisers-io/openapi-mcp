import { describe, expect, it } from 'vitest';
import {
  DISPLAY_TEXT_MAX,
  TRUNCATION_MARKER,
  sanitizeDisplayText,
  sanitizeSpecText,
} from '../src/index.ts';

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

describe('sanitizeDisplayText', () => {
  it('preserves newlines so multi-line error output keeps its structure', () => {
    expect(sanitizeDisplayText('first\nsecond\nthird', 100)).toBe('first\nsecond\nthird');
  });

  it('normalises CRLF, CR, and Unicode line separators to newlines', () => {
    expect(sanitizeDisplayText('a\r\nb\rc\u2028d\u2029e', 100)).toBe('a\nb\nc\nd\ne');
  });

  it('strips the OSC window-title escape from the M2a review repro', () => {
    expect(sanitizeDisplayText('/paths/~1a\u001B]0;PWNED\u001B\\x/get', 100)).toBe(
      '/paths/~1a]0;PWNED\\x/get',
    );
  });

  it('strips SGR colour escapes', () => {
    expect(sanitizeDisplayText('key\u001B[31mEVIL\u001B[0m', 100)).toBe('key[31mEVIL[0m');
  });

  it('strips C0, C1, and bidi controls but keeps newlines', () => {
    expect(sanitizeDisplayText('a\u0000b\u009Fc\nd\u202Ee', 100)).toBe('abc\nde');
  });

  it('converts tabs to spaces', () => {
    expect(sanitizeDisplayText('a\tb', 100)).toBe('a b');
  });

  it('strips vertical tab and form feed', () => {
    expect(sanitizeDisplayText('a\u000Bb\u000Cc', 100)).toBe('abc');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeDisplayText('  \n padded \n  ', 100)).toBe('padded');
  });

  it('truncates to maxLength including the marker', () => {
    const out = sanitizeDisplayText('x'.repeat(50), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('hard-cuts without a marker when maxLength is smaller than the marker', () => {
    expect(sanitizeDisplayText('abcdefghijklmnop', 4)).toBe('abcd');
  });

  it('handles empty input', () => {
    expect(sanitizeDisplayText('', 10)).toBe('');
  });

  it('exposes a display cap large enough for capped multi-error output', () => {
    expect(DISPLAY_TEXT_MAX).toBe(8192);
  });

  it('differs from sanitizeSpecText exactly in newline handling', () => {
    expect(sanitizeSpecText('a\nb', 100)).toBe('a b');
    expect(sanitizeDisplayText('a\nb', 100)).toBe('a\nb');
  });

  it('does not split an astral code point at the display cap', () => {
    const out = sanitizeDisplayText(`${'a'.repeat(10)}\u{1F600}`, 11);
    // 11 - marker (12) <= marker, so hard-cut at 11 units would land mid-emoji
    // at unit 10/11; the surrogate-safe truncate stops before it.
    expect([...out].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
      true,
    );
  });
});

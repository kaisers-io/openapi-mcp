// Spec text is untrusted input that reaches model context (spec §6.4): strip
// C0/C1 controls (except tab/newline, collapsed below) and Unicode bidi controls.
const CONTROL_AND_BIDI_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// All ECMAScript line terminators plus tab collapse to a single space
const WHITESPACE_RUN_RE = /[\t\r\n\u2028\u2029]+/gu;

// Line terminators that must survive as structure in multi-line display output
const LINE_BREAK_RE = /\r\n|\r|\u2028|\u2029/gu;

export const TRUNCATION_MARKER = '…[truncated]';

// Cap for multi-line human display strings (rendered errors, stack traces).
// Ajv output is already capped at 10 entries; this bounds a single hostile entry.
export const DISPLAY_TEXT_MAX = 8192;

const truncate = (cleaned: string, maxLength: number): string => {
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    // Less room than the marker needs: hard cut, never exceed the cap
    return cleaned.slice(0, maxLength);
  }
  return `${cleaned.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
};

export const sanitizeSpecText = (raw: string, maxLength: number): string => {
  const cleaned = raw.replaceAll(WHITESPACE_RUN_RE, ' ').replaceAll(CONTROL_AND_BIDI_RE, '').trim();
  return truncate(cleaned, maxLength);
};

// Line-preserving variant for human display surfaces. Multi-line error messages
// (Ajv validation output, stack traces) lose their structure under
// sanitizeSpecText, which collapses every line terminator to a space. Newlines
// are safe on a terminal; escape sequences, other controls, and bidi overrides
// are not, so everything except "\n" is stripped or normalised.
export const sanitizeDisplayText = (raw: string, maxLength: number): string => {
  const cleaned = raw
    .replaceAll(LINE_BREAK_RE, '\n')
    .replaceAll('\t', ' ')
    .replaceAll(CONTROL_AND_BIDI_RE, '')
    .trim();
  return truncate(cleaned, maxLength);
};

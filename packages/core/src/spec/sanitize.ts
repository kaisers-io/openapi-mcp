// Spec text is untrusted input that reaches model context (spec §6.4): strip
// C0/C1 controls (except tab/newline, collapsed below) and Unicode bidi controls.
const CONTROL_AND_BIDI_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// All ECMAScript line terminators plus tab collapse to a single space
const WHITESPACE_RUN_RE = /[\t\r\n\u2028\u2029]+/gu;

export const TRUNCATION_MARKER = '…[truncated]';

export const sanitizeSpecText = (raw: string, maxLength: number): string => {
  const cleaned = raw.replaceAll(WHITESPACE_RUN_RE, ' ').replaceAll(CONTROL_AND_BIDI_RE, '').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    // Less room than the marker needs: hard cut, never exceed the cap
    return cleaned.slice(0, maxLength);
  }
  return `${cleaned.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
};

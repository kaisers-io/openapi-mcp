// Spec text is untrusted input that reaches model context: strip
// C0/C1 controls (except tab/newline, collapsed below) and Unicode bidi controls.
const CONTROL_AND_BIDI_RE =
  // oxlint-disable-next-line no-control-regex -- matching control and bidi characters is this regex's purpose (it strips them)
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
  const hardCut = maxLength <= TRUNCATION_MARKER.length;
  const rawEnd = hardCut ? maxLength : maxLength - TRUNCATION_MARKER.length;
  // Never slice between a high and low surrogate: codePointAt(rawEnd - 1) only
  // exceeds 0xffff when the unit at `rawEnd - 1` and the unit at `rawEnd` form
  // a genuine astral pair, so step back one unit to keep it whole.
  const codePoint = rawEnd > 0 ? cleaned.codePointAt(rawEnd - 1) : 0;
  const end = codePoint !== undefined && codePoint > 0xff_ff ? rawEnd - 1 : rawEnd;
  const head = cleaned.slice(0, end);
  return hardCut ? head : `${head}${TRUNCATION_MARKER}`;
};

export const sanitizeSpecText = (raw: string, maxLength: number): string => {
  const cleaned = raw.replaceAll(WHITESPACE_RUN_RE, ' ').replaceAll(CONTROL_AND_BIDI_RE, '').trim();
  return truncate(cleaned, maxLength);
};

// A markdown link `[text](url)` or image `![text](url)` keeps only its text:
// the agent can rarely open a documentation URL, and the URLs were 5.7% of
// the visible GitHub tool list (issue #49). Bounded quantifiers and no nested
// repetition keep the scan linear in the text length.
const MARKDOWN_LINK_RE = /!?\[(?<text>[^[\]\n]{0,256})\]\([^()\s]{0,2048}\)/gu;

export const stripMarkdownLinks = (text: string): string =>
  text.replaceAll(MARKDOWN_LINK_RE, '$<text>');

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

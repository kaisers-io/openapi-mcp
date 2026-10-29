// Spec text is untrusted input that reaches model context: strip
// C0/C1 controls (except tab/newline, collapsed below) and Unicode bidi controls,
// including the Arabic letter mark U+061C.
const CONTROL_AND_BIDI_RE =
  // oxlint-disable-next-line no-control-regex -- matching control and bidi characters is this regex's purpose (it strips them)
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// Non-global, so .test() keeps no lastIndex between calls
const HAS_CONTROL_OR_BIDI_RE = new RegExp(CONTROL_AND_BIDI_RE.source, 'u');

// True when a key or string anywhere in a JSON value holds a character the
// sanitizers strip. For names and values the server sends (enum, const,
// pattern, parameter and property names), where stripping would change the
// request, the caller refuses the schema instead.
export const hasControlOrBidi = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return HAS_CONTROL_OR_BIDI_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasControlOrBidi(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => HAS_CONTROL_OR_BIDI_RE.test(key) || hasControlOrBidi(entry),
    );
  }
  return false;
};

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
// repetition keep the scan linear in the text length. An escaped `\[` is
// literal. A text with any code (a backtick or a `~~~` fence) is left whole:
// there `[label](url)` can be the request syntax an operation expects, and
// telling code from prose would take a Markdown parser (review of #49).
const MARKDOWN_LINK_RE = /(?<!\\)!?\[(?<text>[^[\]\n]{0,256})\]\([^()\s]{0,2048}\)/gu;

export const stripMarkdownLinks = (text: string): string =>
  text.includes('`') || text.includes('~~~') ? text : text.replaceAll(MARKDOWN_LINK_RE, '$<text>');

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

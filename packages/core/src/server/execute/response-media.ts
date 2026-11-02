import type { SequenceKind } from '../../toolgen/media-type.ts';
import { decodeEntities, htmlErrorText } from './html-text.ts';

// The media-type reading of an upstream response for response.ts.
export { isJsonEssence, sequenceKind } from '../../toolgen/media-type.ts';

export const mediaEssence = (contentType: string | undefined): string | undefined => {
  if (contentType === undefined) {
    return undefined;
  }
  const [essence] = contentType.split(';');
  const trimmed = essence === undefined ? '' : essence.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
};

// The readable text of an HTML error body (issue #63), or '' for any other
// media type and for a page with no text
export const readableErrorText = (essence: string | undefined, body: string): string =>
  essence === 'text/html' || essence === 'application/xhtml+xml' ? htmlErrorText(body) : '';

// What each JSON short escape stands for, by its letter's place in SHORT_ESCAPES
const SHORT_ESCAPES = String.raw`"\/bfnrt`;
const SHORT_DECODED = '"\\/\b\f\n\r\t';
const HEX4_RE = /^[0-9a-fA-F]{4}$/u;

// The JSON string escapes of a text decoded left to right, as a regex
// alternation of `\uXXXX` and the short escapes would: every encoder's
// spelling (`\u0026`, `\u003C`, `\/`) reads back as the character it stands
// for, and a backslash that starts no escape stays. A surrogate pair decodes
// as its two units, which then form the pair. A loop over indexOf, because a
// replace callback per escape took three times as long on a 1 MiB body
// dense with escapes. `undefined` when the text has no escape.
const decodeJsonEscapes = (text: string): string | undefined => {
  const parts: string[] = [];
  let copied = 0;
  for (let at = text.indexOf('\\'); at !== -1; at = text.indexOf('\\', at + 1)) {
    const letter = text[at + 1];
    // Never indexOf(''), which is 0: a backslash that ends the text stays
    const short = letter === undefined ? -1 : SHORT_ESCAPES.indexOf(letter);
    const hex = text.slice(at + 2, at + 6);
    if (short !== -1 || (letter === 'u' && HEX4_RE.test(hex))) {
      parts.push(
        text.slice(copied, at),
        short === -1
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : (SHORT_DECODED[short] ?? ''),
      );
      // On the escape's last character, so the search goes on right after it
      at += short === -1 ? 5 : 1;
      copied = at + 1;
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  parts.push(text.slice(copied));
  return parts.join('');
};

// JSON in a JSON string (an echoed request body) escapes twice; a few
// levels cover every plausible nesting and keep the cost bounded. A whole
// JSON or text body is decoded one level more: parsing removes one, so each
// string in it is decoded as far as a parsed string is.
const MAX_JSON_DECODES = 3;
export const MAX_BODY_JSON_DECODES = MAX_JSON_DECODES + 1;

// A text decoded each way an upstream may have escaped a secret in it: as a
// JSON string (repeatedly, `levels` times at most, until nothing is left to
// decode), as markup entities, and as both. A text with neither escape
// character yields nothing.
export const decodedForms = (text: string, levels = MAX_JSON_DECODES): string[] => {
  const json: string[] = [];
  for (let next = decodeJsonEscapes(text); next !== undefined;) {
    json.push(next);
    next = json.length < levels ? decodeJsonEscapes(next) : undefined;
  }
  // Entities after JSON escapes, the order an encoder applies them: Go's
  // encoding/json writes the `&` of an HTML entity as `\u0026`
  const entities = [text, ...json]
    .filter((form) => form.includes('&'))
    .map((form) => decodeEntities(form));
  return [...json, ...entities];
};

// Whether any decoded form of a text, or of any string or key in a parsed
// JSON value, passes `hit`. The parsed strings are decoded as they are: a
// serialization would escape a parsed `\u0026` once more. Iterative, so a
// deeply nested value cannot overflow the stack.
export const someDecodedForm = (value: unknown, hit: (form: string) => boolean): boolean => {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (decodedForms(item).some((form) => hit(form))) {
        return true;
      }
    } else if (Array.isArray(item)) {
      for (const child of item) {
        stack.push(child);
      }
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        stack.push(key, child);
      }
    }
  }
  return false;
};

export const isTextEssence = (essence: string): boolean => essence.startsWith('text/');

// A response in a sequential media type (OAS 3.2.1 §4.14.3.1), read as the
// array of its items in order, the JSON data model the spec maps such a body
// to. The whole body is already in memory and capped at the response budget,
// so this is the "complete content" case, not streaming. Anything malformed
// fails closed: `undefined`, never a partial array.

// JSON Lines and NDJSON: one JSON text per line. A blank line carries no
// item (NDJSON lets a parser ignore it), and a CR before the LF is allowed.
const parseJsonLines = (text: string): unknown[] | undefined => {
  const items: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      items.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return items;
};

const RECORD_SEPARATOR = '\u001E';

// JSON text sequences (RFC 7464 §2): each item is RS, a JSON text, LF.
// Consecutive RS octets denote no item (§2.1). A record without its closing
// LF may be truncated (§2.4), and text before the first RS belongs to no
// record, so both fail closed rather than being skipped.
const parseJsonSeq = (text: string): unknown[] | undefined => {
  const [leading = '', ...records] = text.split(RECORD_SEPARATOR);
  if (leading !== '') {
    return undefined;
  }
  const items: unknown[] = [];
  for (const record of records) {
    if (record === '') {
      continue;
    }
    if (!record.endsWith('\n')) {
      return undefined;
    }
    try {
      items.push(JSON.parse(record));
    } catch {
      return undefined;
    }
  }
  return items;
};

type ServerSentEvent = { data: string; event?: string; id?: string; retry?: number };

// Server-Sent Events, parsed as the HTML Standard's event stream
// interpretation (§9.2.6) prescribes, which OAS 3.2.1 §4.14.4 requires:
// lines end in CRLF, LF or CR; a line starting with ":" is a comment;
// `data` lines join with LF; unknown fields are ignored; `retry` counts only
// when it is all ASCII digits, as an integer; an `id` containing NULL is
// ignored; a block without data dispatches nothing; an event not closed by
// a blank line before the end is discarded, also when the body ends in a
// single line end. Each item carries the fields its own block set, as in the
// spec's JSON Lines equivalent (§4.14.6.3), so the stream-level last event ID
// is not repeated on later events.
const parseEventStream = (text: string): ServerSentEvent[] => {
  const events: ServerSentEvent[] = [];
  let data: string[] = [];
  let fields: Omit<ServerSentEvent, 'data'> = {};
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  // The last piece follows the last line end: an unterminated line, or ''
  // when the body ends in a line end. Neither is a blank line, so it never
  // dispatches; what is still pending at the end is discarded.
  for (const line of body.split(/\r\n|\r|\n/u).slice(0, -1)) {
    if (line === '') {
      if (data.length > 0) {
        events.push({ data: data.join('\n'), ...fields });
      }
      data = [];
      fields = {};
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (name === 'data') {
      data.push(value);
    } else if (name === 'event') {
      fields.event = value;
    } else if (name === 'id' && !value.includes('\u0000')) {
      fields.id = value;
    } else if (name === 'retry' && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) {
      fields.retry = Number(value);
    }
  }
  return events;
};

export const parseSequence = (text: string, kind: SequenceKind): unknown[] | undefined => {
  if (kind === 'json-lines') {
    return parseJsonLines(text);
  }
  if (kind === 'json-seq') {
    return parseJsonSeq(text);
  }
  return parseEventStream(text);
};

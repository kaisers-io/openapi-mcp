import type { SequenceKind } from '../../toolgen/media-type.ts';
import { htmlErrorText } from './html-text.ts';

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

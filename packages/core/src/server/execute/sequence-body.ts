import type { SequenceKind } from '../../toolgen/media-type.ts';

// A request body in a sequential media type (OpenAPI 3.2, issue #33): the
// `body` argument is the array of items, written in the media type's own
// framing. The inverse of the response-side reading in response-media.ts.

const EVENT_FIELDS: ReadonlySet<string> = new Set(['data', 'event', 'id', 'retry']);

// Server-Sent Events (HTML Standard §9.2.5): one block per event, a `data`
// line per line of the data, closed by a blank line. `event` and `id` are
// single-line fields, so a line break in them would start another field:
// refused, as are a NULL in `id` (the receiver ignores such an id), a
// `retry` that is not a non-negative integer, and any other key, which the
// receiver would drop without a trace.
const eventBlock = (item: unknown, index: number): string | { error: string } => {
  const where = `event ${String(index)}`;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { error: `${where} of the event-stream body must be an object` };
  }
  const event = item as Record<string, unknown>;
  const unknown = Object.keys(event).find((key) => !EVENT_FIELDS.has(key));
  if (unknown !== undefined) {
    return {
      error: `${where} of the event-stream body has a field other than data, event, id and retry`,
    };
  }
  const { data, event: type, id, retry } = event;
  if (typeof data !== 'string') {
    return { error: `${where} of the event-stream body needs a string "data"` };
  }
  const lines: string[] = [];
  for (const [name, value] of [
    ['event', type],
    ['id', id],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== 'string' ||
      /[\r\n]/u.test(value) ||
      (name === 'id' && value.includes('\u0000'))
    ) {
      return { error: `${where} of the event-stream body has an invalid "${name}"` };
    }
    lines.push(`${name}: ${value}`);
  }
  if (retry !== undefined) {
    if (typeof retry !== 'number' || !Number.isSafeInteger(retry) || retry < 0) {
      return { error: `${where} of the event-stream body has an invalid "retry"` };
    }
    lines.push(`retry: ${String(retry)}`);
  }
  for (const line of data.split(/\r\n|\r|\n/u)) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
};

export const sequenceBody = (
  payload: unknown,
  kind: SequenceKind,
): { ok: Uint8Array } | { error: string } => {
  if (!Array.isArray(payload)) {
    return { error: 'a sequential request body must be an array of its items' };
  }
  const chunks: string[] = [];
  for (const [index, item] of payload.entries()) {
    if (kind === 'event-stream') {
      const block = eventBlock(item, index);
      if (typeof block !== 'string') {
        return block;
      }
      chunks.push(block);
      continue;
    }
    // JSON never serializes a raw line break, so each item stays on its line
    const json = JSON.stringify(item) as string | undefined;
    if (json === undefined) {
      return { error: `item ${String(index)} of the request body could not be serialized to JSON` };
    }
    // JSON Lines and NDJSON: one line per item. JSON text sequences
    // (RFC 7464 §2): RS, the JSON text, LF.
    chunks.push(kind === 'json-seq' ? `\u001E${json}\n` : `${json}\n`);
  }
  return { ok: new TextEncoder().encode(chunks.join('')) };
};

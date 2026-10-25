// Media-type keys of a request body's `content` map are spec-controlled text
// that ends up VERBATIM in the outgoing Content-Type header (it is
// sent as declared, parameters included). Only a key that is a
// syntactically valid media type per RFC 9110 §8.3.1 is ever selected:
//   media-type = type "/" subtype parameters
//   parameters = *( OWS ";" OWS [ parameter ] )
//   parameter  = parameter-name "=" parameter-value
//   parameter-value = ( token / quoted-string )
// Stricter than the grammar on purpose (fail-closed): an empty parameter
// (`application/json;`) and a quoted-pair (`\x`) inside a quoted-string are
// rejected, and only visible ASCII, space and tab are admitted — so a key can
// never smuggle CR/LF or non-ASCII bytes into a header.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = String.raw`"[\t !#-\[\]-~]*"`;
const PARAMETER = String.raw`[ \t]*;[ \t]*${TOKEN}=(?:${TOKEN}|${QUOTED})`;
const MEDIA_TYPE_RE = new RegExp(String.raw`^(${TOKEN}/${TOKEN})((?:${PARAMETER})*)[ \t]*$`, 'u');

export type MediaType = {
  // The lowercased `type/subtype` (media types are case-insensitive,
  // RFC 9110 §8.3.1).
  essence: string;
  hasParameters: boolean;
};

export const parseMediaType = (value: string): MediaType | undefined => {
  const match = MEDIA_TYPE_RE.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, essence = '', parameters = ''] = match;
  return { essence: essence.toLowerCase(), hasParameters: parameters !== '' };
};

// `application/json` itself or any structured-syntax `+json` suffix type
// (RFC 6839 §3.1), e.g. application/merge-patch+json (RFC 7396),
// application/json-patch+json (RFC 6902), application/vnd.api+json. Matches
// the response side's essence test (output-schema.ts / response.ts).
const JSON_ESSENCE_RE = /^application\/(?:[\w.+-]+\+)?json$/u;
export const isJsonEssence = (essence: string): boolean => JSON_ESSENCE_RE.test(essence);

// Sequential media types (OAS 3.2.1 §4.14.3.1): a repeating structure with
// no envelope, mapped to the JSON data model as an array of its items. JSON
// Lines, NDJSON and JSON text sequences (RFC 7464, with the `+json-seq`
// suffix of RFC 8091) repeat JSON values; Server-Sent Events repeat events.
// multipart/mixed is not mapped.
const JSON_SEQUENCE_RE = /^application\/(?:jsonl|x-ndjson|json-seq|[\w.+-]+\+json-seq)$/u;
export type SequenceKind = 'json-lines' | 'json-seq' | 'event-stream';
export const sequenceKind = (essence: string): SequenceKind | undefined => {
  if (essence === 'text/event-stream') {
    return 'event-stream';
  }
  if (!JSON_SEQUENCE_RE.test(essence)) {
    return undefined;
  }
  return essence.endsWith('json-seq') ? 'json-seq' : 'json-lines';
};

export const FORM_URLENCODED = 'application/x-www-form-urlencoded';

export const OCTET_STREAM = 'application/octet-stream';
// Image types a request body can carry as raw bytes (#29), like an
// octet-stream body; the four the server can recognise by their bytes
export const RAW_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export const isRawBinaryEssence = (essence: string | undefined): boolean =>
  essence === OCTET_STREAM || (essence !== undefined && RAW_IMAGE_TYPES.has(essence));
export const MULTIPART_FORM_DATA = 'multipart/form-data';

// A multipart part name goes into a quoted `Content-Disposition` parameter
// (RFC 7578 §4.2). Only visible ASCII and space, without `"` or `\`, can be
// written there unambiguously without an escaping convention the receiver
// may not share — anything else is rejected (fail-closed).
export const isSafePartName = (name: string): boolean => /^[ !#-[\]-~]+$/u.test(name);

// Strict RFC 4648 §4 base64: standard alphabet, canonical `=` padding, no
// whitespace or line breaks, and canonical trailing bits (§3.5: `QR==`, which
// decodes to the same byte as `QQ==`, is rejected). Checked by a round trip:
// Node's decoder is lenient (it skips invalid characters and whitespace), so
// any input it had to skip or reinterpret re-encodes differently. Linear in
// the input with constant stack depth — a regex with a quantified group
// overflowed V8's stack above ~4.47M characters (~3.2 MiB decoded), well
// under the default 10 MB body budget. Used both to validate the tool input
// and, defensively, again before decoding it.
export const isStrictBase64 = (value: string): boolean =>
  value.length % 4 === 0 && Buffer.from(value, 'base64').toString('base64') === value;

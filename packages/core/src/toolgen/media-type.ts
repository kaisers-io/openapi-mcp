// Media-type keys of a request body's `content` map are spec-controlled text
// that ends up VERBATIM in the outgoing Content-Type header (decision D5:
// send the declared media type, parameters included). Only a key that is a
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

export const FORM_URLENCODED = 'application/x-www-form-urlencoded';

export const OCTET_STREAM = 'application/octet-stream';

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

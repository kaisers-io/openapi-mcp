// The `Accept` header for an upstream call, derived from the media types the
// operation declares for its success responses. Without one, undici sends
// `accept: */*`, and a content-negotiating API is then free to answer with
// its default representation (often XML or HTML), which fails the tool's
// JSON output branch even though the API could have answered in JSON.
//
// Declared JSON types come first at the default weight, other declared
// types follow at q=0.9 (this server can only structure JSON), and a final
// `*/*;q=0.1` keeps a server that cannot match any of them answering with
// something — a descriptive tool error beats an opaque 406. An operation
// that declares no success media type at all asks for JSON first.
//
// Media types come from the (untrusted) spec, so only a bare `type/subtype`
// essence made of RFC 9110 token characters is ever copied into the header:
// parameters are dropped, anything else is skipped, and the list is capped.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// RFC 9110 §5.6.2 tchar, for both halves of a media range (`*` is a tchar).
const MEDIA_RANGE_RE = /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/u;
// Mirrors toolgen/output-schema.ts's and response.ts's JSON essence test.
const JSON_ESSENCE_RE = /^application\/(?:[\w.+-]+\+)?json$/u;
// 2xx statuses and the OpenAPI 3.1 `2XX` range key; `default` may describe
// errors, so it does not steer content negotiation.
const SUCCESS_KEY_RE = /^2(?:\d\d|xx)$/iu;
const MAX_ACCEPTED_TYPES = 16;

export const FALLBACK_ACCEPT = 'application/json, */*;q=0.1';

const declaredSuccessTypes = (responses: Readonly<Record<string, unknown>>): string[] => {
  const types = new Set<string>();
  for (const [status, response] of Object.entries(responses)) {
    if (!SUCCESS_KEY_RE.test(status) || !isRecord(response) || !isRecord(response['content'])) {
      continue;
    }
    for (const mediaType of Object.keys(response['content'])) {
      const essence = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
      if (MEDIA_RANGE_RE.test(essence) && types.size < MAX_ACCEPTED_TYPES) {
        types.add(essence);
      }
    }
  }
  return [...types];
};

export const deriveAccept = (responses: Readonly<Record<string, unknown>>): string => {
  const declared = declaredSuccessTypes(responses).filter((type) => type !== '*/*');
  if (declared.length === 0) {
    return FALLBACK_ACCEPT;
  }
  const json = declared.filter((type) => JSON_ESSENCE_RE.test(type));
  const other = declared
    .filter((type) => !JSON_ESSENCE_RE.test(type))
    .map((type) => `${type};q=0.9`);
  return [...json, ...other, '*/*;q=0.1'].join(', ');
};

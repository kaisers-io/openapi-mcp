import { randomBytes } from 'node:crypto';
import { HEADER_NAME_RE, NON_LATIN1_RE } from '../../http/headers.ts';
import {
  FORM_URLENCODED,
  isJsonEssence,
  isSafePartName,
  isStrictBase64,
  MULTIPART_FORM_DATA,
  OCTET_STREAM,
  parseMediaType,
  sequenceKind,
} from '../../toolgen/media-type.ts';
import type { SequenceKind } from '../../toolgen/media-type.ts';
import { isDangerousKey } from '../../toolgen/schema.ts';
import { sequenceBody } from './sequence-body.ts';
import type { FieldMapping, RequestMapper } from '../../toolgen/layout.ts';

// Outbound resource budgets the caller enforces on the request THIS module
// builds — path+query length, aggregate tool-arg header bytes, and body
// bytes. The final URL (base URL + this pathname/query) and the full header
// set (incl. auth) are re-budgeted by the executor; this module only bounds
// the components it itself produces.
export type OutboundBudgets = {
  maxUrlLength: number;
  maxHeaderBytes: number;
  maxBodyBytes: number;
};

export type BuiltRequest = {
  pathname: string;
  query: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  contentType?: string;
};

export type BuildRequestResult = { ok: BuiltRequest } | { error: string };

type Primitive = string | number | boolean;

const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

type Shape =
  | { kind: 'primitive'; value: Primitive }
  | { kind: 'array'; values: readonly Primitive[] }
  | { kind: 'object'; entries: readonly (readonly [string, Primitive])[] };

// The mapper only ever emits path/simple, query/form|deepObject|
// spaceDelimited|pipeDelimited, header/simple — and those styles are DEFINED
// only for a primitive, an array-of-primitives, or a flat object-of-primitives. Our Zod schemas do not prevent a nested object
// or array-of-objects from reaching here, so this guard fails closed rather
// than ever emitting `[object Object]` onto the wire.
const classifyShape = (value: unknown): Shape | undefined => {
  if (isPrimitive(value)) {
    return { kind: 'primitive', value };
  }
  if (Array.isArray(value)) {
    return value.every((item) => isPrimitive(item)) ? { kind: 'array', values: value } : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    return entries.every(([, entryValue]) => isPrimitive(entryValue))
      ? { kind: 'object', entries: entries as readonly (readonly [string, Primitive])[] }
      : undefined;
  }
  return undefined;
};

// RFC 3986 §2.1-2.4 element-wise percent-encoding: encode each leaf BEFORE
// joining with a style's literal delimiter, never the whole serialized
// string — never `URLSearchParams` for the query, it emits `+` for space and
// over-encodes `~`. `encodeURIComponent` throws on a lone UTF-16 surrogate;
// treat that as an encode failure rather than letting it crash the caller.
const encodeLeaf = (raw: string): string | undefined => {
  try {
    return encodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

// A caller-supplied path leaf is dangerous — independent of encoding — when
// its RAW text is a dot-segment, or would let a single upstream
// percent-decode (or a naive double-decode) reintroduce a path separator.
// `encodeURIComponent` always encodes '/', '\\', and the '%' character
// itself, so a literal separator or an already-percent-encoded
// separator/dot-dot typed by the caller is caught here BEFORE we ever encode
// it. The static half of the path template is already vetted at build time
// (toolgen/layout.ts's `isDangerousStaticSegment`) — this only guards the
// dynamic VALUE.
// An encoded dot counts the same as a literal one for that double-decode:
// `.%2e`, `%2e.` and `%2e%2e` all become `..`, and a lone `%2e` becomes `.`,
// so any dot pair involving at least one `%2e`, and a leaf that is nothing
// but one encoded dot, are refused alike.
const ENCODED_DOT_PAIR_RE = /%2e%2e|\.%2e|%2e\./u;

const isDangerousPathLeaf = (raw: string): boolean => {
  if (raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    return true;
  }
  const lower = raw.toLowerCase();
  return (
    lower.includes('%2f') ||
    lower.includes('%5c') ||
    lower === '%2e' ||
    ENCODED_DOT_PAIR_RE.test(lower)
  );
};

type PathMapping = Extract<FieldMapping, { destination: 'path' }>;

const serializePathValue = (
  mapping: PathMapping,
  value: unknown,
): { ok: string } | { error: string } => {
  const shape = classifyShape(value);
  if (shape === undefined) {
    return {
      error: `path parameter "${mapping.wireName}" has a value shape that cannot be serialized`,
    };
  }
  const leaf = (raw: string): { ok: string } | { error: string } => {
    if (isDangerousPathLeaf(raw)) {
      return {
        error: `path parameter "${mapping.wireName}" was refused: it contains a path separator or dot-segment (/, \\, . or .., or an encoded slash or dot such as %2F, %5C or %2E). No request was sent; pass the value without them`,
      };
    }
    const encoded = encodeLeaf(raw);
    return encoded === undefined
      ? { error: `path parameter "${mapping.wireName}" could not be encoded` }
      : { ok: encoded };
  };
  // Imperative on purpose: each per-leaf `leaf()` call below can fail (a
  // dangerous segment, an unencodable value), and the array/object branches
  // must stop at the FIRST failing leaf rather than encoding every remaining
  // one — `shape.values`/`shape.entries` come from a caller-supplied tool
  // argument, so an eager map/reduce that encodes every leaf before checking
  // for an error would do unbounded extra work on a large hostile array
  // before ever reporting the failure. `segment` still needs a `let` because
  // exactly one of the three branches below produces it.
  let segment: string;
  if (shape.kind === 'primitive') {
    const result = leaf(String(shape.value));
    if ('error' in result) {
      return result;
    }
    segment = result.ok;
  } else if (shape.kind === 'array') {
    const parts: string[] = [];
    for (const item of shape.values) {
      const result = leaf(String(item));
      if ('error' in result) {
        return result;
      }
      parts.push(result.ok);
    }
    segment = parts.join(',');
  } else {
    const parts: string[] = [];
    for (const [key, val] of shape.entries) {
      const keyResult = leaf(key);
      if ('error' in keyResult) {
        return keyResult;
      }
      const valResult = leaf(String(val));
      if ('error' in valResult) {
        return valResult;
      }
      if (mapping.explode) {
        parts.push(`${keyResult.ok}=${valResult.ok}`);
      } else {
        parts.push(keyResult.ok, valResult.ok);
      }
    }
    segment = parts.join(',');
  }
  // A required path value (path params are ALWAYS required) that serializes
  // to '' would produce `//`, silently changing the request's path
  // semantics.
  if (segment === '') {
    return { error: `path parameter "${mapping.wireName}" must not be empty` };
  }
  return { ok: segment };
};

type QueryPair = {
  key: string;
  value: string;
};

type QueryMapping = Extract<FieldMapping, { destination: 'query' }>;

// One form-urlencoded component: the serializer of a single `=value` pair
const formEncode = (raw: string): string => new URLSearchParams([['', raw]]).toString().slice(1);

// OpenAPI 3.2 `in: querystring` with application/x-www-form-urlencoded
// (issue #33): the object's entries ARE the query string, encoded as a form
// (WHATWG application/x-www-form-urlencoded, `+` for space), the encoding the
// media type names. Scalars only, like a form body; an absent or null entry
// is left out. A lone surrogate fails closed rather than being silently
// replaced with U+FFFD, as for every other query leaf.
const serializeQuerystringValue = (
  wireName: string,
  value: unknown,
): { ok: QueryPair[] } | { error: string } => {
  if (!isPlainObject(value)) {
    return { error: `querystring parameter "${wireName}" must be an object` };
  }
  const pairs: QueryPair[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    if (!isPrimitive(entry)) {
      return {
        error: `querystring parameter "${wireName}" has a value for "${key}" that cannot be form-urlencoded`,
      };
    }
    const text = String(entry);
    if (!key.isWellFormed() || !text.isWellFormed()) {
      return { error: `querystring parameter "${wireName}" could not be encoded` };
    }
    pairs.push({ key: formEncode(key), value: formEncode(text) });
  }
  return { ok: pairs };
};

type Encoder = (raw: string) => { ok: string } | { error: string };

// The deepObject style (OAS 3.1.1 §4.8.12.4): `name[key]=value` per property, with the
// brackets percent-encoded exactly as in the spec's example
// (`?color%5BR%5D=100&color%5BG%5D=200`). Key and value are encoded leaf-wise
// like every other query leaf, so `&`, `=`, `#` inside them can never start a
// new parameter. Only an object of scalars is defined; anything else fails
// closed (a nested value is already rejected by classifyShape). A key that
// contains `[` or `]` is rejected as ambiguous: it would encode to `%5B`/`%5D`,
// the very bytes of the structural brackets, so `{"a][b": v}` would reach a
// bracket-parsing server (Rails/Rack, PHP, qs) as the NESTED `name[a][b]`.
const serializeDeepObject = (
  mapping: QueryMapping,
  wireKey: string,
  shape: Shape,
  enc: Encoder,
): { ok: readonly QueryPair[] } | { error: string } => {
  if (shape.kind !== 'object') {
    return { error: `query parameter "${mapping.wireName}" (deepObject) must be an object` };
  }
  // Imperative on purpose: same first-failure rationale as serializeQueryValue.
  const pairs: QueryPair[] = [];
  for (const [key, val] of shape.entries) {
    if (key.includes('[') || key.includes(']')) {
      return {
        error: `query parameter "${mapping.wireName}" (deepObject) has a key containing "[" or "]", which is ambiguous with nesting; use keys without brackets`,
      };
    }
    const keyResult = enc(key);
    if ('error' in keyResult) {
      return keyResult;
    }
    const valResult = enc(String(val));
    if ('error' in valResult) {
      return valResult;
    }
    pairs.push({ key: `${wireKey}%5B${keyResult.ok}%5D`, value: valResult.ok });
  }
  return { ok: pairs };
};

const DELIMITERS: Readonly<
  Record<'spaceDelimited' | 'pipeDelimited', { raw: string; wire: string }>
> = {
  spaceDelimited: { raw: ' ', wire: '%20' },
  pipeDelimited: { raw: '|', wire: '%7C' },
};

// The spaceDelimited / pipeDelimited styles with explode=false (the only defined form,
// OAS 3.1.1 §4.8.12.4): one key, array items or object k,v,k,v joined by the
// PERCENT-ENCODED delimiter (`%20` / `%7C`, as in the spec's examples). A leaf
// that itself contains the raw delimiter would encode to the very same bytes
// and make the list ambiguous, so it is rejected rather than sent.
const serializeDelimited = (
  mapping: QueryMapping,
  style: 'spaceDelimited' | 'pipeDelimited',
  wireKey: string,
  shape: Shape,
  enc: Encoder,
): { ok: readonly QueryPair[] } | { error: string } => {
  const delimiter = DELIMITERS[style];
  if (shape.kind === 'primitive') {
    return {
      error: `query parameter "${mapping.wireName}" (${style}) must be an array or object`,
    };
  }
  const leaves =
    shape.kind === 'array'
      ? shape.values.map(String)
      : shape.entries.flatMap(([key, val]) => [key, String(val)]);
  // An empty array/object sends nothing, like `form` does: `ids=` would read
  // as "filter by the empty string" on many APIs, not as "no filter".
  if (leaves.length === 0) {
    return { ok: [] };
  }
  // Flattening to raw strings is a cheap O(n) copy; the per-leaf ENCODING
  // below stops at the first failure (same rationale as serializeQueryValue).
  const parts: string[] = [];
  for (const leaf of leaves) {
    if (leaf.includes(delimiter.raw)) {
      return {
        error: `query parameter "${mapping.wireName}" contains its own ${style} delimiter, which is ambiguous`,
      };
    }
    const result = enc(leaf);
    if ('error' in result) {
      return result;
    }
    parts.push(result.ok);
  }
  return { ok: [{ key: wireKey, value: parts.join(delimiter.wire) }] };
};

const serializeQueryValue = (
  mapping: QueryMapping,
  value: unknown,
): { ok: readonly QueryPair[] } | { error: string } => {
  const shape = classifyShape(value);
  if (shape === undefined) {
    return {
      error: `query parameter "${mapping.wireName}" has a value shape that cannot be serialized`,
    };
  }
  const enc = (raw: string): { ok: string } | { error: string } => {
    const encoded = encodeLeaf(raw);
    return encoded === undefined
      ? { error: `query parameter "${mapping.wireName}" could not be encoded` }
      : { ok: encoded };
  };
  const wireKey = enc(mapping.wireName);
  if ('error' in wireKey) {
    return wireKey;
  }
  if (mapping.style === 'deepObject') {
    return serializeDeepObject(mapping, wireKey.ok, shape, enc);
  }
  if (mapping.style === 'spaceDelimited' || mapping.style === 'pipeDelimited') {
    return serializeDelimited(mapping, mapping.style, wireKey.ok, shape, enc);
  }
  // Imperative on purpose (applies to every per-leaf loop below): `enc()`
  // can fail per leaf, and the array/object branches must stop at the FIRST
  // failing leaf — `shape.values`/`shape.entries` come from a caller-supplied
  // tool argument, so eagerly encoding every remaining leaf via map/reduce
  // before surfacing an error would do unbounded extra work on hostile input.
  if (shape.kind === 'primitive') {
    const result = enc(String(shape.value));
    if ('error' in result) {
      return result;
    }
    return { ok: [{ key: wireKey.ok, value: result.ok }] };
  }
  if (shape.kind === 'array') {
    const encoded: string[] = [];
    for (const item of shape.values) {
      const result = enc(String(item));
      if ('error' in result) {
        return result;
      }
      encoded.push(result.ok);
    }
    // Form + explode=true -> a repeated key; form + explode=false -> a single
    // comma-joined key.
    return mapping.explode
      ? { ok: encoded.map((item) => ({ key: wireKey.ok, value: item })) }
      : { ok: [{ key: wireKey.ok, value: encoded.join(',') }] };
  }
  // Shape.kind === 'object'. Form + explode=true -> the object's OWN property
  // names become top-level query keys (the field's wireName disappears);
  // form + explode=false -> a single key with a flat k,v,k,v list.
  if (mapping.explode) {
    const pairs: QueryPair[] = [];
    for (const [key, val] of shape.entries) {
      const keyResult = enc(key);
      if ('error' in keyResult) {
        return keyResult;
      }
      const valResult = enc(String(val));
      if ('error' in valResult) {
        return valResult;
      }
      pairs.push({ key: keyResult.ok, value: valResult.ok });
    }
    return { ok: pairs };
  }
  const parts: string[] = [];
  for (const [key, val] of shape.entries) {
    const keyResult = enc(key);
    if ('error' in keyResult) {
      return keyResult;
    }
    const valResult = enc(String(val));
    if ('error' in valResult) {
      return valResult;
    }
    parts.push(keyResult.ok, valResult.ok);
  }
  return { ok: [{ key: wireKey.ok, value: parts.join(',') }] };
};

type HeaderMapping = Extract<FieldMapping, { destination: 'header' }>;

// Mirrors http/headers.ts's CONTROL_CHAR_RE (not exported there): any C0
// control or DEL in a header value is a request-smuggling vector. A header
// value has no percent-encoding layer, so a control character must be
// rejected outright — never stripped, never encoded.
// oxlint-disable-next-line no-control-regex -- matching control characters is this regex's purpose (it rejects them outright)
const HEADER_CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;
// NON_LATIN1_RE (http/headers.ts): a header value travels as bytes, so a
// code point above U+00FF cannot be represented, and the transport would
// only throw later as an opaque network failure — after the request was
// prepared — so it is refused here as an argument error the caller can fix.

// `mapping.wireName` is spec-derived, untrusted text (the header parameter's
// NAME, not its value). The undici transport THROWS at fetch time on a
// header key outside the RFC 9110 token grammar — e.g. one carrying an
// embedded CR/LF — which would turn this module's fail-closed `{error}`
// contract into an uncaught throw past its boundary. Reject it here instead.
const serializeHeaderValue = (
  mapping: HeaderMapping,
  value: unknown,
): { ok: string } | { error: string } => {
  if (!HEADER_NAME_RE.test(mapping.wireName)) {
    return { error: `header parameter "${mapping.wireName}" has an invalid header name` };
  }
  const shape = classifyShape(value);
  if (shape === undefined) {
    return {
      error: `header parameter "${mapping.wireName}" has a value shape that cannot be serialized`,
    };
  }
  const clean = (
    raw: string,
    delimiters: readonly string[],
  ): { ok: string } | { error: string } => {
    if (HEADER_CONTROL_CHAR_RE.test(raw)) {
      return { error: `header parameter "${mapping.wireName}" contains a control character` };
    }
    if (NON_LATIN1_RE.test(raw)) {
      return {
        error: `header parameter "${mapping.wireName}" was refused: it contains a character above U+00FF, which an HTTP header cannot carry. No request was sent; use Latin-1 text only (ASCII is safest)`,
      };
    }
    if (delimiters.some((delimiter) => raw.includes(delimiter))) {
      return {
        error: `header parameter "${mapping.wireName}" contains its own style delimiter, which is ambiguous`,
      };
    }
    return { ok: raw };
  };
  // Imperative on purpose: same rationale as serializePathValue/
  // serializeQueryValue above — `clean()` can fail per leaf, and the
  // array/object branches must stop at the FIRST failing leaf rather than
  // validating every remaining one in a caller-supplied array/object.
  if (shape.kind === 'primitive') {
    return clean(String(shape.value), []);
  }
  if (shape.kind === 'array') {
    const parts: string[] = [];
    for (const item of shape.values) {
      const result = clean(String(item), [',']);
      if ('error' in result) {
        return result;
      }
      parts.push(result.ok);
    }
    return { ok: parts.join(',') };
  }
  // Shape.kind === 'object'. `simple` always joins pairs with ','; an
  // exploded object additionally joins each key/value with '=', so both
  // characters are ambiguous delimiters in that case.
  const delimiters = mapping.explode ? [',', '='] : [','];
  const parts: string[] = [];
  for (const [key, val] of shape.entries) {
    const keyResult = clean(key, delimiters);
    if ('error' in keyResult) {
      return keyResult;
    }
    const valResult = clean(String(val), delimiters);
    if ('error' in valResult) {
      return valResult;
    }
    if (mapping.explode) {
      parts.push(`${keyResult.ok}=${valResult.ok}`);
    } else {
      parts.push(keyResult.ok, valResult.ok);
    }
  }
  return { ok: parts.join(',') };
};

type BodyMapping = Extract<FieldMapping, { destination: 'body' }>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Reassembles the flattened body fields into one object by walking each
// field's `bodyPath` (today always length 1, but walked in full so it
// survives any future nesting). `isDangerousKey` (toolgen/schema.ts) guards
// every segment against prototype pollution BEFORE the assignment, mirroring
// layout.ts's own field-name gate.
const buildBodyObject = (
  bodyFieldEntries: readonly (readonly [string, BodyMapping])[],
  data: Record<string, unknown>,
): { object: Record<string, unknown>; anyPresent: boolean } | { error: string } => {
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let anyPresent = false;
  // Imperative on purpose: this walks and MUTATES a nested chain of freshly
  // created (never caller-visible) objects to reassemble the flattened body
  // fields, checking `isDangerousKey` on every segment BEFORE writing it — a
  // fail-fast prototype-pollution guard that must run per segment, in path
  // order, before any write. A pure rebuild would still need to reconstruct
  // the same mutable-pointer walk internally; doing it directly here keeps
  // the check-then-write order visible.
  for (const [name, mapping] of bodyFieldEntries) {
    const value = data[name];
    if (value === undefined) {
      continue;
    }
    anyPresent = true;
    if (mapping.bodyPath.length === 0) {
      return { error: `body field "${name}" has no destination path` };
    }
    let target = root;
    for (let index = 0; index < mapping.bodyPath.length - 1; index += 1) {
      const segment = mapping.bodyPath[index]!;
      if (isDangerousKey(segment)) {
        return { error: `body field "${name}" has an unsafe path segment` };
      }
      const existing = target[segment];
      const next = isPlainObject(existing)
        ? existing
        : (Object.create(null) as Record<string, unknown>);
      target[segment] = next;
      target = next;
    }
    const last = mapping.bodyPath.at(-1)!;
    if (isDangerousKey(last)) {
      return { error: `body field "${name}" has an unsafe path segment` };
    }
    target[last] = value;
  }
  return { object: root, anyPresent };
};

// `JSON.stringify` throws on a bigint, a circular reference, or a throwing
// `toJSON` — any of which would otherwise escape this module's never-throw
// `{ok}|{error}` contract. Fail closed instead.
const jsonBody = (value: unknown): { ok: Uint8Array } | { error: string } => {
  try {
    return { ok: new TextEncoder().encode(JSON.stringify(value)) };
  } catch {
    return { error: 'the request body could not be serialized to JSON' };
  }
};

const formBody = (value: Record<string, unknown>): { ok: Uint8Array } | { error: string } => {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) {
      continue;
    }
    if (!isPrimitive(val)) {
      return { error: `body field "${key}" has a value that cannot be form-urlencoded` };
    }
    params.append(key, String(val));
  }
  return { ok: new TextEncoder().encode(params.toString()) };
};

type SerializedBody = {
  body?: Uint8Array;
  contentType?: string;
};

const bodyEncoding = (
  contentType: string,
): 'json' | 'form' | 'binary' | 'multipart' | SequenceKind | undefined => {
  const essence = parseMediaType(contentType)?.essence;
  if (essence !== undefined && isJsonEssence(essence)) {
    return 'json';
  }
  const sequence = essence === undefined ? undefined : sequenceKind(essence);
  if (sequence !== undefined) {
    return sequence;
  }
  if (essence === OCTET_STREAM) {
    return 'binary';
  }
  if (essence === MULTIPART_FORM_DATA) {
    return 'multipart';
  }
  return essence === FORM_URLENCODED ? 'form' : undefined;
};

// An octet-stream body arrives as a base64 string (see layout.ts) and is sent
// as the decoded bytes. Re-validated strictly here — Node's base64 decoder is
// lenient (it skips invalid characters), so decoding unvalidated text could
// silently send different bytes than the caller encoded.
const binaryBody = (payload: unknown): { ok: Uint8Array } | { error: string } =>
  typeof payload === 'string' && isStrictBase64(payload)
    ? { ok: new Uint8Array(Buffer.from(payload, 'base64')) }
    : { error: 'an application/octet-stream body must be a valid base64 string' };

// The multipart/form-data encoding (RFC 7578): one part per top-level body property.
// Text parts carry the scalar's string form as UTF-8 with no part
// Content-Type (§4.4 default text/plain); binary parts (mapping.binary) carry
// the decoded base64 bytes as `application/octet-stream` with a filename
// (§4.2), which most servers require to treat a part as a file. The boundary
// is 192 random bits, generated per request; a part that happens to contain
// the delimiter fails closed rather than producing an ambiguous body.
const multipartBody = (
  payload: Record<string, unknown>,
  // File part name -> its Content-Type.
  binaryParts: ReadonlyMap<string, string>,
): { ok: Uint8Array; boundary: string } | { error: string } => {
  const boundary = `openapi-mcp-${randomBytes(24).toString('hex')}`;
  const delimiter = Buffer.from(`--${boundary}`);
  const chunks: Buffer[] = [];
  // Imperative on purpose: each part can fail (bad name, bad value, bad
  // base64) and must stop the whole body at the first failure.
  for (const [name, value] of Object.entries(payload)) {
    if (!isSafePartName(name)) {
      return { error: `multipart part name "${name}" cannot be encoded safely` };
    }
    let content: Buffer;
    let headers = `Content-Disposition: form-data; name="${name}"`;
    const partType = binaryParts.get(name);
    if (partType !== undefined) {
      const decoded = binaryBody(value);
      if ('error' in decoded) {
        return { error: `multipart part "${name}" must be a valid base64 string` };
      }
      content = Buffer.from(decoded.ok);
      headers += `; filename="${name}"\r\nContent-Type: ${partType}`;
    } else if (isPrimitive(value)) {
      content = Buffer.from(String(value), 'utf8');
    } else {
      return { error: `multipart part "${name}" must be a string, number or boolean` };
    }
    if (content.includes(delimiter)) {
      return { error: 'a multipart part contains the generated boundary' };
    }
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { ok: new Uint8Array(Buffer.concat(chunks)), boundary };
};

const serializeBody = (
  mapper: RequestMapper,
  method: string,
  data: Record<string, unknown>,
): { ok: SerializedBody } | { error: string } => {
  // GET/HEAD never carry a body, even when the mapper has body fields —
  // non-negotiable regardless of bodyMode.
  const upperMethod = method.toUpperCase();
  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    return { ok: {} };
  }
  if (mapper.bodyMode === 'none') {
    return { ok: {} };
  }
  const bodyFieldEntries = Object.entries(mapper.fields).filter(
    (entry): entry is [string, BodyMapping] => entry[1].destination === 'body',
  );
  const contentType = mapper.bodyContentType;
  if (contentType === undefined) {
    // Invariant from toolgen/layout.ts's buildLayout: bodyMode !== 'none'
    // always carries a contentType. Defensive, fail-closed if ever violated.
    return { error: 'the request mapper is missing a body content type' };
  }
  // The content type is the spec's declared media type, sent verbatim;
  // its essence picks the encoding. buildLayout only ever
  // selects a well-formed JSON-family or form-urlencoded type — anything else
  // here is a broken invariant and fails closed.
  const encoding = bodyEncoding(contentType);
  if (encoding === undefined) {
    return { error: 'the request mapper has an unsupported body content type' };
  }
  // A QUERY server must reject a request without Content-Type (RFC 10008
  // §2), so an omitted optional form body is sent as the empty form, which
  // is a valid representation. Empty JSON or multipart content is not, so
  // those still send no body (issue #33).
  const sendsEmptyForm = upperMethod === 'QUERY' && encoding === 'form';
  let payload: unknown;
  if (mapper.bodyMode === 'single') {
    const [entry] = bodyFieldEntries;
    if (entry === undefined) {
      return { error: 'the request mapper declares a single body with no body field' };
    }
    const [name, mapping] = entry;
    const value = data[name];
    if (value === undefined && mapping.required) {
      return { error: 'missing required request body' };
    }
    if (value === undefined && !sendsEmptyForm) {
      return { ok: {} };
    }
    payload = value ?? {};
  } else {
    const assembled = buildBodyObject(bodyFieldEntries, data);
    if ('error' in assembled) {
      return assembled;
    }
    // An entirely-absent OPTIONAL body group sends no body at all — the
    // all-or-nothing refine in buildLayout already guarantees the group is
    // either fully present or fully absent by the time we get here. A
    // REQUIRED body is sent even when every (optional) field is absent: it
    // falls through with the empty object, so the upstream receives `{}` (or
    // an empty form body) with its Content-Type rather than no body at all
    // (kaisers-io/openapi-mcp-archive#40). Presence comes from the mapper,
    // never from populated fields.
    if (!assembled.anyPresent && mapper.bodyRequired !== true && !sendsEmptyForm) {
      return { ok: {} };
    }
    payload = assembled.object;
  }
  if (encoding === 'multipart') {
    if (!isPlainObject(payload)) {
      return { error: 'a multipart/form-data body must be an object' };
    }
    // RFC 2046 §5.1.1 requires at least one body part; a required body whose
    // parts are all optional and absent would be just the close delimiter,
    // which strict parsers (busboy/multer setups, some Java servers) reject.
    if (Object.keys(payload).length === 0) {
      const names = bodyFieldEntries.map(([name]) => name).join(', ');
      return {
        error: `the multipart/form-data request body needs at least one part (RFC 2046); provide at least one of: ${names}`,
      };
    }
    const binaryParts = new Map(
      bodyFieldEntries.flatMap(([, mapping]) =>
        mapping.binary === true && mapping.bodyPath.length === 1
          ? [[mapping.bodyPath[0] as string, mapping.partContentType ?? OCTET_STREAM] as const]
          : [],
      ),
    );
    const encoded = multipartBody(payload, binaryParts);
    if ('error' in encoded) {
      return encoded;
    }
    return {
      ok: { body: encoded.ok, contentType: `${contentType}; boundary=${encoded.boundary}` },
    };
  }
  if (encoding === 'binary') {
    const decoded = binaryBody(payload);
    if ('error' in decoded) {
      return decoded;
    }
    return { ok: { body: decoded.ok, contentType } };
  }
  if (encoding === 'json-lines' || encoding === 'json-seq' || encoding === 'event-stream') {
    const encoded = sequenceBody(payload, encoding);
    if ('error' in encoded) {
      return encoded;
    }
    return { ok: { body: encoded.ok, contentType } };
  }
  if (encoding === 'json') {
    const encoded = jsonBody(payload);
    if ('error' in encoded) {
      return encoded;
    }
    return { ok: { body: encoded.ok, contentType } };
  }
  // Application/x-www-form-urlencoded
  if (!isPlainObject(payload)) {
    return { error: 'a form-urlencoded body must be an object' };
  }
  const encoded = formBody(payload);
  if ('error' in encoded) {
    return encoded;
  }
  return { ok: { body: encoded.ok, contentType } };
};

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

export const buildRequest = (
  mapper: RequestMapper,
  method: string,
  pathTemplate: string,
  data: Record<string, unknown>,
  budgets: OutboundBudgets,
): BuildRequestResult => {
  // Imperative on purpose: this single pass builds THREE interdependent
  // accumulators (the progressively-substituted `pathname` string, the
  // ordered `queryPairs` list, and the `headers` record) and enforces
  // fail-fast validation per field in ITERATION order — never a pure
  // map/reduce here, because: (1) each path substitution is applied to the
  // CURRENT `pathname` via `.split(placeholder).join(...)`, so a later
  // field's placeholder match depends on every earlier substitution having
  // already run (a substituted value that happens to contain literal
  // placeholder syntax for a later field must not be re-substituted, which
  // only holds if substitutions apply strictly in field order); and (2) a
  // missing-required/null-required/duplicate-query-key error must abort
  // before any later field is processed, matching a for-of loop's early
  // `return` far more directly than an eagerly-evaluated array transform.
  let pathname = pathTemplate;
  const queryPairs: QueryPair[] = [];
  const usedQueryKeys = new Set<string>();
  const headers: Record<string, string> = {};

  for (const [name, mapping] of Object.entries(mapper.fields)) {
    if (mapping.destination === 'body') {
      continue;
    }
    const value = data[name];
    if (value === undefined) {
      if (mapping.required) {
        return { error: `missing required value for "${mapping.wireName}"` };
      }
      continue;
    }
    if (value === null) {
      if (mapping.required) {
        return { error: `"${mapping.wireName}" is required and must not be null` };
      }
      // An explicit null on an OPTIONAL param is omitted, exactly like
      // absent.
      continue;
    }
    if (mapping.destination === 'path') {
      const result = serializePathValue(mapping, value);
      if ('error' in result) {
        return result;
      }
      const placeholder = `{${mapping.wireName}}`;
      if (!pathname.includes(placeholder)) {
        // Toolgen/layout.ts's buildLayout guarantees every path field has a
        // matching placeholder; defensive fail-closed if ever violated.
        return { error: `the path template has no placeholder for "${mapping.wireName}"` };
      }
      pathname = pathname.split(placeholder).join(result.ok);
    } else if (mapping.destination === 'query') {
      const result = serializeQueryValue(mapping, value);
      if ('error' in result) {
        return result;
      }
      const introduced = new Set(result.ok.map((pair) => pair.key));
      for (const key of introduced) {
        if (usedQueryKeys.has(key)) {
          return { error: `query key "${key}" collides with another serialized parameter` };
        }
      }
      for (const key of introduced) {
        usedQueryKeys.add(key);
      }
      queryPairs.push(...result.ok);
    } else if (mapping.destination === 'querystring') {
      // The layout never combines it with query parameters (OAS 3.2)
      const result = serializeQuerystringValue(mapping.wireName, value);
      if ('error' in result) {
        return result;
      }
      queryPairs.push(...result.ok);
    } else {
      const result = serializeHeaderValue(mapping, value);
      if ('error' in result) {
        return result;
      }
      headers[mapping.wireName.toLowerCase()] = result.ok;
    }
  }

  const bodyResult = serializeBody(mapper, method, data);
  if ('error' in bodyResult) {
    return bodyResult;
  }

  const query = queryPairs.map((pair) => `${pair.key}=${pair.value}`).join('&');

  const urlLength = pathname.length + (query === '' ? 0 : query.length + 1);
  if (urlLength > budgets.maxUrlLength) {
    return { error: 'the built request URL exceeds the outbound URL length budget' };
  }
  // Loop body is a pure sum expression over the already-built, bounded
  // headers record — a single-expression `reduce` rewrite.
  const headerBytes = Object.entries(headers).reduce(
    (sum, [key, headerValue]) => sum + byteLength(key) + byteLength(headerValue),
    0,
  );
  if (headerBytes > budgets.maxHeaderBytes) {
    return { error: 'the built request headers exceed the outbound header byte budget' };
  }
  if (bodyResult.ok.body !== undefined && bodyResult.ok.body.byteLength > budgets.maxBodyBytes) {
    return { error: 'the built request body exceeds the outbound body byte budget' };
  }

  return {
    ok: {
      pathname,
      query,
      headers,
      ...(bodyResult.ok.body === undefined
        ? {}
        : { body: bodyResult.ok.body, contentType: bodyResult.ok.contentType }),
    },
  };
};

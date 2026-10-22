import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Options, ValidateFunction } from 'ajv';
import type { PinnedErrorReason, PinnedOutcome } from '../../http/pinned-dispatcher.ts';
import { project, PROJECTION_HINT } from '../../toolgen/projection.ts';
import type { Redactor } from '../../redact.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText, TRUNCATION_MARKER } from '../../spec/sanitize.ts';
import {
  decorateTextOutcome,
  forwardableHeaders,
  pageHinter,
  upstreamRetryAfterMs,
} from './forwarded-headers.ts';
import type { PageHint, PageInput } from './forwarded-headers.ts';
import { markSecretScanned, structuredOutcome, textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';

// The executor is the SOLE enforcer of {status,contentType,data} envelope
// conformance — the low-level SDK Server performs no per-tool outputSchema
// validation at all, so a bug here that emits nonconforming structuredContent
// would reach the client unchecked. mapResponse turns a PinnedOutcome into
// the MCP envelope, validated with ajv, or a redacted isError — never
// forwarding a raw upstream body, a raw ajv error, or a secret.

// CJS interop mirror of spec/validate.ts's unwrapDefault/AjvConstructor
// pattern: TypeScript under nodenext types these CJS default imports as
// namespaces without construct/call signatures, while at runtime the binding
// (and its .default) is the class/function in every module system in play.
// Kept as a LOCAL mirror rather than a shared import: envelope compilation
// stays executor-local, not entangled with spec/validate.ts's
// meta-schema-validator cache — an unrelated cache key (the two official
// OpenAPI meta-schemas vs. one compiled validator per tool outputSchema).
type AjvInstance = {
  compile: (schema: object) => ValidateFunction;
};
type AjvConstructor = new (opts: Options) => AjvInstance;

const unwrapDefault = <Unwrapped>(moduleValue: unknown): Unwrapped => {
  const withDefault = moduleValue as { default?: Unwrapped };
  return withDefault.default ?? (moduleValue as Unwrapped);
};

const Ajv2020 = unwrapDefault<AjvConstructor>(Ajv2020Module);
const addFormats = unwrapDefault<(ajv: AjvInstance) => unknown>(addFormatsModule);

export type EnvelopeValidator = (envelope: unknown) => boolean;

// Compiles once, eagerly, so an incompatible outputSchema throws AT this
// call — i.e. at server startup, never on the first matching tool call.
// `undefined` in, `undefined` out: a tool with no outputSchema has nothing
// to validate against.
export const compileEnvelopeValidator = (
  outputSchema: Record<string, unknown> | undefined,
): EnvelopeValidator | undefined => {
  if (outputSchema === undefined) {
    return undefined;
  }
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(outputSchema);
  return (envelope: unknown): boolean => validate(envelope) === true;
};

export type MapResponseOptions = {
  outcome: PinnedOutcome;
  // Undefined => no outputSchema => the plain-text/JSON-as-text path.
  validator: EnvelopeValidator | undefined;
  // For reading each oneOf branch's declared status/contentType consts.
  outputSchema: Record<string, unknown> | undefined;
  redactor: Redactor;
  // Named on a 401/403 (an actionable hint, never the credential itself).
  envVarHint?: string;
  // Text display cap for the no-outputSchema success path, in bytes.
  maxTextBytes: number;
  // The configured API base URL. When given, allowlisted upstream response
  // headers are forwarded into the result (see forwarded-headers.ts), with
  // `Location` kept only when same-origin with it.
  baseUrl?: string;
  // Clock for an HTTP-date Retry-After; Date.now by default.
  now?: () => number;
  // For a paginated tool: computes the `pagination` hint for a successful
  // response from its parsed Link header and (structured path only) its
  // parsed data. The hint is secret-checked here before it is used.
  paginate?: (input: PageInput) => PageHint;
  // The call's validated `_fields` JSON Pointers (toolgen/projection.ts).
  fields?: readonly string[];
  // The tool accepts `_fields`: a truncated result then says so.
  projectable?: boolean;
};

// Fixed, reason-keyed text — never the PinnedOutcome's own `detail` string,
// which can embed a hostname or an underlying network-library message never
// meant for a tool-call response.
const PINNED_ERROR_TEXT: Record<PinnedErrorReason, string> = {
  timeout: 'the upstream request timed out',
  cancelled: 'the request was cancelled',
  egress: 'the request target is not allowed by the egress policy',
  'too-large': 'the upstream response exceeded the maximum response size',
  'redirect-loop': 'the upstream request followed too many redirects',
  'redirect-write-method': 'the upstream server redirected a write request, which is not followed',
  'redirect-invalid': 'the upstream server sent an invalid redirect',
  network: 'the request to the upstream server failed',
};

const mapPinnedError = (reason: PinnedErrorReason): ToolCallOutcome =>
  textOutcome(`tool execution failed: ${PINNED_ERROR_TEXT[reason]}`, true);

// `JSON.parse` throws on malformed JSON; every call site below treats a
// parse failure as its own fail-closed branch rather than letting the throw
// escape, so this shares one pure attempt-wrapper (same try/catch, just
// named) instead of repeating it three times.
const tryParseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const decodeUtf8 = (bytes: Uint8Array): { ok: string } | { error: true } => {
  try {
    return { ok: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { error: true };
  }
};

const mediaEssence = (contentType: string | undefined): string | undefined => {
  if (contentType === undefined) {
    return undefined;
  }
  const [essence] = contentType.split(';');
  const trimmed = essence === undefined ? '' : essence.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
};

// Mirrors toolgen/output-schema.ts's isJsonContentType (not exported there —
// this module needs its own copy of the same essence test).
const JSON_ESSENCE_RE = /^application\/(?:[\w.+-]+\+)?json$/u;
const isTextEssence = (essence: string): boolean => essence.startsWith('text/');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type OutputBranch = {
  status: number;
  contentType: string;
};

// Reads the `oneOf` branches straight off the generated outputSchema shape
// (toolgen/output-schema.ts: `{type:'object', oneOf:[{properties:{status:
// {const}, contentType:{const}, data}}]}`).
const branchesOf = (outputSchema: Record<string, unknown>): readonly OutputBranch[] => {
  const { oneOf } = outputSchema;
  if (!Array.isArray(oneOf)) {
    return [];
  }
  return oneOf.flatMap((branch): OutputBranch[] => {
    if (!isRecord(branch) || !isRecord(branch['properties'])) {
      return [];
    }
    const { properties } = branch;
    const statusProp = properties['status'];
    const contentTypeProp = properties['contentType'];
    if (!isRecord(statusProp) || !isRecord(contentTypeProp)) {
      return [];
    }
    const statusConst = statusProp['const'];
    const contentTypeConst = contentTypeProp['const'];
    return typeof statusConst === 'number' && typeof contentTypeConst === 'string'
      ? [{ status: statusConst, contentType: contentTypeConst }]
      : [];
  });
};

const findBranch = (
  outputSchema: Record<string, unknown>,
  status: number,
  essence: string,
): OutputBranch | undefined =>
  branchesOf(outputSchema).find(
    (branch) => branch.status === status && branch.contentType.toLowerCase() === essence,
  );

// Byte-safe truncation for the no-outputSchema text path: `maxBytes` is a
// wire-byte budget (MapResponseOptions.maxTextBytes), so truncation is
// measured on the UTF-8 ENCODING of the (already redacted — see mapResponse
// callers below) text, never on its UTF-16 character length, and the cut
// point is walked back until it lands on a valid UTF-8 boundary so the
// result never contains a split multi-byte codepoint.
const textEncoder = new TextEncoder();
const truncateUtf8 = (text: string, maxBytes: number): string => {
  const encoded = textEncoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  const markerBytes = textEncoder.encode(TRUNCATION_MARKER).byteLength;
  // Imperative on purpose (recursion, not a mutable loop counter): walks the
  // byte budget back one byte at a time until it lands on a valid UTF-8
  // boundary. `TextDecoder`'s `fatal: true` throws when a cut splits a
  // multi-byte code point, so each retry needs its own decode attempt inside
  // a try/catch; recursion depth is inherently tiny (a UTF-8 sequence is at
  // most 4 bytes, so at most 3 retries are ever needed).
  const walkBack = (budget: number): string => {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded.slice(0, budget));
      return `${decoded}${TRUNCATION_MARKER}`;
    } catch {
      return walkBack(budget - 1);
    }
  };
  return walkBack(Math.max(0, maxBytes - markerBytes));
};

// Byte-capped excerpt budget for a 4xx/5xx error body. Reuses
// DISPLAY_TEXT_MAX rather than inventing a new magic
// number: it is already the codebase's shared "bound a single hostile
// human-display string" budget (spec/sanitize.ts), and an error excerpt is
// exactly that kind of string. Measured in characters (sanitizeSpecText's
// own contract), matching how DISPLAY_TEXT_MAX is consumed everywhere else.
const ERROR_EXCERPT_MAX = DISPLAY_TEXT_MAX;

const GENERIC_UNSAFE_TEXT = 'the upstream response could not be returned safely';

// Keeps mapResponse locally fail-closed: scanForSecret's contract
// (redact.ts) explicitly documents that a pathologically deep
// JSON-compatible input throws rather than looping forever. Every
// scanForSecret call site in this module treats "found a secret" as
// "reject the body", so mapping a throw to `true` reuses each call site's
// existing generic-isError branch instead of letting the throw escape
// mapResponse and rely on the dispatcher's outer catch.
const scanSafely = (redactor: Redactor, value: unknown): boolean => {
  try {
    return redactor.scanForSecret(value);
  } catch {
    return true;
  }
};

const mapHttpError = (
  status: number,
  contentType: string | undefined,
  bodyBytes: Uint8Array,
  redactor: Redactor,
  envVarHint: string | undefined,
): ToolCallOutcome => {
  if (status === 401 || status === 403) {
    const hint = envVarHint === undefined ? '' : ` (check the ${envVarHint} environment variable)`;
    return textOutcome(`upstream request failed with status ${status}${hint}`, true);
  }
  if (bodyBytes.byteLength === 0) {
    return textOutcome(`upstream request failed with status ${status}`, true);
  }
  const decoded = decodeUtf8(bodyBytes);
  if ('error' in decoded) {
    return textOutcome(`upstream request failed with status ${status}`, true);
  }
  // Mirrors mapNoSchemaSuccess's JSON-structure scan below — string-only
  // redaction on the raw body text cannot see a secret that is present in
  // the decoded JSON STRUCTURE but escaped differently in its serialized
  // form (e.g. a secret containing `/` rendered `\/`, or a `\uXXXX` escape).
  // Parse the JSON and scan the resulting STRUCTURE first; on a hit, drop
  // straight to the status-only message with NO excerpt at all (never fall
  // through to the string-redacted excerpt below, which could still echo
  // the escaped form verbatim).
  const essence = mediaEssence(contentType);
  if (essence !== undefined && JSON_ESSENCE_RE.test(essence)) {
    const attempt = tryParseJson(decoded.ok);
    if (attempt.ok && scanSafely(redactor, attempt.value)) {
      return textOutcome(`upstream request failed with status ${status}`, true);
    }
  }
  // Redact BEFORE truncating: sanitizeSpecText's own truncation runs AFTER
  // this redaction, over the already-secret-free text, so a secret cannot
  // be split across the excerpt boundary and leak a surviving fragment.
  const redacted = redactor.redactString(decoded.ok);
  const excerpt = sanitizeSpecText(redacted, ERROR_EXCERPT_MAX);
  if (scanSafely(redactor, excerpt)) {
    return textOutcome(`upstream request failed with status ${status}`, true);
  }
  return textOutcome(`upstream request failed with status ${status}: ${excerpt}`, true);
};

const mapNoSchemaSuccess = (
  status: number,
  contentType: string | undefined,
  bodyBytes: Uint8Array,
  redactor: Redactor,
  maxTextBytes: number,
): ToolCallOutcome => {
  if (bodyBytes.byteLength === 0) {
    return textOutcome('', false);
  }
  const essence = mediaEssence(contentType);
  if (essence !== undefined && !JSON_ESSENCE_RE.test(essence) && !isTextEssence(essence)) {
    // `essence` is upstream-controlled (the raw Content-Type header) — a
    // hostile upstream can echo a registered secret through it, so it must
    // be redacted, not merely sanitize-truncated, before it reaches this
    // error text.
    const safeEssence = sanitizeSpecText(redactor.redactString(essence), 128);
    return textOutcome(
      `upstream response for status ${status} used an unsupported media type "${safeEssence}"`,
      true,
    );
  }
  const decoded = decodeUtf8(bodyBytes);
  if ('error' in decoded) {
    return textOutcome('upstream response body was not valid UTF-8 text', true);
  }
  // Load-bearing: string-only redaction on the raw body text cannot see a
  // secret that is present in the decoded JSON STRUCTURE but escaped
  // differently in its serialized form — e.g. a
  // secret containing `/` (base64 and HTTP Basic-auth creds commonly do),
  // where PHP's json_encode (and other encoders) render `/` as `\/`. The
  // raw body text then reads `...sk\/live\/...` while every redactor
  // needle is the unescaped `sk/live/...`, so neither redactString nor the
  // final scanForSecret below (both operating on the raw text) ever match,
  // and the escaped secret survives verbatim in the returned text. Parsing
  // the JSON and scanning the resulting STRUCTURE compares against the
  // actual decoded string values (JSON.parse un-escapes `\/` back to `/`),
  // so this catches what string-only redaction structurally cannot. A body
  // whose Content-Type claims JSON but does not parse falls through to the
  // existing text handling below, unchanged.
  if (essence !== undefined && JSON_ESSENCE_RE.test(essence)) {
    const attempt = tryParseJson(decoded.ok);
    if (attempt.ok && scanSafely(redactor, attempt.value)) {
      // Never emit a body that contains the secret in escaped form: no
      // string-redacted fallback here, a generic isError with no body.
      return textOutcome(GENERIC_UNSAFE_TEXT, true);
    }
  }
  // Redact BEFORE truncating, same rationale as mapHttpError above: the
  // text/JSON success path must never return the raw body either.
  const redacted = redactor.redactString(decoded.ok);
  const truncated = truncateUtf8(redacted, maxTextBytes);
  if (scanSafely(redactor, truncated)) {
    return textOutcome(GENERIC_UNSAFE_TEXT, true);
  }
  return textOutcome(truncated, false);
};

// One secret check for a parsed JSON body. Without a backslash anywhere in
// the decoded text, JSON has no escape sequences, so every key and string
// value appears in the raw text exactly as it does after parsing: one
// substring scan of the raw text then finds every secret the recursive tree
// walk would find over `data` (and possibly more — a needle spanning two
// tokens — which only fails closed). With any backslash present, an escaped
// secret (`\/`, `\uXXXX`) differs from its parsed form, so the tree walk
// runs over the whole envelope instead. Every OTHER envelope field (status,
// contentType, and anything a later layer adds, such as forwarded headers or
// pagination hints) is always tree-scanned: the raw text only stands in for
// `data`, so a new field can never silently skip the scan.
export const envelopeHasSecret = (
  redactor: Redactor,
  rawJson: string,
  envelope: Record<string, unknown>,
): boolean => {
  if (rawJson.includes('\\')) {
    return scanSafely(redactor, envelope);
  }
  const { data: _data, ...rest } = envelope;
  return scanSafely(redactor, rawJson) || scanSafely(redactor, rest);
};

// `_fields` on a tool with an outputSchema: the FULL envelope is still
// validated against the strict schema first (upstream data must match the
// spec whatever is selected), then the selection replaces `data` with
// `projection` — the package-authored branch the outputSchema declares — and
// only the projected envelope is secret-scanned, so a secret in a field the
// caller did not select no longer fails the call while a selected one does.
const projectEnvelope = (
  envelope: Record<string, unknown>,
  data: unknown,
  fields: readonly string[],
  validator: EnvelopeValidator,
  redactor: Redactor,
  maxTextBytes: number,
): ToolCallOutcome => {
  const { status } = envelope;
  if (!validator(envelope)) {
    return textOutcome(
      `upstream response for status ${String(status)} did not match the tool's declared output schema`,
      true,
    );
  }
  const { data: _full, ...rest } = envelope;
  const projected: Record<string, unknown> = { ...rest, projection: project(data, fields) };
  if (scanSafely(redactor, projected)) {
    return textOutcome(GENERIC_UNSAFE_TEXT, true);
  }
  markSecretScanned(projected, redactor);
  return structuredOutcome(truncateUtf8(JSON.stringify(projected), maxTextBytes), projected);
};

// `_fields` on a tool WITHOUT an outputSchema: a JSON body is projected
// before the text cap; anything else cannot be projected.
const mapNoSchemaProjection = (
  bodyBytes: Uint8Array,
  fields: readonly string[],
  redactor: Redactor,
  maxTextBytes: number,
): ToolCallOutcome => {
  const decoded = decodeUtf8(bodyBytes);
  const parsed = 'error' in decoded ? { ok: false as const } : tryParseJson(decoded.ok);
  if (!parsed.ok) {
    return textOutcome('tool execution failed: projection requires a JSON response', true);
  }
  const projection = project(parsed.value, fields);
  if (scanSafely(redactor, projection)) {
    return textOutcome(GENERIC_UNSAFE_TEXT, true);
  }
  return textOutcome(truncateUtf8(JSON.stringify(projection), maxTextBytes), false);
};

const mapSchemaSuccess = (
  status: number,
  contentType: string | undefined,
  bodyBytes: Uint8Array,
  outputSchema: Record<string, unknown>,
  validator: EnvelopeValidator,
  redactor: Redactor,
  maxTextBytes: number,
  forwarded: Readonly<Record<string, string>>,
  page: ((data?: unknown) => PageHint) | undefined,
  fields: readonly string[] | undefined,
): ToolCallOutcome => {
  const essence = mediaEssence(contentType);
  const branch = essence === undefined ? undefined : findBranch(outputSchema, status, essence);
  if (branch === undefined) {
    // Same upstream-controlled-essence redaction as mapNoSchemaSuccess's
    // unsupported-media-type message above.
    const observed =
      essence === undefined ? '(missing)' : sanitizeSpecText(redactor.redactString(essence), 128);
    return textOutcome(
      `upstream response for status ${status} did not match a declared output branch (media type ${observed})`,
      true,
    );
  }
  const decoded = decodeUtf8(bodyBytes);
  if ('error' in decoded) {
    return textOutcome('upstream response body was not valid UTF-8 text', true);
  }
  const parseAttempt = tryParseJson(decoded.ok);
  if (!parseAttempt.ok) {
    return textOutcome(`upstream response for status ${status} was not valid JSON`, true);
  }
  // Forwarded headers join the envelope (an optional `headers` property the
  // generated outputSchema declares), so the validator below covers them.
  // Each value was already sanitized and secret-checked on its own.
  const envelope: Record<string, unknown> = {
    status,
    contentType: branch.contentType,
    data: parseAttempt.value,
    ...(Object.keys(forwarded).length === 0 ? {} : { headers: { ...forwarded } }),
    ...(page === undefined ? {} : { pagination: page(parseAttempt.value) }),
  };
  if (fields !== undefined) {
    return projectEnvelope(envelope, parseAttempt.value, fields, validator, redactor, maxTextBytes);
  }
  // A secret anywhere in the structured data downgrades to a generic
  // isError — never a redacted-but-successful structuredContent. The
  // envelope's DATA is never itself rewritten: either it is secret-free and
  // returned verbatim, or the call is refused outright.
  if (envelopeHasSecret(redactor, decoded.ok, envelope)) {
    return textOutcome(GENERIC_UNSAFE_TEXT, true);
  }
  if (!validator(envelope)) {
    // Never forward raw ajv errors — they can embed offending instance
    // values. A status-only summary is safe to return verbatim.
    return textOutcome(
      `upstream response for status ${status} did not match the tool's declared output schema`,
      true,
    );
  }
  // The dispatch boundary would otherwise repeat the full tree scan above.
  markSecretScanned(envelope, redactor);
  // The text block is the backwards-compatibility serialization (the MCP
  // spec's SHOULD), not a second full copy of the payload: it is capped at
  // the same maxTextBytes as an unstructured result, with the truncation
  // marker, while structuredContent carries the complete data.
  return structuredOutcome(truncateUtf8(JSON.stringify(envelope), maxTextBytes), envelope);
};

const mapBody = (
  opts: MapResponseOptions,
  forwarded: Readonly<Record<string, string>>,
  page?: (data?: unknown) => PageHint,
): ToolCallOutcome => {
  const { outcome } = opts;
  if (outcome.kind === 'error') {
    return mapPinnedError(outcome.reason);
  }
  const { status, contentType, bodyBytes } = outcome;
  if (status >= 400) {
    return mapHttpError(status, contentType, bodyBytes, opts.redactor, opts.envVarHint);
  }
  // A 3xx reaching here is one the transport does not follow (300 Multiple
  // Choices, 304 Not Modified, 305/306, or an unknown 3xx): none of them is
  // the operation's result, so it must not map to success. 304 in
  // particular only answers a conditional request, which this client never
  // sends. The status is a number from the parsed status line, never text.
  if (status >= 300) {
    return textOutcome(
      `tool execution failed: the upstream server returned status ${status}, which is not supported`,
      true,
    );
  }
  if (opts.validator === undefined) {
    return opts.fields === undefined
      ? mapNoSchemaSuccess(status, contentType, bodyBytes, opts.redactor, opts.maxTextBytes)
      : mapNoSchemaProjection(bodyBytes, opts.fields, opts.redactor, opts.maxTextBytes);
  }
  if (bodyBytes.byteLength === 0) {
    // No body means no way to form a valid {status,contentType,data}
    // envelope for a tool that declared one.
    return textOutcome(`upstream response for status ${status} had no body to validate`, true);
  }
  if (opts.outputSchema === undefined) {
    // Contract violation: the caller must always pass outputSchema alongside
    // a compiled validator — fail closed rather than crash.
    return textOutcome(
      'tool execution failed: the tool has no output schema to validate against',
      true,
    );
  }
  return mapSchemaSuccess(
    status,
    contentType,
    bodyBytes,
    opts.outputSchema,
    opts.validator,
    opts.redactor,
    opts.maxTextBytes,
    forwarded,
    page,
    opts.fields,
  );
};

export const mapResponse = (opts: MapResponseOptions): ToolCallOutcome => {
  const { outcome } = opts;
  if (outcome.kind === 'error' || opts.baseUrl === undefined) {
    return withProjectionHint(mapBody(opts, {}), opts);
  }
  const forwarded = forwardableHeaders({
    headers: outcome.headers,
    responseUrl: outcome.url,
    baseUrl: opts.baseUrl,
    redactor: opts.redactor,
  });
  const nowMs = (opts.now ?? Date.now)();
  const page =
    opts.paginate === undefined
      ? undefined
      : pageHinter(opts.paginate, opts.redactor, outcome.headers, outcome.url, outcome.status);
  const mapped = mapBody(opts, forwarded, page);
  // A text result (no outputSchema) gets the Link-derived hint as its own
  // block; a structured one already carries it in the envelope.
  const textHint =
    page !== undefined && !mapped.isError && mapped.structuredContent === undefined
      ? page()
      : undefined;
  const decorated = decorateTextOutcome(
    mapped,
    forwarded,
    upstreamRetryAfterMs(outcome.status, outcome.headers, nowMs),
    textHint,
  );
  return withProjectionHint(decorated, opts);
};

// A truncated result of a projectable tool tells the model how to ask for
// less, rather than leaving it with a cut-off body.
const withProjectionHint = (outcome: ToolCallOutcome, opts: MapResponseOptions): ToolCallOutcome =>
  opts.projectable === true &&
  opts.fields === undefined &&
  outcome.content[0]?.text.endsWith(TRUNCATION_MARKER) === true
    ? { ...outcome, content: [...outcome.content, { type: 'text', text: PROJECTION_HINT }] }
    : outcome;

import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Options, ValidateFunction } from 'ajv';
import type { PinnedErrorReason, PinnedOutcome } from '../../http/pinned-dispatcher.ts';
import type { Redactor } from '../../redact.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText, TRUNCATION_MARKER } from '../../spec/sanitize.ts';
import { structuredOutcome, textOutcome } from '../result.ts';
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
interface AjvInstance {
  compile: (schema: object) => ValidateFunction;
}
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

export interface MapResponseOptions {
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
}

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

interface OutputBranch {
  status: number;
  contentType: string;
}

// Reads the `oneOf` branches straight off the generated outputSchema shape
// (toolgen/output-schema.ts: `{type:'object', oneOf:[{properties:{status:
// {const}, contentType:{const}, data}}]}`).
const branchesOf = (outputSchema: Record<string, unknown>): readonly OutputBranch[] => {
  const { oneOf } = outputSchema;
  if (!Array.isArray(oneOf)) {
    return [];
  }
  const branches: OutputBranch[] = [];
  for (const branch of oneOf) {
    if (!isRecord(branch) || !isRecord(branch['properties'])) {
      continue;
    }
    const { properties } = branch;
    const statusProp = properties['status'];
    const contentTypeProp = properties['contentType'];
    if (!isRecord(statusProp) || !isRecord(contentTypeProp)) {
      continue;
    }
    const statusConst = statusProp['const'];
    const contentTypeConst = contentTypeProp['const'];
    if (typeof statusConst === 'number' && typeof contentTypeConst === 'string') {
      branches.push({ status: statusConst, contentType: contentTypeConst });
    }
  }
  return branches;
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
  let budget = Math.max(0, maxBytes - markerBytes);
  for (;;) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded.slice(0, budget));
      return `${decoded}${TRUNCATION_MARKER}`;
    } catch {
      budget -= 1;
    }
  }
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
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(decoded.ok);
    } catch {
      parsedOk = false;
    }
    if (parsedOk && scanSafely(redactor, parsed)) {
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
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(decoded.ok);
    } catch {
      parsedOk = false;
    }
    if (parsedOk && scanSafely(redactor, parsed)) {
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

const mapSchemaSuccess = (
  status: number,
  contentType: string | undefined,
  bodyBytes: Uint8Array,
  outputSchema: Record<string, unknown>,
  validator: EnvelopeValidator,
  redactor: Redactor,
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
  let data: unknown;
  try {
    data = JSON.parse(decoded.ok);
  } catch {
    return textOutcome(`upstream response for status ${status} was not valid JSON`, true);
  }
  const envelope: Record<string, unknown> = { status, contentType: branch.contentType, data };
  // A secret anywhere in the structured data downgrades to a generic
  // isError — never a redacted-but-successful structuredContent. The
  // envelope's DATA is never itself rewritten: either it is secret-free and
  // returned verbatim, or the call is refused outright.
  if (scanSafely(redactor, envelope)) {
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
  return structuredOutcome(JSON.stringify(envelope), envelope);
};

export const mapResponse = (opts: MapResponseOptions): ToolCallOutcome => {
  const { outcome } = opts;
  if (outcome.kind === 'error') {
    return mapPinnedError(outcome.reason);
  }
  const { status, contentType, bodyBytes } = outcome;
  if (status >= 400) {
    return mapHttpError(status, contentType, bodyBytes, opts.redactor, opts.envVarHint);
  }
  if (opts.validator === undefined) {
    return mapNoSchemaSuccess(status, contentType, bodyBytes, opts.redactor, opts.maxTextBytes);
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
  );
};

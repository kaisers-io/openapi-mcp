import type { Command } from '@commander-js/extra-typings';
import {
  HEADER_NAME_RE,
  parseByteSize,
  parseDuration,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  SYSTEM_HEADERS,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { HeaderEnvMapping } from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from './context.ts';

const collect = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

// Mirrors http/headers.ts's non-exported CONTROL_CHAR_RE (a static --header
// has no env-var indirection layer, so this file owns its own copy): any C0
// control or DEL in a header value is a request-smuggling vector.
// oxlint-disable-next-line no-control-regex -- matching control characters is this regex's purpose (it rejects them)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;

// Names that read as a credential regardless of what --header actually
// carries. Deny-by-pattern, not proof of non-secret — secretValues below is
// the defense-in-depth backstop for whatever this misses.
const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'auth',
  'token',
  'secret',
  'key',
  'session',
  'credential',
  'signature',
  'password',
  'bearer',
  'jwt',
];

const isSensitiveHeaderName = (lower: string): boolean =>
  SENSITIVE_EXACT.has(lower) || SENSITIVE_FRAGMENTS.some((fragment) => lower.includes(fragment));

// Hop-by-hop / client-managed names the transport itself owns. Deliberately
// DISJOINT from SENSITIVE_EXACT (excludes SYSTEM_HEADERS' credential entries)
// so the two checks stay independently falsifiable.
const HOP_BY_HOP_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'expect',
]);

// Startup budgets on the operator-configured header set: bound parsing cost
// and what the executor later forwards upstream.
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 8192;
const MAX_HEADER_AGGREGATE_BYTES = 65_536;

// A capped response is fully buffered as one Uint8Array, so this bounds
// worst-case per-call memory rather than reflecting a protocol limit.
const MAX_RESPONSE_BYTES_CEILING = 104_857_600; // 100 MiB

// Finite ceilings only — there is deliberately no "unlimited" value: the MCP
// tools spec says servers MUST rate limit, and an unbounded concurrency cap
// would let one client open unbounded upstream connections. The rate
// limiter keeps one timestamp per call in its window, so its ceiling bounds
// memory too.
const MAX_CONCURRENCY_CEILING = 256;
const MAX_RATE_LIMIT_CALLS = 100_000;
const POSITIVE_INT_RE = /^[1-9]\d*$/u;

// Mirrors redact.ts's own (non-exported) MIN_VARIANT_LENGTH: below this
// length, createRedactor computes no encoding variants for a needle at all,
// so registering a short static --header value buys no defense-in-depth and
// risks the marker-collision footgun described below instead.
const MIN_SECRET_REGISTRATION_LENGTH = 8;

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

export type ApiSecretHeader = {
  name: string;
  value: string;
  // Retained so a 401/403 hint can name the env var without echoing the value.
  envVar: string;
};

export type ResolvedApiConfig = {
  baseUrlOverride?: string;
  staticHeaders: { name: string; value: string }[];
  secretHeaders: ApiSecretHeader[];
  reservedHeaderNames: ReadonlySet<string>;
  // Every --header-env value (always) AND every --header value that is at
  // least MIN_SECRET_REGISTRATION_LENGTH chars: a credential mistakenly
  // passed via the non-secret --header flag is still scrubbed from all
  // redacted output. A SHORT static value (e.g. "da") is excluded — see
  // resolveApiConfig's own comment for why registering it is both useless
  // (createRedactor computes no encoding variants below that length) and
  // actively dangerous (createRedactor throws on a value that is itself a
  // substring of the literal '[redacted]' marker, e.g. "da"). The cleartext
  // gate stays keyed on --header-env presence only — static --header is
  // contractually non-secret (sensitive names are already rejected above),
  // so gating cleartext on it would block legitimate non-secret headers.
  secretValues: string[];
  maxResponseBytes: number;
  allowInsecureHttp: boolean;
  // Upstream calls in flight at once (--max-concurrency); more wait in a
  // bounded queue.
  maxConcurrency: number;
  // Tool calls per sliding window (--rate-limit <calls>/<duration>).
  rateLimit: { maxCalls: number; windowMs: number };
  // Deadline for one upstream API call (--request-timeout), independent of
  // the spec fetch's --timeout.
  requestTimeoutMs: number;
  // Extra attempts for transient failures of retry-safe requests
  // (--retries; 0 = off).
  retries: number;
  // Forward a call's W3C trace context (traceparent/tracestate from the MCP
  // request's _meta) to the upstream; --no-trace-propagation turns it off.
  propagateTraceContext: boolean;
};

export type ApiCmdOpts = {
  // Same commander generic-constraint workaround as SpecCmdOpts
  // (spec-options.ts): a plain object literal type is rejected by
  // `Command<[], Opts>`'s `Opts extends OptionValues` constraint without an
  // explicit index signature, even though it is structurally assignable.
  [key: string]: unknown;
  baseUrl?: string;
  headerEnv: readonly string[];
  header: readonly string[];
  maxResponseBytes: string;
  allowInsecureHttp?: boolean;
  maxConcurrency: string;
  rateLimit: string;
  requestTimeout: string;
  retries: string;
  // Commander's `--no-trace-propagation` sets this false (default true).
  tracePropagation?: boolean;
};

// The --base-url/--header-env/--header/--max-response-bytes/
// --allow-insecure-http flags for the runtime API executor — separate from
// registerSpecOptions, which governs the spec fetch instead.
export const registerApiOptions = (command: Command): Command<[], ApiCmdOpts> =>
  command
    .option('--base-url <url>', 'override the spec-derived base URL for API requests')
    .option(
      '--header-env <Header=ENV>',
      'API auth header, value read from env (repeatable, secret)',
      collect,
      [] as readonly string[],
    )
    .option(
      '--header <Header:value>',
      'static, non-secret API header (repeatable)',
      collect,
      [] as readonly string[],
    )
    .option(
      '--max-response-bytes <size>',
      'cap the decompressed upstream response body (<int><B|KB|MB> or a plain byte count)',
      '10MB',
    )
    .option(
      '--allow-insecure-http',
      'permit an operator credential (--header-env) over cleartext http to a non-loopback origin',
    )
    .option(
      '--max-concurrency <n>',
      'upstream calls in flight at once; further calls wait in a bounded queue',
      '16',
    )
    .option('--rate-limit <calls/duration>', 'tool calls allowed per sliding window', '120/1m')
    .option(
      '--request-timeout <duration>',
      'deadline for each upstream API request (<int><s|m|h|d>); --timeout covers the spec fetch',
      '30s',
    )
    .option(
      '--retries <n>',
      'retry a transient upstream failure (429/502/503/504, connection error) up to n times (0-3) for GET/HEAD/PUT/DELETE, and for POST/PATCH only with an Idempotency-Key header',
      '0',
    )
    .option(
      '--no-trace-propagation',
      "do not forward a call's W3C trace context (traceparent/tracestate) to the upstream API",
    );

// Shared by both header groups so the name/value size checks are defined
// once. `secret` only changes the wording, never echoing a secret value.
const assertHeaderSizeBudget = (name: string, value: string, secret: boolean): void => {
  if (name.length > MAX_HEADER_NAME_LENGTH) {
    throw usageError(`header name "${name}" exceeds the ${MAX_HEADER_NAME_LENGTH}-char budget`);
  }
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    const label = secret ? `value for header "${name}"` : `value of header "${name}"`;
    throw usageError(`${label} exceeds the ${MAX_HEADER_VALUE_LENGTH}-character budget`);
  }
};

const parseSecretHeaders = (
  raw: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ApiSecretHeader[] => {
  const mappings: HeaderEnvMapping[] = raw.map((entry) => parseHeaderEnvMapping(entry));
  const resolved = resolveHeaderEnvMappings(mappings, env);
  return resolved.map((header, index) => {
    assertHeaderSizeBudget(header.name, header.value, true);
    // `resolved` preserves order and length 1:1 with `mappings`
    // (resolveHeaderEnvMappings either throws or pushes one entry per
    // mapping), so index-zipping the envVar back on is sound.
    const mapping = mappings[index];
    if (mapping === undefined) {
      throw usageError('internal error: header-env mapping count mismatch');
    }
    return { name: header.name, value: header.value, envVar: mapping.envVar };
  });
};

// Strips a leading/trailing run of SP (U+0020) only — deliberately NARROWER
// than RFC 9110 OWS, which would also cover HTAB: a tab in a header value is
// a C0 control character here and is rejected below rather than normalized
// away, keeping the smuggling guard strict.
const trimOptionalSpace = (value: string): string => value.replace(/^ +/u, '').replace(/ +$/u, '');

// Imperative on purpose: `seen` accumulates across iterations (duplicate
// detection depends on every prior entry, not just the current one) and each
// of the seven checks below throws in encounter order — a map/filter
// pipeline would evaluate every entry before any throw could surface,
// changing which malformed --header the operator sees first.
const parseStaticHeaders = (raw: readonly string[]): { name: string; value: string }[] => {
  const seen = new Set<string>();
  const result: { name: string; value: string }[] = [];
  for (const entry of raw) {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex === -1) {
      // Entry may itself be a bare credential — never echo it back.
      throw usageError('invalid --header (expected "Header: value")');
    }
    const name = entry.slice(0, separatorIndex);
    const value = trimOptionalSpace(entry.slice(separatorIndex + 1));
    if (!HEADER_NAME_RE.test(name)) {
      throw usageError(`invalid header name "${name}" — must match the RFC 9110 token grammar`);
    }
    const lower = name.toLowerCase();
    if (isSensitiveHeaderName(lower)) {
      throw usageError(`header "${name}" looks like a credential — use --header-env instead`);
    }
    if (HOP_BY_HOP_HEADER_NAMES.has(lower)) {
      throw usageError(`header "${name}" is a hop-by-hop or client-managed header`);
    }
    if (value === '') {
      throw usageError(`header "${name}" has an empty value`);
    }
    if (CONTROL_CHAR_RE.test(value)) {
      throw usageError(`value of header "${name}" contains control characters`);
    }
    assertHeaderSizeBudget(name, value, false);
    if (seen.has(lower)) {
      throw usageError(`duplicate header "${name}" (case-insensitive)`);
    }
    seen.add(lower);
    result.push({ name, value });
  }
  return result;
};

type NamedHeader = {
  name: string;
  value: string;
};

// Cross-group uniqueness, the reservedHeaderNames union, and the header
// count/aggregate-byte budgets in one pass: all three walk the same two
// header lists, so splitting them into separate functions only added
// signature/comment overhead without adding independent test surface.
const crossValidateHeaders = (
  staticHeaders: readonly NamedHeader[],
  secretHeaders: readonly NamedHeader[],
): ReadonlySet<string> => {
  const secretNames = new Set(secretHeaders.map((header) => header.name.toLowerCase()));
  // `find` (not a combined build-and-check loop) preserves which header the
  // operator sees named in the error: the first --header entry that
  // collides, in the operator's own list order.
  const conflict = staticHeaders.find((header) => secretNames.has(header.name.toLowerCase()));
  if (conflict !== undefined) {
    throw usageError(`header "${conflict.name}" is configured via both --header and --header-env`);
  }
  const names = new Set<string>([
    ...SYSTEM_HEADERS,
    ...staticHeaders.map((header) => header.name.toLowerCase()),
    ...secretHeaders.map((header) => header.name.toLowerCase()),
  ]);
  const total = staticHeaders.length + secretHeaders.length;
  if (total > MAX_HEADER_COUNT) {
    throw usageError(`too many API headers configured (${total} > ${MAX_HEADER_COUNT})`);
  }
  const aggregate = [...staticHeaders, ...secretHeaders].reduce(
    (sum, header) => sum + byteLength(header.name) + byteLength(header.value),
    0,
  );
  if (aggregate > MAX_HEADER_AGGREGATE_BYTES) {
    throw usageError(`API headers exceed the ${MAX_HEADER_AGGREGATE_BYTES}-byte aggregate budget`);
  }
  return names;
};

// Redacted display form (mirrors spec/fetch.ts's displaySource): origin+path,
// userinfo/query/fragment dropped, so a rejected --base-url never echoes
// credentials or a secret-bearing query/fragment back to stderr/logs.
const redactedBaseUrl = (url: URL): string => `${url.origin}${url.pathname}`;

const tryParseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

const validateBaseUrl = (raw: string): string => {
  const url = tryParseUrl(raw);
  if (url === undefined) {
    // Unparseable and therefore un-redactable — name only the flag/problem.
    throw usageError('invalid --base-url — must be an absolute http(s) URL');
  }
  const problem = (
    [
      [url.protocol !== 'http:' && url.protocol !== 'https:', 'scheme must be http or https'],
      [url.username !== '' || url.password !== '', 'must not embed credentials in the URL'],
      [url.search !== '', 'must not contain a query string'],
      [url.hash !== '', 'must not contain a fragment'],
    ] as const
  ).find(([bad]) => bad);
  if (problem !== undefined) {
    throw usageError(`invalid --base-url (${redactedBaseUrl(url)}) — ${problem[1]}`);
  }
  return raw;
};

const parseMaxResponseBytes = (raw: string): number => {
  const bytes = parseByteSize(raw);
  if (bytes > MAX_RESPONSE_BYTES_CEILING) {
    throw usageError(
      `--max-response-bytes "${raw}" exceeds the ${MAX_RESPONSE_BYTES_CEILING}-byte cap`,
    );
  }
  return bytes;
};

const parseMaxConcurrency = (raw: string): number => {
  const value = Number(raw);
  if (!POSITIVE_INT_RE.test(raw) || value > MAX_CONCURRENCY_CEILING) {
    throw usageError(
      `invalid --max-concurrency "${raw}" — expected an integer from 1 to ${MAX_CONCURRENCY_CEILING}`,
    );
  }
  return value;
};

const RATE_LIMIT_HINT = `expected <calls>/<duration>, e.g. "120/1m" or "10/1s" (calls 1 to ${MAX_RATE_LIMIT_CALLS})`;

const parseRateLimit = (raw: string): { maxCalls: number; windowMs: number } => {
  const separator = raw.indexOf('/');
  const calls = separator === -1 ? '' : raw.slice(0, separator);
  const maxCalls = Number(calls);
  if (!POSITIVE_INT_RE.test(calls) || maxCalls > MAX_RATE_LIMIT_CALLS) {
    throw usageError(`invalid --rate-limit "${raw}" — ${RATE_LIMIT_HINT}`);
  }
  // The duration grammar (and its Node-timer ceiling) is parseDuration's;
  // its usage error names only the duration, so it is rethrown with the flag.
  try {
    return { maxCalls, windowMs: parseDuration(raw.slice(separator + 1)) };
  } catch {
    throw usageError(`invalid --rate-limit "${raw}" — ${RATE_LIMIT_HINT}`);
  }
};

const MAX_RETRIES_FLAG = 3;
const parseRetries = (raw: string): number => {
  if (!/^\d$/u.test(raw) || Number(raw) > MAX_RETRIES_FLAG) {
    throw usageError(
      `invalid --retries "${raw}" — expected an integer from 0 to ${MAX_RETRIES_FLAG}`,
    );
  }
  return Number(raw);
};

const parseRequestTimeout = (raw: string): number => {
  try {
    return parseDuration(raw);
  } catch {
    throw usageError(`invalid --request-timeout "${raw}" — expected <int><s|m|h|d>, e.g. "30s"`);
  }
};

// Parses and cross-validates every API-request flag into one trusted config.
// Every failure here is a startup usageError (exit 2), before any network
// call or credential use.
export const resolveApiConfig = (cmdOpts: ApiCmdOpts, ctx: CliContext): ResolvedApiConfig => {
  const secretHeaders = parseSecretHeaders(cmdOpts.headerEnv, ctx.env);
  const staticHeaders = parseStaticHeaders(cmdOpts.header);
  const reservedHeaderNames = crossValidateHeaders(staticHeaders, secretHeaders);
  // Marker-collision startup footgun: a --header-env value is ALWAYS a real
  // credential and is always registered. A static --header value shorter
  // than MIN_SECRET_REGISTRATION_LENGTH is excluded — createRedactor
  // computes no encoding variants below that length anyway (see the
  // ResolvedApiConfig comment above), and registering one risks
  // createRedactor's own substring-of-the-marker guard throwing at startup
  // for an entirely legitimate, non-secret value (e.g.
  // `--header Accept-Language:da` — "da" is a substring of "[redacted]").
  const secretValues = [
    ...secretHeaders.map((header) => header.value),
    ...staticHeaders
      .map((header) => header.value)
      .filter((value) => value.length >= MIN_SECRET_REGISTRATION_LENGTH),
  ];
  const maxResponseBytes = parseMaxResponseBytes(cmdOpts.maxResponseBytes);
  const baseUrlOverride =
    cmdOpts.baseUrl === undefined ? undefined : validateBaseUrl(cmdOpts.baseUrl);
  return {
    ...(baseUrlOverride === undefined ? {} : { baseUrlOverride }),
    staticHeaders,
    secretHeaders,
    reservedHeaderNames,
    secretValues,
    maxResponseBytes,
    allowInsecureHttp: cmdOpts.allowInsecureHttp === true,
    maxConcurrency: parseMaxConcurrency(cmdOpts.maxConcurrency),
    rateLimit: parseRateLimit(cmdOpts.rateLimit),
    requestTimeoutMs: parseRequestTimeout(cmdOpts.requestTimeout),
    retries: parseRetries(cmdOpts.retries),
    propagateTraceContext: cmdOpts.tracePropagation !== false,
  };
};

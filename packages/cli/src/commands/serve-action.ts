// The body of `openapi-mcp serve`, loaded on demand by serve.ts (issue
// kaisers-io/openapi-mcp-archive#91): the MCP SDK, the HTTP transport, hono and
// the executor are only evaluated when a server actually starts, not for
// --version, tools, cache or doctor.
import { isIP } from 'node:net';
import type { Command } from '@commander-js/extra-typings';
import {
  assertAllowedRedirectTarget,
  buildSnapshot,
  buildToolsDeferred,
  cacheNamespace,
  canonicalSourceOf,
  completeTools,
  createClientCredentialsSource,
  createEnvelopeCompiler,
  lazyEnvelopeValidators,
  MAX_REDACTED_SECRETS,
  discoverApprovalWarning,
  createExecutor,
  createCallStats,
  createMetaExecutor,
  createOAuthResourceServer,
  formatCallLog,
  createRateLimiter,
  createRouteTable,
  createRedactor,
  createStreamableHttpServer,
  apiOfToolName,
  EXIT,
  isValidBearerToken,
  parseSpecSource,
  qualifyTools,
  assignToolNames,
  AUTO_DISCOVER_DEFINITION_BYTES,
  AUTO_DISCOVER_THRESHOLD,
  chooseToolMode,
  definitionBytes,
  runSpecPipeline,
  SPEC_BUDGETS,
  serveStdioSession,
  SYSTEM_HEADERS,
  unsatisfiedSecurityWarnings,
  TOOL_MODES,
  usageError,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  CallObserver,
  EnvelopeValidator,
  EnvelopeValidators,
  ExecutorConfig,
  NormalizedSpec,
  RequestedToolMode,
  OAuthGuardOptions,
  RequestGuardOptions,
  UnsupportedParameterOptIn,
} from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import {
  apiViews,
  assertSeparateBases,
  assertSeparateNamespaces,
  combinedContentHash,
  parseImageResponseMode,
  resolveApiConfig,
  resolveImageResponses,
  resolveUploadOptions,
  uploadFolderPath,
} from '../api-options.ts';
import type { ApiCmdOpts, Occurrence } from '../api-options.ts';
import { resolveTokenUrl } from '../oauth-options.ts';
import type { CliContext } from '../context.ts';
import { emitError, emitWarnings } from '../output.ts';
import {
  exposureReport,
  filterMessages,
  nullableOption,
  omissionWarningLines,
  OUTPUT_SCHEMA_FORMS,
  parseSpecPipelineArgs,
  reachableTools,
  toolsBuiltInPipeline,
  unsupportedParameterLines,
  withOutputSchemaOptOut,
} from '../spec-options.ts';
import type { SpecCmdOpts } from '../spec-options.ts';
import type { RunState } from '../main.ts';

// Fixed operational budgets for the runtime API executor. No CLI flag exists
// for these (ApiCmdOpts covers auth/base-url/response size/cleartext-gating
// only) — they bound the OUTBOUND request the way --max-response-bytes bounds
// the inbound one, and are conservative enough never to reject a well-formed
// request against a real API.
const MAX_URL_LENGTH = 8192;
const MAX_HEADER_BYTES = 16_384;

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// At most one transport warning per this window, per route.
const TRANSPORT_WARNING_WINDOW_MS = 1000;

// The BOUNDED stderr route both transports' out-of-band error sinks report
// through. A sink that fires once per unservable request is an amplifier: a
// client holding a valid bearer (or, on stdio, the one client there is) can
// drive one synchronous stderr write per malformed request for as long as it
// likes — enough to swamp a terminal or fill a log with text it chose. This
// caps that at one framed line per window and drops the rest, and — the part
// that keeps a drop from being a silent lie — reports HOW MANY were dropped
// on the next line that does get through.
//
// Check-on-emit, never a timer: nothing is scheduled, so this holds no
// pending work that could keep the event loop alive past a shutdown signal.
// The accepted cost is that a burst suppressed at the very END of a run is
// never reported, since no later warning arrives to carry the count.
//
// The clock is `ctx.now` — the same injected clock the rest of the command
// uses, never Date.now directly — so the window is exercised with a fake
// clock instead of by sleeping. Text still goes through emitWarnings, so
// every line (the suppression notice included) stays sanitized and framed.
export const createTransportWarningRoute = (
  ctx: CliContext,
  label: string,
): ((error: Error) => void) => {
  let lastEmittedMs: number | undefined;
  let suppressed = 0;
  return (error: Error): void => {
    const nowMs = ctx.now();
    if (lastEmittedMs !== undefined && nowMs - lastEmittedMs < TRANSPORT_WARNING_WINDOW_MS) {
      suppressed += 1;
      return;
    }
    lastEmittedMs = nowMs;
    const dropped = suppressed;
    suppressed = 0;
    emitWarnings(ctx, [
      ...(dropped === 0
        ? []
        : [`${label}: ${String(dropped)} more warning${dropped === 1 ? '' : 's'} suppressed`]),
      `${label}: ${error.message}`,
    ]);
  };
};

const tryParseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

// Same scheme/userinfo/query/fragment shape api-options.ts's own
// `validateBaseUrl` enforces on an operator-supplied `--base-url` — applied
// here uniformly to EVERY resolved base (trusted or spec-derived) so the
// executor never receives a base URL shaped differently depending on which
// branch produced it. Never echoes the raw url (may carry a spec-embedded
// credential or query secret) — only origin+path.
export const assertBaseUrlShape = (url: URL): void => {
  const problem = (
    [
      [url.protocol !== 'http:' && url.protocol !== 'https:', 'scheme must be http or https'],
      [url.username !== '' || url.password !== '', 'must not embed credentials in the URL'],
      [url.search !== '', 'must not contain a query string'],
      [url.hash !== '', 'must not contain a fragment'],
    ] as const
  ).find(([bad]) => bad);
  if (problem !== undefined) {
    throw usageError(
      `the resolved API base URL (${url.origin}${url.pathname}) is invalid — ${problem[1]}; pass --base-url to override`,
      'base_url_unresolved',
    );
  }
};

export type ResolvedBase = {
  url: URL;
  // True iff the base came from the OPERATOR-supplied --base-url — a trusted
  // origin skips the startup address (egress) check below; a spec-derived
  // base is always untrusted regardless of --allow-private-network.
  trusted: boolean;
};

// Base-URL resolution order: `--base-url` wins (trusted); else an ABSOLUTE
// `servers[0]` candidate is used as-is (untrusted); else a RELATIVE/absent
// candidate resolves against the spec's own FINAL, post-redirect source URL
// (`displaySource`) — OpenAPI's own "no servers -> root of the document's
// location" default — but ONLY when the spec came from a URL; a FILE spec
// with no usable server candidate has no document location to resolve
// against, so it is a startup usage error requiring `--base-url`.
export const resolveBaseUrl = (
  baseUrlOverride: string | undefined,
  spec: NormalizedSpec,
  displaySource: string,
  specSourceIsFile: boolean,
): ResolvedBase => {
  if (baseUrlOverride !== undefined) {
    return { url: new URL(baseUrlOverride), trusted: true };
  }
  if (spec.serverUrl !== undefined && spec.serverUrlIsRelative !== true) {
    return { url: new URL(spec.serverUrl), trusted: false };
  }
  // A server URL rejected for size (the pipeline already warned why) must not
  // fall back to the document origin: requests would silently go to the spec
  // host instead of the API the spec names
  if (spec.serverUrlRejected !== undefined) {
    throw usageError(
      'the spec has no absolute server URL to use as the API base (servers[0].url is over ' +
        `the ${String(SPEC_BUDGETS.maxServerUrlBytes)}-byte server URL budget) — pass --base-url <url>`,
      'base_url_unresolved',
    );
  }
  if (specSourceIsFile) {
    throw usageError(
      'the spec has no absolute server URL to use as the API base — pass --base-url <url>',
      'base_url_unresolved',
    );
  }
  const documentBase = tryParseUrl(displaySource);
  if (documentBase === undefined) {
    throw usageError(
      'the spec has no absolute server URL to use as the API base — pass --base-url <url>',
      'base_url_unresolved',
    );
  }
  const resolved =
    spec.serverUrl === undefined
      ? new URL('/', documentBase)
      : new URL(spec.serverUrl, documentBase);
  return { url: resolved, trusted: false };
};

// Mirrors SpecCmdOpts's own "hand-written mirror of the accumulated option
// shape" idiom (see spec-options.ts's comment on registerSpecOptions).
// SpecCmdOpts's members (spec/allow/deny/strictFilters/specHeaderEnv/timeout/
// ttl/cacheKey/trustSpecUpdates/allowPrivateNetwork) and ApiCmdOpts's members
// (baseUrl/headerEnv/header/maxResponseBytes/allowInsecureHttp) share no name
// with each other or with this type's own http/port/httpTokenEnv, and both
// share the identical `[key: string]: unknown` index signature, so the
// three-way intersection below cannot silently collapse any inherited
// member's type to `never`.
export type ServeCmdOpts = SpecCmdOpts &
  ApiCmdOpts & {
    http?: boolean;
    port: string;
    httpTokenEnv?: string;
    httpAuth: string;
    httpHost?: string;
    oauthIssuer?: string;
    oauthAudience?: string;
    oauthRequiredScope?: string[];
    log?: string;
    toolsPageSize?: string;
    responseProjection?: boolean;
    allowOffsiteRedirects?: boolean;
    toolMode: string;
    execute?: boolean;
    outputSchema: string;
    outputSchemaDescriptions: boolean;
    imageResponses: string;
    imageDirMaxBytes: string;
    uploads?: boolean;
    // Several APIs (issue #16, multi-api.ts)
    api?: string[];
    enable?: string[];
  };

type HttpAuthConfig =
  | { kind: 'static'; token: string }
  | { kind: 'oauth'; issuer: string; audience: string; requiredScopes: string[] };

type HttpConfig = { port: number; hostname: string; auth: HttpAuthConfig };

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

// Discovers the authorization server and loads its JWKS through the same
// pinned egress transport as the upstream API — an unreachable or
// inconsistent authorization server is a startup failure, not a 503 per
// request. Host is the audience's authority: behind a TLS-terminating
// reverse proxy, the proxy must forward the client's Host header.
export const createOAuthGuard = async (
  auth: Extract<HttpAuthConfig, { kind: 'oauth' }>,
  ctx: CliContext,
  egress: { allowPrivateNetwork: boolean; timeoutMs: number },
): Promise<OAuthGuardOptions> => {
  const oauth = await createOAuthResourceServer(
    {
      issuer: auth.issuer,
      audience: auth.audience,
      requiredScopes: auth.requiredScopes,
      ...egress,
    },
    {
      transport: ctx.transport,
      now: ctx.now,
      // Key-set notices (a failed refresh, an empty set) are already bounded
      // to one per refresh cooldown by the cache itself.
      warn: (message) => emitWarnings(ctx, [`oauth: ${message}`]),
    },
  );
  return { allowedOrigins: new Set(), allowedHost: oauth.publicHost, oauth };
};

// Without a required scope, ANY token the issuer mints for this audience
// gets full access — fine on loopback, worth saying out loud on a network.
const noRequiredScopeWarning = (config: HttpConfig): string[] =>
  config.auth.kind === 'oauth' &&
  config.auth.requiredScopes.length === 0 &&
  !LOOPBACK_ADDRESSES.has(config.hostname)
    ? [
        `oauth: no --oauth-required-scope is set, so every access token ${config.auth.issuer} issues for ${config.auth.audience} grants full access to all tools; pass --oauth-required-scope to restrict it`,
      ]
    : [];

// RFC 6749 §3.3 scope-token: printable ASCII except space, `"` and `\`.
const SCOPE_TOKEN_RE = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/u;

// The OAuth resource-server half of the HTTP config. Kept apart from the
// static-token path so neither mode can silently absorb the other's flags.
const resolveOAuthConfig = (cmdOpts: ServeCmdOpts): HttpAuthConfig => {
  if (cmdOpts.httpTokenEnv !== undefined) {
    throw usageError('--http-token-env cannot be combined with --http-auth oauth');
  }
  if (cmdOpts.oauthIssuer === undefined || cmdOpts.oauthAudience === undefined) {
    throw usageError('--http-auth oauth requires --oauth-issuer <url> and --oauth-audience <uri>');
  }
  const requiredScopes = cmdOpts.oauthRequiredScope ?? [];
  const badScope = requiredScopes.find((scope) => !SCOPE_TOKEN_RE.test(scope));
  if (badScope !== undefined) {
    throw usageError('--oauth-required-scope values must be single OAuth scope tokens');
  }
  return {
    kind: 'oauth',
    issuer: cmdOpts.oauthIssuer,
    audience: cmdOpts.oauthAudience,
    requiredScopes,
  };
};

// The bind address. Only an IP literal is accepted (no name resolution at
// bind time), and anything but loopback only in OAuth mode with an https
// audience: binding a network interface while clients are told to use
// cleartext would put access tokens on the wire unprotected.
const resolveBindAddress = (cmdOpts: ServeCmdOpts, auth: HttpAuthConfig): string => {
  const hostname = cmdOpts.httpHost ?? '127.0.0.1';
  if (isIP(hostname) === 0) {
    throw usageError(`--http-host "${hostname}" must be an IP address`);
  }
  if (
    !LOOPBACK_ADDRESSES.has(hostname) &&
    auth.kind === 'oauth' &&
    !auth.audience.toLowerCase().startsWith('https:')
  ) {
    throw usageError('a non-loopback --http-host requires an https --oauth-audience');
  }
  return hostname;
};

// Upper bound for --tools-page-size: the spec budget's tool cap, so a larger
// value could never page anyway.
const MAX_TOOLS_PAGE_SIZE = SPEC_BUDGETS.maxToolCount;

const parseToolsPageSize = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(raw) || Number(raw) > MAX_TOOLS_PAGE_SIZE) {
    throw usageError(
      `invalid --tools-page-size "${raw}" — expected an integer from 1 to ${MAX_TOOLS_PAGE_SIZE}`,
    );
  }
  return Number(raw);
};

// Validated like --port: before any spec, cache or network work.
const parseToolMode = (raw: string): RequestedToolMode => {
  const mode = TOOL_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw usageError(`--tool-mode "${raw}" is not one of ${TOOL_MODES.join(', ')}`);
  }
  return mode;
};

// --output-schema (issue #9), validated like --tool-mode: `defs` shows output
// schemas in their compact `$defs` form.
const parseOutputSchemaForm = (raw: string): boolean => {
  const form = OUTPUT_SCHEMA_FORMS.find((candidate) => candidate === raw);
  if (form === undefined) {
    throw usageError(`--output-schema "${raw}" is not one of ${OUTPUT_SCHEMA_FORMS.join(', ')}`);
  }
  return form === 'defs';
};

// The registered `serve` command: resolveHttpConfig reads per-option provenance
// from it (getOptionValueSource).
export type ServeCommand = Pick<Command<[], ServeCmdOpts>, 'getOptionValueSource'>;

// Orphaned HTTP-only flags without --http are a usage error, not a
// silent no-op: `--port` carries a default ('3044'), so a plain value
// comparison would MISS an explicit `--port 3044`. Commander records
// per-option provenance — `getOptionValueSource('port') === 'cli'`
// distinguishes "the user actually passed --port" from "the default
// applied" regardless of whether the passed value happens to equal
// the default.
export const resolveHttpConfig = (
  command: ServeCommand,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
): HttpConfig | undefined => {
  const oauthFlagGiven =
    cmdOpts.oauthIssuer !== undefined ||
    cmdOpts.oauthAudience !== undefined ||
    cmdOpts.oauthRequiredScope !== undefined;
  if (
    cmdOpts.http !== true &&
    (cmdOpts.httpTokenEnv !== undefined ||
      command.getOptionValueSource('port') === 'cli' ||
      command.getOptionValueSource('httpAuth') === 'cli' ||
      cmdOpts.httpHost !== undefined ||
      oauthFlagGiven)
  ) {
    throw usageError(
      '--port, --http-token-env, --http-auth, --http-host, --oauth-issuer, --oauth-audience and --oauth-required-scope require --http',
    );
  }
  if (cmdOpts.http !== true) {
    return undefined;
  }
  if (cmdOpts.httpAuth !== 'static' && cmdOpts.httpAuth !== 'oauth') {
    throw usageError(`--http-auth must be "static" or "oauth", not "${cmdOpts.httpAuth}"`);
  }
  if (cmdOpts.httpAuth === 'static' && (oauthFlagGiven || cmdOpts.httpHost !== undefined)) {
    throw usageError(
      '--http-host, --oauth-issuer, --oauth-audience and --oauth-required-scope require --http-auth oauth',
    );
  }
  const port = Number(cmdOpts.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw usageError(`--port "${cmdOpts.port}" is not a valid port number`);
  }
  if (cmdOpts.httpAuth === 'oauth') {
    const auth = resolveOAuthConfig(cmdOpts);
    return { port, hostname: resolveBindAddress(cmdOpts, auth), auth };
  }
  if (cmdOpts.httpTokenEnv === undefined) {
    throw usageError('--http requires --http-token-env <ENV>');
  }
  const token = ctx.env[cmdOpts.httpTokenEnv];
  if (token === undefined || token === '') {
    throw validationError(`env var "${cmdOpts.httpTokenEnv}" is not set`, 'env_missing');
  }
  if (!isValidBearerToken(token)) {
    throw validationError(
      `the token in "${cmdOpts.httpTokenEnv}" must decode to exactly 32 bytes (256 bits) — 43 unpadded ` +
        'Base64URL characters, or 44-character padded standard Base64 (e.g. `openssl rand -base64 32`)',
    );
  }
  return { port, hostname: '127.0.0.1', auth: { kind: 'static', token } };
};

// Everything `serve` needs before it accepts a client. A separate function
// so that its locals (the normalized spec of every operation, the generated
// tools before the snapshot, the reports) are released once it returns,
// instead of living in the suspended frame of runServe for the whole
// session (issue #47).
// One API's spec, loaded and built (phase 1): enough to count its tools, so
// the tool mode can be decided over every API before anything else
type LoadedApi = {
  // Undefined for the single API of `--spec`
  name: string | undefined;
  cmdOpts: ServeCmdOpts;
  apiConfig: ReturnType<typeof resolveApiConfig>;
  args: ReturnType<typeof parseSpecPipelineArgs>;
  result: Awaited<ReturnType<typeof runSpecPipeline>>;
  filterWarnings: string[];
  uploads: Awaited<ReturnType<typeof resolveUploadOptions>>;
  generated: ReturnType<typeof buildToolsDeferred>;
  // The HEADs no call can pass (issue #68): left out of the tools, so the
  // tool mode is decided without them
  unreachable: ReadonlyMap<string, string>;
  // --omit-unsupported-parameters, matched on this API's operations
  optIn: UnsupportedParameterOptIn;
  // Built in full when `--tool-mode auto` sizes the tool definitions; reused
  // in either mode, never built twice (issue #61)
  completed?: ReturnType<typeof completeTools>;
};

const loadApi = async (
  name: string | undefined,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  requestedToolMode: RequestedToolMode,
  httpConfig: HttpConfig | undefined,
  inspect: boolean,
): Promise<LoadedApi> => {
  // Resolved BEFORE buildTools (below): its reservedHeaderNames must be
  // unioned into buildTools' reservedHeaders so a spec header parameter
  // colliding with a configured auth header name is dropped from the
  // tool's input schema, not merely rejected later at call time.
  const apiConfig = resolveApiConfig(cmdOpts, ctx);
  const args = parseSpecPipelineArgs(cmdOpts, ctx);
  // Before the tools are built: their binary fields name this folder
  const uploadInput = {
    enabled: cmdOpts.uploads === true,
    homeDir: ctx.homeDir(),
    source: args.source,
    cwd: ctx.cwd(),
    ...(args.options.cacheKey === undefined ? {} : { cacheKey: args.options.cacheKey }),
    ...(httpConfig === undefined ? {} : { httpHost: httpConfig.hostname }),
    maxBytes: apiConfig.maxResponseBytes,
    now: ctx.now(),
  };
  // `check` (issue #77) names the folder but neither creates nor sweeps it
  const uploads = inspect ? undefined : await resolveUploadOptions(uploadInput);
  const uploadDir = inspect ? uploadFolderPath(uploadInput) : uploads?.folder.path;
  if (uploads !== undefined && uploads.deleted > 0) {
    emitWarnings(
      ctx,
      withApi(name, [
        `--uploads: removed ${String(uploads.deleted)} file(s) older than 24 hours from ${uploads.folder.path}`,
      ]),
    );
  }
  // Built inside the pipeline, so the tool budget counts these tools before
  // anything is cached (issue #67). Union: a spec header parameter named
  // e.g. "X-Api-Key" is dropped from the tool's input schema when that same
  // name is configured as an operator auth header (--header/--header-env) —
  // SYSTEM_HEADERS alone would let it reappear as a caller-settable input,
  // silently colliding with the credential the executor injects.
  const building = toolsBuiltInPipeline(
    args.filters.omitUnsupportedParameters,
    (exposed, omitUnsupportedParameters) =>
      buildToolsDeferred(exposed.namedOperations, {
        omitUnsupportedParameters,
        reservedHeaders: new Set([...SYSTEM_HEADERS, ...apiConfig.reservedHeaderNames]),
        openapiVersion: exposed.spec.openapiVersion,
        projection: cmdOpts.responseProjection === true,
        ...(uploadDir === undefined ? {} : { uploadDir }),
        defaultResponseIsError: cmdOpts.defaultResponseIsError === true,
        ...nullableOption(cmdOpts.nullableResponseFields),
      }),
  );
  // The exposed-set budget follows the tool mode: one tool per operation
  // keeps the 512-tool budget; discover (and auto, which only ever picks
  // per-operation at or below its 64-operation threshold) lifts it, since
  // its tools/list no longer grows with the operation count.
  const result = await runSpecPipeline(
    args.source,
    {
      ...args.options,
      maxToolCount:
        requestedToolMode === 'per-operation'
          ? SPEC_BUDGETS.maxToolCount
          : SPEC_BUDGETS.maxDiscoverToolCount,
      countTools: building.countTools,
    },
    args.deps,
  );
  const { built: deferred, optIn, optInWarnings, unreachable } = building.take();
  // Sanitized + suggestion-bearing, matching `tools`' strict-filters
  // throw exactly (deadPatternMessage is the shared renderer): building
  // the message inline instead would put unsanitized spec-derived text
  // straight into a thrown error's message.
  // --omit-unsupported-parameters (issue #67): its dead patterns are
  // filter diagnostics like the others
  const filterWarnings = [...filterMessages(result), ...optInWarnings];
  if (cmdOpts.strictFilters === true && filterWarnings.length > 0) {
    throw validationError(withApi(name, filterWarnings).join('\n'));
  }
  return {
    name,
    cmdOpts,
    apiConfig,
    args,
    result,
    filterWarnings,
    uploads,
    generated: deferred,
    unreachable,
    optIn,
  };
};

// Several APIs (issue #16): every line says which API it is about
const withApi = (name: string | undefined, lines: readonly string[]): string[] =>
  name === undefined ? [...lines] : lines.map((line) => `${name}: ${line}`);

// Several APIs (issue #16): every tool is named `<api>_<name>`, decided over
// every operation of the spec, so filters never move a name to another
// operation
const qualified = <Built extends Parameters<typeof qualifyTools>[0]>(
  api: LoadedApi,
  built: Built,
): Built =>
  api.name === undefined
    ? built
    : qualifyTools(
        built,
        api.name,
        assignToolNames(api.result.spec.operations).map((named) => named.toolName),
      );

// One API, finished for the chosen tool mode (phase 3): its tools, its
// reports, and the executor configuration of its own calls (the redactor
// and the validators are shared and set later)
const finishApi = async (api: LoadedApi, deferOutput: boolean, ctx: CliContext) => {
  const { name, cmdOpts, apiConfig, args, result } = api;
  const optOut =
    deferOutput && api.completed === undefined
      ? { built: api.generated, deadPatterns: [], warnings: [] }
      : withOutputSchemaOptOut(
          api.completed ?? completeTools(api.generated),
          args.filters.omitOutputSchema,
          result.spec,
          cmdOpts.strictFilters === true,
        );
  const exposure = exposureReport(result, optOut.built, cmdOpts.strictFilters === true);
  // After the opt-out and the exposure report, so their selectors and
  // reports use the API's own names
  const built = qualified(api, exposure.built);

  // Resolve + validate the API base URL: --base-url (trusted, address
  // check skipped) else the spec-derived candidate (untrusted — a
  // bounded startup egress classification runs below).
  const specSourceIsFile = parseSpecSource(args.source, { cwd: ctx.cwd() }).kind === 'file';
  const resolvedBase = resolveBaseUrl(
    apiConfig.baseUrlOverride,
    result.spec,
    result.displaySource,
    specSourceIsFile,
  );
  assertBaseUrlShape(resolvedBase.url);
  const allowPrivateNetwork = cmdOpts.allowPrivateNetwork === true;
  if (!resolvedBase.trusted) {
    // Bounded resolve + classifyAddress, respecting
    // --allow-private-network; metadata is denied unconditionally. The
    // per-connection DNS pin (pinnedRequest) remains the actual runtime
    // control — this is a fail-fast startup check only.
    await assertAllowedRedirectTarget(
      resolvedBase.url,
      { allowPrivateNetwork },
      ctx.lookup,
      AbortSignal.timeout(args.options.timeoutMs),
    );
  }

  // OAuth2 client-credentials: the token URL receives the client
  // secret, so it is resolved and checked here, at startup — shape and
  // origin (resolveTokenUrl), then the same bounded egress
  // classification as an untrusted base (metadata never; private only
  // with --allow-private-network — even for --upstream-oauth-token-url). The
  // per-request DNS pin remains the runtime control.
  const { oauth } = apiConfig;
  const tokenUrl =
    oauth === undefined
      ? undefined
      : resolveTokenUrl(oauth, result.spec, resolvedBase, specSourceIsFile);
  if (tokenUrl !== undefined) {
    try {
      await assertAllowedRedirectTarget(
        tokenUrl,
        { allowPrivateNetwork },
        ctx.lookup,
        AbortSignal.timeout(args.options.timeoutMs),
      );
    } catch (error) {
      throw validationError(
        withApi(name, [`the OAuth token URL is refused: ${describeCause(error)}`]).join('\n'),
      );
    }
  }
  const configuredHeaderNames = new Set(
    [...apiConfig.staticHeaders, ...apiConfig.secretHeaders].map((header) =>
      header.name.toLowerCase(),
    ),
  );
  // Startup diagnostics — cache staleness, a pending candidate, dead
  // patterns under non-strict mode (e.g. a mistyped --deny silently
  // failing open), and omitted operations — go to stderr, sanitized
  // and framed through the SAME emitWarnings() path `tools` uses via
  // emit(), never raw. Full parity with `tools`' warnings array.
  const warnings = withApi(name, [
    ...result.warnings,
    ...api.filterWarnings,
    ...omissionWarningLines([...result.spec.omitted, ...built.omitted]),
    ...unsupportedParameterLines(exposure.built.tools, exposure.built.omitted, api.optIn),
    ...optOut.warnings,
    ...exposure.warnings,
    // Exposed operations whose `security` requirement no configured
    // header satisfies would only ever 401 — say so, with the flag that
    // fixes it, before the first call instead of after it.
    ...unsatisfiedSecurityWarnings(
      result.spec,
      built.tools.map((tool) => tool.operation),
      { headerNames: configuredHeaderNames, oauthClientCredentials: oauth !== undefined },
    ),
  ]);
  return {
    api,
    built,
    exposure,
    // The status tool counts the --omit-output-schema dead patterns too
    pipeline: {
      ...result,
      deadPatterns: [...result.deadPatterns, ...optOut.deadPatterns, ...api.optIn.deadPatterns],
      notExposedCounts: exposure.counts,
    },
    resolvedBase,
    allowPrivateNetwork,
    tokenUrl,
    warnings,
  };
};

type FinishedApi = Awaited<ReturnType<typeof finishApi>>;

// Hosts add their own prefix to a tool name and accept 64 characters at most
// (Claude Code: mcp__<server>__<tool>; Cursor: 60 for server and tool name):
// a qualified per-operation name longer than this leaves too little room
const QUALIFIED_NAME_WARN_LENGTH = 50;

const sumCounts = (counts: readonly Record<string, number>[]): Record<string, number> =>
  counts.reduce<Record<string, number>>((sum, entry) => {
    for (const [key, value] of Object.entries(entry)) {
      sum[key] = (sum[key] ?? 0) + value;
    }
    return sum;
  }, {});

const prepareServe = async (
  command: ServeCommand,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  occurrences: readonly Occurrence[],
  onExecutor: (close: () => Promise<void>) => void,
  // `check` (issue #77): the same preparation without touching the upload
  // folder, and every output schema compiled now, also under discover
  inspect = false,
) => {
  // HTTP-specific options are validated FIRST — BEFORE any spec/cache/
  // network processing — so a bad --port or --http-token-env fails
  // fast with NO side effects (no spec fetch, no cache write). This
  // matches "validated once at CLI startup" rather than discovering
  // the mistake only after paying for a spec fetch.
  const httpConfig = resolveHttpConfig(command, cmdOpts, ctx);
  if (cmdOpts.log !== undefined && cmdOpts.log !== 'json') {
    throw usageError(`invalid --log "${cmdOpts.log}" — the only supported format is "json"`);
  }
  const logJson = cmdOpts.log === 'json';
  const toolsPageSize = parseToolsPageSize(cmdOpts.toolsPageSize);
  const paging = toolsPageSize === undefined ? {} : { toolsPageSize };
  const requestedToolMode = parseToolMode(cmdOpts.toolMode);
  // Usage errors first, before any spec or network work
  parseImageResponseMode(cmdOpts.imageResponses);
  const compactOutputSchemas = parseOutputSchemaForm(cmdOpts.outputSchema);
  // Several APIs (issue #16), every option split by its API; or the one
  // API of --spec, exactly as before
  const views = apiViews(cmdOpts, occurrences, optionDefaults(command));
  if (views === undefined && (cmdOpts.spec as string | undefined) === undefined) {
    throw usageError(
      "required option '--spec <url|file>' not specified (or --api <name>=<source>)",
    );
  }
  const declared = views ?? [{ name: undefined, source: cmdOpts.spec, options: cmdOpts }];
  // Every API's options are validated before any spec or network work, and
  // their caches are checked to be separate before any of them is touched
  const namespaces = declared.map((view) => {
    const viewConfig = resolveApiConfig(view.options, ctx);
    const viewArgs = parseSpecPipelineArgs(view.options, ctx);
    const source = canonicalSourceOf(parseSpecSource(viewArgs.source, { cwd: ctx.cwd() }));
    return {
      name: String(view.name),
      base: viewConfig.baseUrlOverride,
      namespace: cacheNamespace(source, viewArgs.options.cacheKey),
      secrets: [
        ...viewArgs.options.specHeaders.map((header) => header.value),
        ...viewConfig.secretValues,
      ].length,
    };
  });
  if (views !== undefined) {
    assertSeparateNamespaces(namespaces);
    // Explicit base URLs are known now; a spec-derived one only once loaded
    assertSeparateBases(
      namespaces.flatMap(({ name, base }) =>
        base === undefined ? [] : [{ name, base: new URL(base) }],
      ),
    );
    // One redactor holds the secrets of every API, and the HTTP bearer token
    const secrets =
      namespaces.reduce((sum, api) => sum + api.secrets, 0) +
      (httpConfig?.auth.kind === 'static' ? 1 : 0);
    if (secrets > MAX_REDACTED_SECRETS) {
      throw usageError(
        `all APIs together configure ${String(secrets)} secret values (${namespaces.map((api) => `${api.name}: ${String(api.secrets)}`).join(', ')}); one server holds at most ${String(MAX_REDACTED_SECRETS)}`,
      );
    }
  }
  const loaded: LoadedApi[] = [];
  for (const view of declared) {
    loaded.push(
      await loadApi(view.name, view.options, ctx, requestedToolMode, httpConfig, inspect),
    );
  }
  const toolCount = loaded.reduce(
    (sum, api) => sum + reachableTools(api.generated.tools, api.unreachable).length,
    0,
  );
  const budget =
    requestedToolMode === 'per-operation'
      ? SPEC_BUDGETS.maxToolCount
      : SPEC_BUDGETS.maxDiscoverToolCount;
  // One API's budget is enforced in its pipeline, on its built tools
  if (views !== undefined && toolCount > budget) {
    throw validationError(
      `${String(toolCount)} tools would be exposed by all APIs together — exceeds the ${String(budget)}-tool budget; narrow them with --allow or --deny`,
    );
  }
  const choice = chooseToolMode(requestedToolMode, toolCount, () => {
    for (const api of loaded) {
      api.completed = completeTools(api.generated);
    }
    // Sized as the host lists them, with their qualified names (review of #61)
    return definitionBytes(
      loaded.flatMap((api) =>
        api.completed === undefined
          ? []
          : reachableTools(qualified(api, api.completed).tools, api.unreachable),
      ),
    );
  });
  const { toolMode } = choice;
  if (choice.reason !== undefined) {
    emitWarnings(ctx, [
      choice.reason === 'count'
        ? `--tool-mode auto: discover, since ${String(toolCount)} operations are exposed (more than ${String(AUTO_DISCOVER_THRESHOLD)})`
        : `--tool-mode auto: discover, since the tool definitions take more than ${String(AUTO_DISCOVER_DEFINITION_BYTES)} bytes; --tool-mode per-operation keeps one tool per operation`,
    ]);
  }
  // Under discover, each operation's output side is built on first use
  // (issue #47): nothing at startup lists it. --omit-output-schema needs
  // every tool's output schema to report its patterns, so it builds them now,
  // and then for every API: one snapshot holds either complete or deferred
  // tools, never both (review of #16)
  const deferOutput =
    toolMode === 'discover' &&
    loaded.every((api) => api.args.filters.omitOutputSchema.length === 0);
  const finished: FinishedApi[] = [];
  for (const api of loaded) {
    finished.push(await finishApi(api, deferOutput, ctx));
  }
  const multi = views !== undefined;
  if (multi) {
    assertSeparateBases(
      finished.map(({ api, resolvedBase }) => ({ name: String(api.name), base: resolvedBase.url })),
    );
  }
  const [first] = finished as [FinishedApi, ...FinishedApi[]];
  // Every API is built in the same mode, so their tools are all complete or
  // all deferred
  const built = {
    tools: finished.flatMap((api) => api.built.tools as readonly unknown[]),
    omitted: finished.flatMap((api) => api.built.omitted),
  } as unknown as typeof first.built;
  const pipeline = multi
    ? {
        spec: {
          title: finished.map((api) => String(api.api.name)).join(', '),
          specVersion: '',
          omitted: finished.flatMap((api) => api.pipeline.spec.omitted),
        },
        contentHash: combinedContentHash(
          finished.map((api) => ({ name: String(api.api.name), hash: api.pipeline.contentHash })),
        ),
        displaySource: finished.map((api) => String(api.api.name)).join(', '),
        deadPatterns: finished.flatMap((api) => api.pipeline.deadPatterns),
        withheldOperations: finished.flatMap((api) => api.pipeline.withheldOperations ?? []),
        notExposedCounts: sumCounts(
          finished.map((api) => api.exposure.counts),
        ) as typeof first.exposure.counts,
        cacheLock: finished.find((api) => api.pipeline.cacheLock !== undefined)?.pipeline.cacheLock,
        apis: finished.map((api) => ({
          name: String(api.api.name),
          specTitle: api.pipeline.spec.title,
          specVersion: api.pipeline.spec.specVersion,
          displaySource: api.pipeline.displaySource,
          toolCount: api.built.tools.length,
          omittedCount:
            api.pipeline.spec.omitted.length +
            api.built.omitted.length +
            (api.pipeline.withheldOperations?.length ?? 0),
          acceptedContentHash: api.pipeline.contentHash,
          deadPatternCount: api.pipeline.deadPatterns.length,
          notExposedCounts: api.exposure.counts,
        })),
      }
    : first.pipeline;
  const snapshot = buildSnapshot(built, pipeline, {
    toolMode,
    // On by default: in every measured set of tasks, each mode answered as
    // correctly with it and needed fewer tool calls (issue #60)
    execute: cmdOpts.execute !== false,
    compactOutputSchemas,
    bareOutputSchemas: !cmdOpts.outputSchemaDescriptions,
    ...(multi
      ? {
          apiNames: finished.map((api) => String(api.api.name)) as [string, ...string[]],
        }
      : {}),
    onDeferredError: (toolName, error) => {
      emitWarnings(ctx, [
        `tool "${toolName}" has an output side that cannot be built, so describing or calling it fails: ${describeCause(error)}`,
      ]);
    },
  });

  // One redactor for the whole process: every resolved secret this
  // server ever holds — the spec-fetch auth header values, the API
  // --header/--header-env values of every API, and the HTTP bearer token
  // (if any) — feeds it, so a secret echoed anywhere (an upstream error
  // body, the dispatch boundary, a startup diagnostic) is scrubbed
  // uniformly, also when one API echoes another's.
  const redactor = createRedactor([
    ...finished.flatMap(({ api }) => [
      ...api.args.options.specHeaders.map((header) => header.value),
      ...api.apiConfig.secretValues,
    ]),
    ...(httpConfig?.auth.kind === 'static' ? [httpConfig.auth.token] : []),
  ]);

  // `validators.has` is the executor's fail-closed contract: every
  // upstream tool gets an entry, `undefined` only for a genuine
  // no-outputSchema tool. One compiler context serves the whole snapshot
  // (issue kaisers-io/openapi-mcp-archive#42): the meta-schema is compiled
  // once, not per tool, and identical schemas once (issue #7). Created per
  // snapshot, never module-global: the compiler retains every validator it
  // built, so a future snapshot reload must build a new one rather than
  // reuse this one, or old schemas pile up.
  //
  // per-operation compiles every validator HERE, at startup, so an
  // incompatible schema fails fast rather than on the first matching
  // call; its tools/list publishes every output schema anyway. discover
  // can expose up to 4,096 operations, and compiling all of them first
  // kept a large spec from answering `initialize` within common host
  // start-up timeouts (issue #8): it compiles a validator on the
  // operation's first call instead, before the request is sent.
  const compileToolValidator = createEnvelopeCompiler();
  let validators: EnvelopeValidators;
  if (snapshot.toolMode === 'discover' && !inspect) {
    const byName = snapshot.operationsByName;
    validators = lazyEnvelopeValidators(
      compileToolValidator,
      {
        has: (toolName) => Object.hasOwn(byName, toolName),
        get: (toolName) => byName[toolName]?.resolve().wireTool.outputSchema,
      },
      (toolName, error) =>
        emitWarnings(ctx, [
          `tool "${toolName}" has an output schema that cannot be compiled, so its calls fail: ${describeCause(error)}`,
        ]),
    );
  } else {
    const validatorEntries = snapshot.operations.map((entry) => {
      const tool = entry.resolve();
      try {
        return [tool.name, compileToolValidator(tool.wireTool.outputSchema)] as const;
      } catch (error) {
        throw usageError(
          `tool "${tool.name}" has an output schema that cannot be compiled: ${describeCause(error)}`,
        );
      }
    });
    validators = new Map<string, EnvelopeValidator | undefined>(validatorEntries);
  }

  const configs = new Map<string | undefined, ExecutorConfig>();
  for (const api of finished) {
    configs.set(
      api.api.name,
      await executorConfigOf(api, cmdOpts, ctx, httpConfig, redactor, validators, multi),
    );
  }
  const firstConfig = configs.get(first.api.name) as ExecutorConfig;
  // ONE executor instance, shared by the stdio AND HTTP branches below and
  // by every API, so the global outbound-concurrency semaphore is
  // genuinely shared. With several APIs each call uses its own API's
  // configuration (base URL, headers, OAuth, egress, routes).
  const executor = createExecutor(firstConfig, {
    transport: ctx.transport,
    ...(multi
      ? {
          configFor: (tool) => {
            const config = configs.get(apiOfToolName(tool.name));
            if (config === undefined) {
              throw new Error('a tool of no declared API');
            }
            return config;
          },
        }
      : {}),
  });
  onExecutor(() => executor.close());
  // Call counters always feed openapi_mcp_status; the per-call JSON line
  // is written only with --log json, and only to stderr (stdout is
  // MCP-JSON-only).
  const callStats = createCallStats();
  const onCall: CallObserver = (record) => {
    callStats.record(record);
    if (logJson) {
      const line = formatCallLog(record, redactor, new Date(ctx.now()));
      ctx.errLine(line);
    }
  };
  const dispatcherDeps = {
    onCall,
    // --rate-limit is one window for every API
    limiter: createRateLimiter(first.api.apiConfig.rateLimit),
    now: ctx.now,
    executor,
    metaExecutor: createMetaExecutor({ stats: callStats }),
    redactor,
  };
  const longNames =
    multi && snapshot.toolMode === 'per-operation'
      ? snapshot.operations.filter((entry) => entry.name.length > QUALIFIED_NAME_WARN_LENGTH)
      : [];
  emitWarnings(ctx, [
    ...finished.flatMap((api) => api.warnings),
    ...(longNames.length === 0
      ? []
      : [
          `${String(longNames.length)} tool name(s) are longer than ${String(QUALIFIED_NAME_WARN_LENGTH)} characters (e.g. "${longNames[0]?.name ?? ''}"); hosts add their own prefix and accept 64, so use shorter API names or --tool-mode discover`,
        ]),
    ...(httpConfig === undefined ? [] : noRequiredScopeWarning(httpConfig)),
    ...[discoverApprovalWarning(snapshot.toolMode, snapshot.operations)].filter(
      (line): line is string => line !== undefined,
    ),
  ]);
  return {
    httpConfig,
    snapshot,
    dispatcherDeps,
    paging,
    // Inbound OAuth (issuer discovery, JWKS) follows --allow-private-network
    // with one API; with several there is no single setting, so it stays off
    allowPrivateNetwork: multi ? false : first.allowPrivateNetwork,
    timeoutMs: first.api.args.options.timeoutMs,
    // The configuration a tool's call uses, for `call --dry-run` (issue #78)
    executorConfigFor: (tool: { name: string }): ExecutorConfig =>
      configs.get(multi ? apiOfToolName(tool.name) : first.api.name) as ExecutorConfig,
    // What `check` reports (issue #77)
    toolModeReason: choice.reason,
    warningReasons: [...new Set(finished.flatMap((entry) => entry.api.result.warningReasons))],
    apis: finished.map((entry) => ({
      name: entry.api.name,
      baseUrl: `${entry.resolvedBase.url.origin}${entry.resolvedBase.url.pathname}`,
      exposed: entry.built.tools.map((tool) => tool.toolName),
    })),
  };
};

export { prepareServe };

// The executor configuration of one API's calls
const executorConfigOf = async (
  finished: FinishedApi,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  httpConfig: HttpConfig | undefined,
  redactor: ReturnType<typeof createRedactor>,
  validators: EnvelopeValidators,
  multi: boolean,
): Promise<ExecutorConfig> => {
  const { api, exposure, resolvedBase, allowPrivateNetwork, tokenUrl } = finished;
  const { apiConfig, args, uploads } = api;
  const { oauth } = apiConfig;
  const images = await resolveImageResponses({
    mode: cmdOpts.imageResponses,
    dirMaxBytes: cmdOpts.imageDirMaxBytes,
    homeDir: ctx.homeDir(),
    source: args.source,
    cwd: ctx.cwd(),
    ...(args.options.cacheKey === undefined ? {} : { cacheKey: args.options.cacheKey }),
    ...(httpConfig === undefined ? {} : { httpHost: httpConfig.hostname }),
  });
  return {
    baseUrl: resolvedBase.url.toString(),
    baseTrusted: resolvedBase.trusted,
    // Issue #40: every hop is checked against every operation of the spec
    routes: createRouteTable(exposure.routeEntries, exposure.routes),
    allowOffsiteRedirects: api.cmdOpts.allowOffsiteRedirects === true,
    // Several APIs (issue #16): credentials only go to the API's own base URL
    ...(multi ? { credentialScope: 'api' as const } : {}),
    allowPrivateNetwork,
    allowInsecureHttp: apiConfig.allowInsecureHttp,
    secretHeaders: apiConfig.secretHeaders,
    staticHeaders: apiConfig.staticHeaders,
    reservedHeaderNames: apiConfig.reservedHeaderNames,
    redactor,
    // --request-timeout, NOT the spec fetch's --timeout: raising one for a
    // slow spec URL must not silently change every API call's deadline.
    timeoutMs: apiConfig.requestTimeoutMs,
    maxResponseBytes: apiConfig.maxResponseBytes,
    outboundBudgets: {
      maxUrlLength: MAX_URL_LENGTH,
      maxHeaderBytes: MAX_HEADER_BYTES,
      maxBodyBytes: apiConfig.maxResponseBytes,
    },
    // Global outbound-concurrency cap (--max-concurrency), shared by
    // stdio + HTTP and by every API because `createExecutor` is
    // constructed exactly ONCE; up to 4x as many calls may queue for a slot.
    maxConcurrent: apiConfig.maxConcurrency,
    // `--log json` also says why a response was refused (issue #24)
    ...(cmdOpts.log === 'json' ? { diagnoseMismatches: true } : {}),
    retries: apiConfig.retries,
    propagateTraceContext: apiConfig.propagateTraceContext,
    validators,
    ...(images === undefined ? {} : { images }),
    ...(uploads === undefined
      ? {}
      : { uploads: { folder: uploads.folder, maxBytes: uploads.maxBytes } }),
    ...(oauth === undefined || tokenUrl === undefined
      ? {}
      : {
          oauth: {
            // Access tokens are registered with `redactor` as they are
            // issued, so they are scrubbed like any startup secret.
            tokens: createClientCredentialsSource(
              {
                tokenUrl,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                scopes: oauth.scopes,
                clientAuth: oauth.clientAuth,
                allowPrivateNetwork,
                timeoutMs: apiConfig.requestTimeoutMs,
                redactor,
                now: ctx.now,
              },
              ctx.transport,
            ),
            envVarHint: oauth.envVarHint,
          },
        }),
  };
};

// Commander's default of each option an API may set for itself
export const optionDefaults = (command: ServeCommand): Record<string, unknown> =>
  Object.fromEntries(
    (
      command as unknown as { options: { attributeName: () => string; defaultValue: unknown }[] }
    ).options.map((option) => [option.attributeName(), option.defaultValue]),
  );

export const runServe = async (
  command: ServeCommand,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  state: RunState,
  occurrences: readonly Occurrence[] = [],
): Promise<void> => {
  // Serve NEVER uses wrapAction and NEVER respects the global --json
  // flag for its own error path: wrapAction's JSON envelope writes to
  // STDOUT, and stdout is MCP-JSON-only for the entire life of this
  // process. Startup failures always render as plain text on stderr.
  const errorOpts = { json: false, verbose: false };
  // Set once the executor exists. Closed in `finally` so a throw anywhere
  // after the first upstream call (e.g. httpServer.close()) still releases
  // pooled keep-alive sockets and retiring agents instead of leaving them
  // to process exit.
  let closeExecutor: (() => Promise<void>) | undefined;
  try {
    const { httpConfig, snapshot, dispatcherDeps, paging, allowPrivateNetwork, timeoutMs } =
      await prepareServe(command, cmdOpts, ctx, occurrences, (close) => {
        closeExecutor = close;
      });
    if (httpConfig === undefined) {
      const session = serveStdioSession(
        { name: 'openapi-mcp', version: pkg.version, snapshot, dispatcherDeps, ...paging },
        {
          // Out-of-band transport errors carry no JSON-RPC reply — route
          // them through the SAME sanitizing stderr path the startup
          // diagnostics use rather than dropping them, since stdout is
          // MCP-JSON-only and their text can echo client-supplied input.
          // Rate-bounded, because one line per unservable message is an
          // amplifier the client controls (see createTransportWarningRoute).
          onError: createTransportWarningRoute(ctx, 'stdio transport'),
        },
      );
      const shutdown = Promise.withResolvers<void>();
      const onShutdownSignal = (): void => shutdown.resolve();
      process.once('SIGINT', onShutdownSignal);
      process.once('SIGTERM', onShutdownSignal);
      // The session owns the connection's lifetime (it ends when the client
      // closes stdin or the transport goes away); a shutdown signal ends it
      // early. close() afterwards is unconditional and is what releases
      // stdin — without it a signalled process would idle on an open pipe
      // instead of exiting.
      await Promise.race([session.closed, shutdown.promise]);
      // `once` only removes the handler that fired: whichever signal lost
      // the race (both of them, when the connection ended on its own) would
      // otherwise keep this listener on the process for the rest of the run.
      process.removeListener('SIGINT', onShutdownSignal);
      process.removeListener('SIGTERM', onShutdownSignal);
      await session.close();
    } else {
      // No CLI flag for browser Origins (documented scope: non-browser
      // clients) — an empty allowlist means every PRESENT Origin 403s; an
      // absent Origin still works with valid credentials.
      const { auth } = httpConfig;
      const guard: RequestGuardOptions | OAuthGuardOptions =
        auth.kind === 'static'
          ? {
              allowedOrigins: new Set(),
              allowedHost: `127.0.0.1:${String(httpConfig.port)}`,
              // `http://localhost:<port>/` is how many clients are
              // configured; the listener is the same loopback socket (static
              // mode always binds 127.0.0.1, so no `[::1]` alias).
              allowedHostAliases: new Set([`localhost:${String(httpConfig.port)}`]),
              bearer: { configuredToken: auth.token },
            }
          : await createOAuthGuard(auth, ctx, {
              allowPrivateNetwork,
              timeoutMs,
            });
      const httpServer = createStreamableHttpServer({
        name: 'openapi-mcp',
        version: pkg.version,
        snapshot,
        dispatcherDeps,
        ...paging,
        guard,
        port: httpConfig.port,
        hostname: httpConfig.hostname,
        // Same reasoning — and the same bounded route — as the stdio
        // branch's onError above: an out-of-band transport error has no
        // JSON-RPC reply to ride on, and its text can echo client-supplied
        // input, so it goes through the SAME sanitizing stderr path as the
        // startup diagnostics (never raw, never stdout), at a bounded rate.
        onError: createTransportWarningRoute(ctx, 'http transport'),
      });
      await httpServer.listen();
      // Block until a graceful shutdown signal — there is no client
      // stdin stream to watch for EOF in HTTP mode (unlike the stdio
      // branch above), so SIGINT/SIGTERM are the only shutdown triggers.
      // Named handler + removeListener, mirroring the stdio branch above:
      // whichever signal loses the race would otherwise keep a listener on
      // the process throughout close(), so a second signal during a hung
      // teardown would be swallowed instead of getting default behavior.
      const shutdown = Promise.withResolvers<void>();
      const onShutdownSignal = (): void => shutdown.resolve();
      process.once('SIGINT', onShutdownSignal);
      process.once('SIGTERM', onShutdownSignal);
      await shutdown.promise;
      process.removeListener('SIGINT', onShutdownSignal);
      process.removeListener('SIGTERM', onShutdownSignal);
      await httpServer.close();
    }
    state.exitCode = EXIT.OK;
  } catch (error) {
    state.exitCode = emitError(ctx, errorOpts, error);
  } finally {
    // After the transport is gone (or failed): no further call can borrow a
    // pooled upstream connection, and an idle keep-alive socket must not
    // hold the process open past stdin EOF, a shutdown signal or an error.
    // Best effort — a close failure must not mask the exit code above.
    await closeExecutor?.().catch(() => {});
  }
};

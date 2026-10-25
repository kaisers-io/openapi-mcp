// The body of `openapi-mcp serve`, loaded on demand by serve.ts (issue
// kaisers-io/openapi-mcp-archive#91): the MCP SDK, the HTTP transport, hono and
// the executor are only evaluated when a server actually starts, not for
// --version, tools, cache or doctor.
import { isIP } from 'node:net';
import type { Command } from '@commander-js/extra-typings';
import {
  assertAllowedRedirectTarget,
  buildSnapshot,
  buildTools,
  createClientCredentialsSource,
  createEnvelopeCompiler,
  lazyEnvelopeValidators,
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
  EXIT,
  isValidBearerToken,
  parseSpecSource,
  resolveToolMode,
  routeEntriesFor,
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
} from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import { resolveApiConfig } from '../api-options.ts';
import type { ApiCmdOpts } from '../api-options.ts';
import { resolveTokenUrl } from '../oauth-options.ts';
import type { CliContext } from '../context.ts';
import { emitError, emitWarnings } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  nullableOption,
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
    );
  }
  if (specSourceIsFile) {
    throw usageError(
      'the spec has no absolute server URL to use as the API base — pass --base-url <url>',
    );
  }
  const documentBase = tryParseUrl(displaySource);
  if (documentBase === undefined) {
    throw usageError(
      'the spec has no absolute server URL to use as the API base — pass --base-url <url>',
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
    outputSchema: string;
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
const createOAuthGuard = async (
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

const OUTPUT_SCHEMA_FORMS = ['inline', 'defs'] as const;

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
type ServeCommand = Pick<Command<[], ServeCmdOpts>, 'getOptionValueSource'>;

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
    throw validationError(`env var "${cmdOpts.httpTokenEnv}" is not set`);
  }
  if (!isValidBearerToken(token)) {
    throw validationError(
      `the token in "${cmdOpts.httpTokenEnv}" must decode to exactly 32 bytes (256 bits) — 43 unpadded ` +
        'Base64URL characters, or 44-character padded standard Base64 (e.g. `openssl rand -base64 32`)',
    );
  }
  return { port, hostname: '127.0.0.1', auth: { kind: 'static', token } };
};

export const runServe = async (
  command: ServeCommand,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  state: RunState,
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
    // Resolved BEFORE buildTools (below): its reservedHeaderNames must be
    // unioned into buildTools' reservedHeaders so a spec header parameter
    // colliding with a configured auth header name is dropped from the
    // tool's input schema, not merely rejected later at call time. Also
    // validated fast, before any spec/cache/network processing, matching
    // the httpConfig check just above.
    const apiConfig = resolveApiConfig(cmdOpts, ctx);
    const requestedToolMode = parseToolMode(cmdOpts.toolMode);
    const compactOutputSchemas = parseOutputSchemaForm(cmdOpts.outputSchema);
    const args = parseSpecPipelineArgs(cmdOpts, ctx);
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
      },
      args.deps,
    );
    // Sanitized + suggestion-bearing, matching `tools`' strict-filters
    // throw exactly (deadPatternMessage is the shared renderer): building
    // the message inline instead would put unsanitized spec-derived text
    // straight into a thrown error's message.
    if (cmdOpts.strictFilters === true && result.deadPatterns.length > 0) {
      throw validationError(result.deadPatterns.map((dead) => deadPatternMessage(dead)).join('\n'));
    }
    // Union: a spec header parameter named e.g. "X-Api-Key" is dropped from
    // the tool's input schema when that same name is configured as an
    // operator auth header (--header/--header-env) — SYSTEM_HEADERS alone
    // would let it reappear as a caller-settable input, silently colliding
    // with the credential the executor injects.
    const generated = buildTools(result.namedOperations, {
      reservedHeaders: new Set([...SYSTEM_HEADERS, ...apiConfig.reservedHeaderNames]),
      openapiVersion: result.spec.openapiVersion,
      projection: cmdOpts.responseProjection === true,
      defaultResponseIsError: cmdOpts.defaultResponseIsError === true,
      ...nullableOption(cmdOpts.nullableResponseFields),
    });
    const optOut = withOutputSchemaOptOut(
      generated,
      args.filters.omitOutputSchema,
      result.spec,
      cmdOpts.strictFilters === true,
    );
    const { built } = optOut;
    // The status tool counts the --omit-output-schema dead patterns too
    const pipeline = { ...result, deadPatterns: [...result.deadPatterns, ...optOut.deadPatterns] };
    const snapshot = buildSnapshot(built, pipeline, {
      toolMode: resolveToolMode(requestedToolMode, built.tools.length),
      compactOutputSchemas,
    });

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
        throw validationError(`the OAuth token URL is refused: ${describeCause(error)}`);
      }
    }

    // One redactor for the whole process: every resolved secret this
    // server ever holds — the spec-fetch auth header values, the API
    // --header/--header-env values, and the HTTP bearer token (if any) —
    // feeds it, so a secret echoed anywhere (an upstream error body, the
    // dispatch boundary, a startup diagnostic) is scrubbed uniformly.
    const redactor = createRedactor([
      ...args.options.specHeaders.map((header) => header.value),
      ...apiConfig.secretValues,
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
    if (snapshot.toolMode === 'discover') {
      validators = lazyEnvelopeValidators(
        compileToolValidator,
        new Map(snapshot.operations.map((tool) => [tool.name, tool.wireTool.outputSchema])),
        (toolName, error) =>
          emitWarnings(ctx, [
            `tool "${toolName}" has an output schema that cannot be compiled, so its calls fail: ${describeCause(error)}`,
          ]),
      );
    } else {
      const validatorEntries = snapshot.operations.map((tool) => {
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

    const executorConfig: ExecutorConfig = {
      baseUrl: resolvedBase.url.toString(),
      baseTrusted: resolvedBase.trusted,
      // Issue #40: every hop is checked against every operation of the spec
      routes: createRouteTable(
        routeEntriesFor(
          result.spec,
          result.withheldOperations,
          built.tools.map((tool) => tool.operation),
        ),
      ),
      allowOffsiteRedirects: cmdOpts.allowOffsiteRedirects === true,
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
      // stdio + HTTP because `createExecutor` is constructed exactly ONCE
      // below; up to 4x as many calls may queue for a slot.
      maxConcurrent: apiConfig.maxConcurrency,
      retries: apiConfig.retries,
      propagateTraceContext: apiConfig.propagateTraceContext,
      validators,
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
    // ONE executor instance, shared by the stdio AND HTTP branches below,
    // so the global outbound-concurrency semaphore is genuinely shared.
    const executor = createExecutor(executorConfig, { transport: ctx.transport });
    closeExecutor = () => executor.close();
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
      limiter: createRateLimiter(apiConfig.rateLimit),
      now: ctx.now,
      executor,
      metaExecutor: createMetaExecutor({ stats: callStats }),
      redactor,
    };
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
    emitWarnings(ctx, [
      ...result.warnings,
      ...result.deadPatterns.map((dead) => deadPatternMessage(dead)),
      ...omissionWarningLines([...result.spec.omitted, ...built.omitted]),
      ...optOut.warnings,
      // Exposed operations whose `security` requirement no configured
      // header satisfies would only ever 401 — say so, with the flag that
      // fixes it, before the first call instead of after it.
      ...unsatisfiedSecurityWarnings(
        result.spec,
        built.tools.map((tool) => tool.operation),
        { headerNames: configuredHeaderNames, oauthClientCredentials: oauth !== undefined },
      ),
      ...(httpConfig === undefined ? [] : noRequiredScopeWarning(httpConfig)),
      ...[discoverApprovalWarning(snapshot.toolMode, snapshot.operations)].filter(
        (line): line is string => line !== undefined,
      ),
    ]);
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
              timeoutMs: args.options.timeoutMs,
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

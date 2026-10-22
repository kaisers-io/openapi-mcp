import type { Command } from '@commander-js/extra-typings';
import {
  assertAllowedRedirectTarget,
  AUTO_DISCOVER_THRESHOLD,
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createExecutor,
  createMetaExecutor,
  createRateLimiter,
  createRedactor,
  createStreamableHttpServer,
  EXIT,
  isValidBearerToken,
  parseSpecSource,
  resolveToolMode,
  runSpecPipeline,
  SPEC_BUDGETS,
  serveStdioSession,
  SYSTEM_HEADERS,
  TOOL_MODES,
  usageError,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import type {
  EnvelopeValidator,
  ExecutorConfig,
  NormalizedSpec,
  RequestedToolMode,
  RequestGuardOptions,
} from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import { registerApiOptions, resolveApiConfig } from '../api-options.ts';
import type { ApiCmdOpts } from '../api-options.ts';
import type { CliContext } from '../context.ts';
import { emitError, emitWarnings } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  registerSpecOptions,
} from '../spec-options.ts';
import type { SpecCmdOpts } from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

// Fixed operational budgets for the runtime API executor. No CLI flag exists
// for these (ApiCmdOpts covers auth/base-url/response size/cleartext-gating
// only) — they bound the OUTBOUND request the way --max-response-bytes bounds
// the inbound one, and are conservative enough never to reject a well-formed
// request against a real API.
const MAX_URL_LENGTH = 8192;
const MAX_HEADER_BYTES = 16_384;
// Global outbound-concurrency semaphore, shared by stdio + HTTP because
// `createExecutor` is constructed exactly ONCE below.
const MAX_CONCURRENT_UPSTREAM_CALLS = 16;

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
type ServeCmdOpts = SpecCmdOpts &
  ApiCmdOpts & {
    http?: boolean;
    port: string;
    httpTokenEnv?: string;
    toolMode: string;
  };

// Validated like --port: before any spec, cache or network work.
const parseToolMode = (raw: string): RequestedToolMode => {
  const mode = TOOL_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw usageError(`--tool-mode "${raw}" is not one of ${TOOL_MODES.join(', ')}`);
  }
  return mode;
};

export const registerServe: CommandRegistrar = (program, ctx, state) => {
  const command = registerApiOptions(registerSpecOptions(program.command('serve')))
    .description(
      'start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec',
    )
    .option('--http', 'serve over Streamable HTTP (127.0.0.1 only) instead of stdio')
    .option('--port <n>', 'HTTP port', '3044')
    .option('--http-token-env <ENV>', 'env var holding the bearer token required for HTTP requests')
    .option(
      '--tool-mode <mode>',
      `per-operation (one tool per operation), discover (search_operations/describe_operation/call_operation), or auto (discover above ${String(AUTO_DISCOVER_THRESHOLD)} operations)`,
      'per-operation',
    );
  // Orphaned HTTP-only flags without --http are a usage error, not a
  // silent no-op: `--port` carries a default ('3044'), so a plain value
  // comparison would MISS an explicit `--port 3044`. Commander records
  // per-option provenance — `getOptionValueSource('port') === 'cli'`
  // distinguishes "the user actually passed --port" from "the default
  // applied" regardless of whether the passed value happens to equal
  // the default.
  const resolveHttpConfig = (
    cmdOpts: ServeCmdOpts,
  ): { token: string; port: number } | undefined => {
    if (
      cmdOpts.http !== true &&
      (cmdOpts.httpTokenEnv !== undefined || command.getOptionValueSource('port') === 'cli')
    ) {
      throw usageError('--port and --http-token-env require --http');
    }
    if (cmdOpts.http !== true) {
      return undefined;
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
    const port = Number(cmdOpts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw usageError(`--port "${cmdOpts.port}" is not a valid port number`);
    }
    return { token, port };
  };
  // `.option()` chained onto a Command whose Opts type already carries
  // SpecCmdOpts's own index signature does not narrow any further through
  // @commander-js/extra-typings' literal-flag inference (it falls back to a
  // generic OptionValues shape) — a purely type-level limitation; commander
  // itself parses --http/--port/--http-token-env identically either way.
  // The cast below restores the accumulated shape explicitly, matching
  // SpecCmdOpts's own "hand-written mirror" idiom in spec-options.ts.
  (command as unknown as Command<[], ServeCmdOpts>).action(async (cmdOpts: ServeCmdOpts) => {
    // Serve NEVER uses wrapAction and NEVER respects the global --json
    // flag for its own error path: wrapAction's JSON envelope writes to
    // STDOUT, and stdout is MCP-JSON-only for the entire life of this
    // process. Startup failures always render as plain text on stderr.
    const errorOpts = { json: false, verbose: false };
    try {
      // HTTP-specific options are validated FIRST — BEFORE any spec/cache/
      // network processing — so a bad --port or --http-token-env fails
      // fast with NO side effects (no spec fetch, no cache write). This
      // matches "validated once at CLI startup" rather than discovering
      // the mistake only after paying for a spec fetch.
      const httpConfig = resolveHttpConfig(cmdOpts);
      // Resolved BEFORE buildTools (below): its reservedHeaderNames must be
      // unioned into buildTools' reservedHeaders so a spec header parameter
      // colliding with a configured auth header name is dropped from the
      // tool's input schema, not merely rejected later at call time. Also
      // validated fast, before any spec/cache/network processing, matching
      // the httpConfig check just above.
      const apiConfig = resolveApiConfig(cmdOpts, ctx);
      const requestedToolMode = parseToolMode(cmdOpts.toolMode);
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
        throw validationError(
          result.deadPatterns.map((dead) => deadPatternMessage(dead)).join('\n'),
        );
      }
      // Union: a spec header parameter named e.g. "X-Api-Key" is dropped from
      // the tool's input schema when that same name is configured as an
      // operator auth header (--header/--header-env) — SYSTEM_HEADERS alone
      // would let it reappear as a caller-settable input, silently colliding
      // with the credential the executor injects.
      const built = buildTools(result.namedOperations, {
        reservedHeaders: new Set([...SYSTEM_HEADERS, ...apiConfig.reservedHeaderNames]),
        openapiVersion: result.spec.openapiVersion,
      });
      const snapshot = buildSnapshot(built, result, {
        toolMode: resolveToolMode(requestedToolMode, built.tools.length),
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

      // One redactor for the whole process: every resolved secret this
      // server ever holds — the spec-fetch auth header values, the API
      // --header/--header-env values, and the HTTP bearer token (if any) —
      // feeds it, so a secret echoed anywhere (an upstream error body, the
      // dispatch boundary, a startup diagnostic) is scrubbed uniformly.
      const redactor = createRedactor([
        ...args.options.specHeaders.map((header) => header.value),
        ...apiConfig.secretValues,
        ...(httpConfig === undefined ? [] : [httpConfig.token]),
      ]);

      // Every upstream tool's outputSchema is compiled eagerly HERE, at
      // startup, so an incompatible schema fails fast rather than on the
      // first matching call. `validators.has` is the executor's fail-closed
      // contract — every upstream tool gets an entry, `undefined` only for a
      // genuine no-outputSchema tool.
      const validatorEntries = snapshot.operations.map((tool) => {
        try {
          return [tool.name, compileEnvelopeValidator(tool.wireTool.outputSchema)] as const;
        } catch (error) {
          throw usageError(
            `tool "${tool.name}" has an output schema that cannot be compiled: ${describeCause(error)}`,
          );
        }
      });
      const validators = new Map<string, EnvelopeValidator | undefined>(validatorEntries);

      const executorConfig: ExecutorConfig = {
        baseUrl: resolvedBase.url.toString(),
        baseTrusted: resolvedBase.trusted,
        allowPrivateNetwork,
        allowInsecureHttp: apiConfig.allowInsecureHttp,
        secretHeaders: apiConfig.secretHeaders,
        staticHeaders: apiConfig.staticHeaders,
        reservedHeaderNames: apiConfig.reservedHeaderNames,
        redactor,
        timeoutMs: args.options.timeoutMs,
        maxResponseBytes: apiConfig.maxResponseBytes,
        outboundBudgets: {
          maxUrlLength: MAX_URL_LENGTH,
          maxHeaderBytes: MAX_HEADER_BYTES,
          maxBodyBytes: apiConfig.maxResponseBytes,
        },
        maxConcurrent: MAX_CONCURRENT_UPSTREAM_CALLS,
        validators,
      };
      // ONE executor instance, shared by the stdio AND HTTP branches below,
      // so the global outbound-concurrency semaphore is genuinely shared.
      const executor = createExecutor(executorConfig, { transport: ctx.transport });
      const dispatcherDeps = {
        limiter: createRateLimiter(),
        now: ctx.now,
        executor,
        metaExecutor: createMetaExecutor(),
        redactor,
      };
      // Startup diagnostics — cache staleness, a pending candidate, dead
      // patterns under non-strict mode (e.g. a mistyped --deny silently
      // failing open), and omitted operations — go to stderr, sanitized
      // and framed through the SAME emitWarnings() path `tools` uses via
      // emit(), never raw. Full parity with `tools`' warnings array.
      emitWarnings(ctx, [
        ...result.warnings,
        ...result.deadPatterns.map((dead) => deadPatternMessage(dead)),
        ...omissionWarningLines([...result.spec.omitted, ...built.omitted]),
      ]);
      if (httpConfig === undefined) {
        const session = serveStdioSession(
          { name: 'openapi-mcp', version: pkg.version, snapshot, dispatcherDeps },
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
        const guard: RequestGuardOptions = {
          // No CLI flag for browser Origins (documented scope: a single
          // local, non-browser client) — an empty allowlist means every
          // PRESENT Origin 403s; an absent Origin still works with a valid
          // bearer.
          allowedOrigins: new Set(),
          allowedHost: `127.0.0.1:${String(httpConfig.port)}`,
          bearer: { configuredToken: httpConfig.token },
        };
        const httpServer = createStreamableHttpServer({
          name: 'openapi-mcp',
          version: pkg.version,
          snapshot,
          dispatcherDeps,
          guard,
          port: httpConfig.port,
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
    }
  });
};

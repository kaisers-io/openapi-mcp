import type { Command } from '@commander-js/extra-typings';
import {
  assertAllowedRedirectTarget,
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  connectStdio,
  createExecutor,
  createMetaExecutor,
  createProtocolSession,
  createRateLimiter,
  createRedactor,
  createStreamableHttpServer,
  EXIT,
  isValidBearerToken,
  parseSpecSource,
  runSpecPipeline,
  SYSTEM_HEADERS,
  usageError,
  validationError,
  type EnvelopeValidator,
  type ExecutorConfig,
  type NormalizedSpec,
  type RequestGuardOptions,
} from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import { registerApiOptions, resolveApiConfig, type ApiCmdOpts } from '../api-options.ts';
import { emitError, emitWarnings } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  registerSpecOptions,
  type SpecCmdOpts,
} from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

// M5 Task 11: fixed operational budgets for the runtime API executor. No CLI
// flag exists for these (Task 9's ApiCmdOpts covers auth/base-url/response
// size/cleartext-gating only) — they bound the OUTBOUND request the way
// --max-response-bytes bounds the inbound one, and are conservative enough
// never to reject a well-formed request against a real API.
const MAX_URL_LENGTH = 8192;
const MAX_HEADER_BYTES = 16_384;
// Global outbound-concurrency semaphore (design §7.6), shared by stdio + HTTP
// because `createExecutor` is constructed exactly ONCE below.
const MAX_CONCURRENT_UPSTREAM_CALLS = 16;

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

export interface ResolvedBase {
  url: URL;
  // True iff the base came from the OPERATOR-supplied --base-url — a trusted
  // origin skips the startup address (egress) check below; a spec-derived
  // base is always untrusted regardless of --allow-private-network.
  trusted: boolean;
}

// M5 Task 11 / plan-review MED (base resolution): `--base-url` wins
// (trusted); else an ABSOLUTE `servers[0]` candidate is used as-is
// (untrusted); else a RELATIVE/absent candidate resolves against the spec's
// own FINAL, post-redirect source URL (`displaySource`) — OpenAPI's own "no
// servers -> root of the document's location" default — but ONLY when the
// spec came from a URL; a FILE spec with no usable server candidate has no
// document location to resolve against, so it is a startup usage error
// requiring `--base-url`.
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
  let documentBase: URL;
  try {
    documentBase = new URL(displaySource);
  } catch {
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
interface ServeCmdOpts extends SpecCmdOpts, ApiCmdOpts {
  http?: boolean;
  port: string;
  httpTokenEnv?: string;
}

export const registerServe: CommandRegistrar = (program, ctx, state) => {
  const command = registerApiOptions(registerSpecOptions(program.command('serve')))
    .description(
      'start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec',
    )
    .option('--http', 'serve over Streamable HTTP (127.0.0.1 only) instead of stdio')
    .option('--port <n>', 'HTTP port', '3044')
    .option(
      '--http-token-env <ENV>',
      'env var holding the bearer token required for HTTP requests',
    );
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
      let httpConfig: { token: string; port: number } | undefined;
      // Orphaned HTTP-only flags without --http are a usage error, not a
      // silent no-op: `--port` carries a default ('3044'), so a plain value
      // comparison would MISS an explicit `--port 3044`. Commander records
      // per-option provenance — `getOptionValueSource('port') === 'cli'`
      // distinguishes "the user actually passed --port" from "the default
      // applied" regardless of whether the passed value happens to equal
      // the default.
      if (
        cmdOpts.http !== true &&
        (cmdOpts.httpTokenEnv !== undefined || command.getOptionValueSource('port') === 'cli')
      ) {
        throw usageError('--port and --http-token-env require --http');
      }
      if (cmdOpts.http === true) {
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
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw usageError(`--port "${cmdOpts.port}" is not a valid port number`);
        }
        httpConfig = { token, port };
      }
      // M5 Task 11: resolved BEFORE buildTools (below) — its
      // reservedHeaderNames must be unioned into buildTools' reservedHeaders
      // so a spec header parameter colliding with a configured auth header
      // name is dropped from the tool's input schema, not merely rejected
      // later at call time. Also validated fast, before any spec/cache/
      // network processing, matching the httpConfig check just above.
      const apiConfig = resolveApiConfig(cmdOpts, ctx);
      const args = parseSpecPipelineArgs(cmdOpts, ctx);
      const result = await runSpecPipeline(args.source, args.options, args.deps);
      // Sanitized + suggestion-bearing, matching `tools`' strict-filters
      // throw exactly (deadPatternMessage is the shared, spec §8-worded
      // renderer): the raw inline form this replaced put unsanitized
      // spec-derived text straight into a thrown error's message.
      if (cmdOpts.strictFilters === true && result.deadPatterns.length > 0) {
        throw validationError(
          result.deadPatterns.map((dead) => deadPatternMessage(dead)).join('\n'),
        );
      }
      // Union: a spec header parameter named e.g. "X-Api-Key" is dropped from
      // the tool's input schema when that same name is configured as an
      // operator auth header (--header/--header-env) — SYSTEM_HEADERS alone
      // (the M4 baseline) would let it reappear as a caller-settable input,
      // silently colliding with the credential the executor injects.
      const built = buildTools(result.namedOperations, {
        reservedHeaders: new Set([...SYSTEM_HEADERS, ...apiConfig.reservedHeaderNames]),
        openapiVersion: result.spec.openapiVersion,
      });
      const snapshot = buildSnapshot(built, result);

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
        // Bounded resolve + classifyAddress (Task 1/3), respecting
        // --allow-private-network; metadata is denied unconditionally. The
        // per-connection DNS pin (pinnedRequest, Task 4) remains the actual
        // runtime control — this is a fail-fast startup check only.
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

      // D7 eager compile (round-1 amendment): every upstream tool's
      // outputSchema is compiled HERE, at startup, so an incompatible schema
      // fails fast rather than on the first matching call. `validators.has`
      // is the executor's fail-closed contract — every upstream tool gets an
      // entry, `undefined` only for a genuine no-outputSchema tool.
      const validators = new Map<string, EnvelopeValidator | undefined>();
      for (const tool of snapshot.tools) {
        if (tool.kind !== 'upstream') {
          continue;
        }
        try {
          validators.set(tool.name, compileEnvelopeValidator(tool.wireTool.outputSchema));
        } catch (err) {
          throw usageError(
            `tool "${tool.name}" has an output schema that cannot be compiled: ${describeCause(err)}`,
          );
        }
      }

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
      if (httpConfig !== undefined) {
        const guard: RequestGuardOptions = {
          // No CLI flag for browser Origins in M4 (documented scope: a
          // single local, non-browser client) — an empty allowlist means
          // every PRESENT Origin 403s; an absent Origin still works with a
          // valid bearer (Task 7).
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
          now: ctx.now,
        });
        await httpServer.listen();
        // Block until a graceful shutdown signal — there is no client
        // stdin stream to watch for EOF in HTTP mode (unlike the stdio
        // branch below), so SIGINT/SIGTERM are the only shutdown triggers.
        await new Promise<void>((resolve) => {
          process.once('SIGINT', () => resolve());
          process.once('SIGTERM', () => resolve());
        });
        await httpServer.close();
      } else {
        const server = createProtocolSession({
          name: 'openapi-mcp',
          version: pkg.version,
          snapshot,
          dispatcherDeps,
        });
        await connectStdio(server);
        // Connect() resolves once the transport is attached; block here until
        // a graceful shutdown signal (SIGINT/SIGTERM) OR the MCP client
        // disconnecting (stdin EOF) so the CLI process stays alive for
        // exactly the transport's lifetime and no longer.
        //
        // VERIFIED empirically against the pinned @modelcontextprotocol/sdk
        // (dist/esm/server/stdio.js, StdioServerTransport): it attaches only
        // 'data'/'error' listeners to stdin, never 'end' — it does NOT
        // self-close on EOF, so `Server`'s (Protocol's) `onclose` callback
        // never fires from a client disconnect; it only fires when close()
        // is called. A probe of both variants (an `onclose`-driven resolve
        // vs. this stdin-'end'-driven resolve) against the real SDK, with a
        // child process's stdin closed the way a disconnecting client
        // closes it, showed the `onclose` variant still exits 13 (unsettled
        // top-level await) while this variant exits 0. So the promise must
        // listen to stdin's OWN 'end' event directly, not delegate to
        // `server.onclose`, and `server.close()` is unconditional afterward
        // (the transport is never already self-closed, so no double-close
        // guard is needed here).
        await new Promise<void>((resolve) => {
          process.once('SIGINT', () => resolve());
          process.once('SIGTERM', () => resolve());
          process.stdin.once('end', () => resolve());
        });
        await server.close();
      }
      state.exitCode = EXIT.OK;
    } catch (err) {
      state.exitCode = emitError(ctx, errorOpts, err);
    }
  });
};

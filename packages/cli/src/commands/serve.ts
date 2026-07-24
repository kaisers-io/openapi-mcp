import type { Command } from '@commander-js/extra-typings';
import {
  buildSnapshot,
  buildTools,
  connectStdio,
  createMetaExecutor,
  createProtocolSession,
  createRateLimiter,
  createStreamableHttpServer,
  EXIT,
  executionUnavailable,
  isValidBearerToken,
  runSpecPipeline,
  SYSTEM_HEADERS,
  usageError,
  validationError,
  type RequestGuardOptions,
} from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import { emitError, emitWarnings } from '../output.ts';
import {
  deadPatternMessage,
  omissionWarningLines,
  parseSpecPipelineArgs,
  registerSpecOptions,
  type SpecCmdOpts,
} from '../spec-options.ts';
import type { CommandRegistrar } from './registry.ts';

// Mirrors SpecCmdOpts's own "hand-written mirror of the accumulated option
// shape" idiom (see spec-options.ts's comment on registerSpecOptions).
interface ServeCmdOpts extends SpecCmdOpts {
  http?: boolean;
  port: string;
  httpTokenEnv?: string;
}

export const registerServe: CommandRegistrar = (program, ctx, state) => {
  const command = registerSpecOptions(program.command('serve'))
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
      const built = buildTools(result.namedOperations, {
        reservedHeaders: SYSTEM_HEADERS,
        openapiVersion: result.spec.openapiVersion,
      });
      const snapshot = buildSnapshot(built, result);
      const dispatcherDeps = {
        limiter: createRateLimiter(),
        now: ctx.now,
        executor: executionUnavailable,
        metaExecutor: createMetaExecutor(),
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

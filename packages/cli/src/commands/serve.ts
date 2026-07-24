import {
  buildSnapshot,
  buildTools,
  connectStdio,
  createMetaExecutor,
  createProtocolSession,
  createRateLimiter,
  EXIT,
  executionUnavailable,
  runSpecPipeline,
  SYSTEM_HEADERS,
  validationError,
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

export const registerServe: CommandRegistrar = (program, ctx, state) => {
  registerSpecOptions(program.command('serve'))
    .description(
      'start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec',
    )
    .action(async (cmdOpts: SpecCmdOpts) => {
      // Serve NEVER uses wrapAction and NEVER respects the global --json
      // flag for its own error path: wrapAction's JSON envelope writes to
      // STDOUT, and stdout is MCP-JSON-only for the entire life of this
      // process. Startup failures always render as plain text on stderr.
      const errorOpts = { json: false, verbose: false };
      try {
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
        const server = createProtocolSession({
          name: 'openapi-mcp',
          version: pkg.version,
          snapshot,
          dispatcherDeps: {
            limiter: createRateLimiter(),
            now: ctx.now,
            executor: executionUnavailable,
            metaExecutor: createMetaExecutor(),
          },
        });
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
        state.exitCode = EXIT.OK;
      } catch (err) {
        state.exitCode = emitError(ctx, errorOpts, err);
      }
    });
};

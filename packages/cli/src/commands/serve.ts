import type { Command } from '@commander-js/extra-typings';
import { AUTO_DISCOVER_THRESHOLD } from '@kaisers-io/openapi-mcp-core';
import { registerApiOptions } from '../api-options.ts';
import { emitError } from '../output.ts';
import { registerSpecOptions } from '../spec-options.ts';
import type { runServe as RunServe, ServeCmdOpts } from './serve-action.ts';
import type { CommandRegistrar } from './registry.ts';

// Registration only: the options and help text are defined here, statically,
// so `serve --help` and option parsing are unchanged. Everything the action
// needs (MCP SDK, Streamable HTTP + hono, executor, Ajv) lives in
// serve-action.ts and is imported when the action runs (issue #91), so the
// other commands never load or evaluate it. A bundling mistake would surface
// as a failure of `serve` itself, which the packed-CLI smoke test exercises.
export const registerServe: CommandRegistrar = (program, ctx, state) => {
  const command = registerApiOptions(registerSpecOptions(program.command('serve')))
    .description(
      'start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec',
    )
    .option('--http', 'serve over Streamable HTTP (127.0.0.1 only) instead of stdio')
    .option('--port <n>', 'HTTP port', '3044')
    .option('--http-token-env <ENV>', 'env var holding the bearer token required for HTTP requests')
    .option(
      '--log <format>',
      'write one structured line per tool call to stderr (only "json"; never arguments, header values or bodies)',
    )
    .option(
      '--response-projection',
      'offer an optional _fields argument (JSON Pointers) on JSON tools, so a call returns only the selected fields; adds about a third to tools/list',
    )
    .option(
      '--tools-page-size <n>',
      'page tools/list with n tools per page (only for MCP hosts that follow nextCursor); default: all tools in one response',
    )
    .option(
      '--tool-mode <mode>',
      `per-operation (one tool per operation), discover (search_operations/describe_operation/call_operation), or auto (discover above ${String(AUTO_DISCOVER_THRESHOLD)} operations)`,
      'per-operation',
    );
  // `.option()` chained onto a Command whose Opts type already carries
  // SpecCmdOpts's own index signature does not narrow any further through
  // @commander-js/extra-typings' literal-flag inference (it falls back to a
  // generic OptionValues shape) — a purely type-level limitation; commander
  // itself parses --http/--port/--http-token-env identically either way.
  // The cast below restores the accumulated shape explicitly, matching
  // SpecCmdOpts's own "hand-written mirror" idiom in spec-options.ts.
  (command as unknown as Command<[], ServeCmdOpts>).action(async (cmdOpts: ServeCmdOpts) => {
    // A missing chunk (broken install) takes serve's own error path: plain
    // text on stderr regardless of --json, stdout stays MCP-only
    let runServe: typeof RunServe;
    try {
      ({ runServe } = await import('./serve-action.ts'));
    } catch (error) {
      state.exitCode = emitError(ctx, { json: false, verbose: false }, error);
      return;
    }
    await runServe(command as unknown as Command<[], ServeCmdOpts>, cmdOpts, ctx, state);
  });
};

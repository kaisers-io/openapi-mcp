import type { Command } from '@commander-js/extra-typings';
import {
  AUTO_DISCOVER_DEFINITION_BYTES,
  AUTO_DISCOVER_THRESHOLD,
  TOOL_MODES,
} from '@kaisers-io/openapi-mcp-core';
import { DEFAULT_IMAGE_DIR_MAX_BYTES, IMAGE_RESPONSE_MODES } from '../image-options.ts';
import { registerApiOptions } from '../api-options.ts';
import { emitError } from '../output.ts';
import { CAPTURED_FLAGS } from '../multi-api.ts';
import type { Occurrence } from '../multi-api.ts';
import { collect, declareChoices } from '../option-meta.ts';
import { OUTPUT_SCHEMA_FORMS, registerSpecOptions } from '../spec-options.ts';
import type { runServe as RunServe, ServeCmdOpts } from './serve-action.ts';
import type { CommandRegistrar } from './registry.ts';

const HTTP_AUTH_MODES = ['static', 'oauth'] as const;

// Registration only: the options and help text are defined here, statically,
// so `serve --help` and option parsing are unchanged. Everything the action
// needs (MCP SDK, Streamable HTTP + hono, executor, Ajv) lives in
// serve-action.ts and is imported when the action runs (issue
// kaisers-io/openapi-mcp-archive#91), so the other commands never load or
// evaluate it. A bundling mistake would surface as a failure of `serve` itself,
// which the packed-CLI smoke test exercises.
export const registerServe: CommandRegistrar = (program, ctx, state) => {
  const command = registerApiOptions(
    registerSpecOptions(
      program.command('serve'),
      'permit private/loopback addresses for spec fetch redirects, for API requests to a spec-derived origin or redirect, and for the --upstream-oauth-* token URL (never cloud-metadata)',
      false,
    ),
  )
    .option(
      '--api <name=source>',
      'serve several APIs: one spec per name (repeatable); every per-API option then starts with <name>=',
      collect,
    )
    .option(
      '--enable <name=switch>',
      'with --api: turn a per-API switch on for one API, e.g. shop=allow-private-network (repeatable)',
      collect,
    )
    .description(
      'start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec',
    )
    .option('--http', 'serve over Streamable HTTP (127.0.0.1 unless --http-host) instead of stdio')
    .option('--port <n>', 'HTTP port', '3044')
    .option('--http-token-env <ENV>', 'env var holding the bearer token required for HTTP requests')
    .option(
      '--http-auth <mode>',
      'HTTP authentication: "static" (--http-token-env) or "oauth" (resource-server mode)',
      'static',
    )
    .option(
      '--http-host <addr>',
      'IP address to bind; only with --http-auth oauth (static mode always binds 127.0.0.1)',
    )
    .option(
      '--oauth-issuer <url>',
      'authorization server issuer whose JWT access tokens are accepted',
    )
    .option(
      '--oauth-audience <uri>',
      "this server's canonical resource URI; tokens must carry it in aud",
    )
    .option(
      '--oauth-required-scope <scope>',
      'scope every access token must grant (repeatable)',
      collect,
    )
    .option(
      '--log <format>',
      'write one structured line per tool call to stderr (only "json"; never arguments, header values or bodies)',
    )
    .option(
      '--response-projection',
      'offer an optional _fields argument (JSON Pointers) on JSON tools, so a call returns only the selected fields; adds about a third to tools/list',
    )
    .option(
      '--allow-offsite-redirects',
      'follow a redirect that leaves the API base URL (another host, or outside the base path); egress checks still apply',
    )
    .option(
      '--tools-page-size <n>',
      'page tools/list with n tools per page (only for MCP hosts that follow nextCursor); default: all tools in one response',
    )
    .option(
      '--tool-mode <mode>',
      `per-operation (one tool per operation), discover (search_operations/describe_operation/call_operation), or auto (discover above ${String(AUTO_DISCOVER_THRESHOLD)} operations or ${String(AUTO_DISCOVER_DEFINITION_BYTES / 1000)} KB of tool definitions)`,
      'per-operation',
    )
    .option(
      '--image-responses <mode>',
      'an upstream PNG, JPEG, GIF or WebP image: off (an unsupported media type, the default), inline (returned as an MCP image) or file (saved under ~/.kaisers-io/openapi-mcp/images/, and its path returned)',
      'off',
    )
    .option(
      '--uploads',
      'let binary request fields take {"file": "<name>"} for a file read from ~/.kaisers-io/openapi-mcp/uploads/<api>/ instead of base64; files there older than 24 hours are removed at startup',
    )
    .option(
      '--image-dir-max-bytes <size>',
      'with --image-responses file: the most the image folder of this API may hold; the oldest saved images go first',
      DEFAULT_IMAGE_DIR_MAX_BYTES,
    )
    .option(
      '--output-schema <form>',
      'how output schemas are shown to the host: inline (every subschema written out) or defs (repeated subschemas once under "$defs", referenced with "$ref"); validation is the same either way',
      'inline',
    )
    .option(
      '--no-output-schema-descriptions',
      'show output schemas without their field descriptions, which are most of their size; validation is the same either way',
    );
  // Their values are checked in serve-action.ts, with its own messages
  declareChoices(command, '--tool-mode', TOOL_MODES);
  declareChoices(command, '--image-responses', IMAGE_RESPONSE_MODES);
  declareChoices(command, '--output-schema', OUTPUT_SCHEMA_FORMS);
  declareChoices(command, '--http-auth', HTTP_AUTH_MODES);
  declareChoices(command, '--log', ['json']);
  // `.option()` chained onto a Command whose Opts type already carries
  // SpecCmdOpts's own index signature does not narrow any further through
  // @commander-js/extra-typings' literal-flag inference (it falls back to a
  // generic OptionValues shape) — a purely type-level limitation; commander
  // itself parses --http/--port/--http-token-env identically either way.
  // The cast below restores the accumulated shape explicitly, matching
  // SpecCmdOpts's own "hand-written mirror" idiom in spec-options.ts.
  // Commander keeps one value of a scalar option; with several APIs every
  // occurrence counts (multi-api.ts), so each is recorded as it is parsed
  const occurrences: Occurrence[] = [];
  for (const flag of CAPTURED_FLAGS) {
    command.on(`option:${flag.slice(2)}`, (value: unknown) => {
      occurrences.push({ flag, value });
    });
  }
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
    await runServe(command, cmdOpts, ctx, state, occurrences);
  });
};

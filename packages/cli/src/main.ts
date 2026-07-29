import { Command, CommanderError } from '@commander-js/extra-typings';
import { EXIT, usageError } from '@kaisers-io/openapi-mcp-core';
import pkg from '../package.json' with { type: 'json' };
import type { CliContext } from './context.ts';
import { emitError, getGlobalOpts } from './output.ts';
import { REGISTRARS } from './commands/registry.ts';
import type { CommandRegistrar } from './commands/registry.ts';

export interface RunState {
  exitCode: number;
}

export const buildProgram = (
  ctx: CliContext,
  state: RunState,
  registrars: readonly CommandRegistrar[] = REGISTRARS,
): Command => {
  const program = new Command()
    .name('openapi-mcp')
    .description('Turn any OpenAPI spec into a strict, locally running MCP server')
    .version(pkg.version)
    .option('--json', 'machine-readable JSON output')
    .option('--verbose', 'include stack traces and debug detail')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        // Trim the trailing newline commander appends; ctx.out adds one
        ctx.out(str.replace(/\n$/u, ''));
      },
      writeErr: (str) => {
        ctx.errLine(str.replace(/\n$/u, ''));
      },
      outputError: () => {
        // Suppress commander's own error printing; emitError renders exactly once
      },
    });
  for (const register of registrars) {
    register(program, ctx, state);
  }
  return program;
};

const stripCommanderPrefix = (message: string): string => message.replace(/^error: /u, '');

// Serve's stdout is MCP-JSON-only for the life of the process. A commander
// PARSE error (missing --spec, an unknown flag) fires from parseAsync()
// BEFORE any .action() runs, so serve.ts's own internal error handling
// (Step 5) never gets a chance to force plain-text stderr for it — this
// top-level catch must apply the SAME policy itself for a serve invocation.
//
// The subcommand is detected as the first argv token that does NOT start
// with '-': every global option (`--json`, `--verbose`) and the `--`
// options terminator start with '-', so the first bare word IS the command
// name. This also means a `tools --spec serve` invocation (a spec source
// literally named "serve") is never mistaken for the serve command — `tools`
// is the first non-option token, found before the later `serve` value.
//
// This detection is deliberately biased toward classifying an invocation as
// `serve`, which is the SAFE direction: a false positive only ever
// SUPPRESSES a --json envelope for a non-serve error (never emits one to
// stdout), whereas a false negative would LEAK the envelope to stdout for a
// real serve invocation.
//
// `rawArgv` here is `run()`'s own `argv` PARAMETER, which is ALWAYS the full
// `process.argv`-shaped array (verified against `packages/cli/src/main.ts`'s
// only two callers: `packages/cli/src/index.ts` and `packages/cli/bin/openapi-mcp.mjs`
// both call `run(realContext(), process.argv)` — never a sliced version —
// and every existing CLI test in `packages/cli/test/*.test.ts` matches that
// convention by hand-prepending the same two-token prefix, e.g. `run(ctx,
// ['node', 'openapi-mcp', 'cache', 'list'])`). `process.argv[0]` is the
// Node executable path and `[1]` is the script path — commander's own
// `parseAsync(argv)` assumes exactly this layout by default (no `{ from:
// 'user' }` override is passed anywhere in this codebase). Searching
// `rawArgv` from index 0 would find the NODE EXECUTABLE PATH first (it does
// not start with '-') and misclassify every invocation. `.slice(2)` drops
// exactly those two fixed leading tokens before scanning for the first
// option-free positional.
//
// Caveat: this assumes no global option takes a VALUE — today only the
// value-less booleans `--json`/`--verbose` are declared on `buildProgram`'s
// `program` (see above). A future global option whose value does not itself
// start with '-' (e.g. `--log-level info`) would have that value token
// mistaken for the command positional, and this detection would need to
// skip it explicitly.
const isServeInvocation = (rawArgv: readonly string[]): boolean =>
  rawArgv.slice(2).find((token) => !token.startsWith('-')) === 'serve';

export const run = async (
  ctx: CliContext,
  argv: readonly string[],
  registrars: readonly CommandRegistrar[] = REGISTRARS,
): Promise<number> => {
  const state: RunState = { exitCode: EXIT.OK };
  const program = buildProgram(ctx, state, registrars);
  try {
    await program.parseAsync([...argv]);
    return state.exitCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return EXIT.OK;
    }
    const errorOpts = isServeInvocation(argv)
      ? { json: false, verbose: false }
      : getGlobalOpts(program);
    if (error instanceof CommanderError) {
      return emitError(ctx, errorOpts, usageError(stripCommanderPrefix(error.message)));
    }
    return emitError(ctx, errorOpts, error);
  }
};

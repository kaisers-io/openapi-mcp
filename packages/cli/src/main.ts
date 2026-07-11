import { Command, CommanderError } from '@commander-js/extra-typings';
import { EXIT, usageError } from '@kaisers-io/openapi-mcp-core';
import pkg from '../package.json' with { type: 'json' };
import type { CliContext } from './context.ts';
import { emitError, getGlobalOpts } from './output.ts';
import { REGISTRARS, type CommandRegistrar } from './commands/registry.ts';

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
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version are successful exits, not errors
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        return EXIT.OK;
      }
      return emitError(ctx, getGlobalOpts(program), usageError(stripCommanderPrefix(err.message)));
    }
    return emitError(ctx, getGlobalOpts(program), err);
  }
};

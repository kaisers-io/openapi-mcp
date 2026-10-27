import type { CommandUnknownOpts, Option } from '@commander-js/extra-typings';
import { EXIT, usageError } from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import { PER_API_LISTS, PER_API_SCALARS, PER_API_SWITCHES } from '../multi-api.ts';
import { collect } from '../option-meta.ts';
import { getGlobalOpts, wrapAction } from '../output.ts';
import type { CommandRegistrar } from './registry.ts';

// `help [command...]`: commander's help text, or with --json the options of
// every command as data (issue #75), for tools that write openapi-mcp configs.

// How an option of `serve` applies when several APIs are given with --api:
// `prefix` takes `<api>=` before its value; `prefix-or-all` (--deny) applies
// to every API without one; `enable` is a switch set with --enable <api>=<switch>
type PerApi = 'prefix' | 'prefix-or-all' | 'enable';

const PER_API: ReadonlyMap<string, PerApi> = new Map<string, PerApi>([
  ...[...Object.keys(PER_API_SCALARS), ...Object.keys(PER_API_LISTS)].map(
    (flag) => [flag, 'prefix'] as const,
  ),
  ['--deny', 'prefix-or-all'],
  ...Object.keys(PER_API_SWITCHES).map((name) => [`--${name}`, 'enable'] as const),
]);

const ARGUMENT_NAME = /[<[](?<name>[^>\]]+)[>\]]/u;

// A --no-<name> option defaults to true when nothing else sets <name>
const defaultOf = (option: Option): { default?: unknown } => {
  if (option.defaultValue !== undefined) {
    return { default: option.defaultValue as unknown };
  }
  return option.negate ? { default: true } : {};
};

const describeOption = (option: Option, perApiCommand: boolean) => {
  const argument = ARGUMENT_NAME.exec(option.flags)?.groups?.['name'];
  const perApi = perApiCommand ? PER_API.get(option.long ?? '') : undefined;
  return {
    flags: option.flags,
    ...(option.long === undefined ? {} : { long: option.long }),
    ...(option.short === undefined ? {} : { short: option.short }),
    ...(argument === undefined ? {} : { argument: { name: argument, optional: option.optional } }),
    description: option.description,
    mandatory: option.mandatory,
    negate: option.negate,
    ...defaultOf(option),
    ...(option.presetArg === undefined ? {} : { bareValue: option.presetArg }),
    repeatable: option.parseArg === (collect as Option['parseArg']),
    ...(option.argChoices === undefined ? {} : { choices: option.argChoices }),
    ...(perApi === undefined ? {} : { perApi }),
  };
};

type CommandData = {
  name: string;
  description: string;
  arguments: { name: string; required: boolean; variadic: boolean }[];
  options: ReturnType<typeof describeOption>[];
  commands: CommandData[];
};

const describeCommand = (command: CommandUnknownOpts): CommandData => ({
  name: command.name(),
  description: command.description(),
  arguments: command.registeredArguments.map((argument) => ({
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
  })),
  options: command.options.map((option) => describeOption(option, command.name() === 'serve')),
  commands: command.commands.map((child) => describeCommand(child)),
});

const commandAt = (program: CommandUnknownOpts, path: readonly string[]): CommandUnknownOpts => {
  let current = program;
  for (const name of path) {
    const next = current.commands.find((child) => child.name() === name);
    if (next === undefined) {
      throw usageError(`unknown command "${path.join(' ')}"`);
    }
    current = next;
  }
  return current;
};

export const registerHelp: CommandRegistrar = (program, ctx, state) => {
  program.helpCommand(false);
  program
    .command('help')
    .argument('[command...]', 'the command to describe')
    .description('show help for a command; with --json, every command and option as data')
    .action(async (path: string[]) => {
      const opts = getGlobalOpts(program);
      if (!opts.json) {
        commandAt(program, path).outputHelp();
        state.exitCode = EXIT.OK;
        return;
      }
      state.exitCode = await wrapAction(ctx, opts, () => {
        const data = describeCommand(commandAt(program, path));
        return Promise.resolve({
          data: path.length === 0 ? { version: pkg.version, ...data } : data,
          humanLines: [],
        });
      });
    });
};

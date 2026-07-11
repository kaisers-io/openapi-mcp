import type { Command } from '@commander-js/extra-typings';
import type { CliContext } from '../context.ts';
import type { RunState } from '../main.ts';

export type CommandRegistrar = (program: Command, ctx: CliContext, state: RunState) => void;

// Commands register here as they are implemented (doctor, tools, serve, cache)
export const REGISTRARS: readonly CommandRegistrar[] = [];

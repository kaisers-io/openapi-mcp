import type { Command } from '@commander-js/extra-typings';
import type { CliContext } from '../context.ts';
import type { RunState } from '../main.ts';
import { registerDoctor } from './doctor.ts';

export type CommandRegistrar = (program: Command, ctx: CliContext, state: RunState) => void;

// Commands register here as they are implemented (tools, serve, cache follow in M2/M3)
export const REGISTRARS: readonly CommandRegistrar[] = [registerDoctor];

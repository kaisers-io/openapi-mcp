import type { Command } from '@commander-js/extra-typings';
import type { CliContext } from '../context.ts';
import type { RunState } from '../main.ts';
import { registerDoctor } from './doctor.ts';
import { registerTools } from './tools.ts';

export type CommandRegistrar = (program: Command, ctx: CliContext, state: RunState) => void;

// Commands register here as they are implemented (serve, cache follow in M2b/M3)
export const REGISTRARS: readonly CommandRegistrar[] = [registerDoctor, registerTools];

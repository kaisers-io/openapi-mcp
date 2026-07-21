import type { Command } from '@commander-js/extra-typings';
import type { CliContext } from '../context.ts';
import type { RunState } from '../main.ts';
import { registerCache } from './cache.ts';
import { registerDoctor } from './doctor.ts';
import { registerTools } from './tools.ts';

export type CommandRegistrar = (program: Command, ctx: CliContext, state: RunState) => void;

// Commands register here as they are implemented (serve follows in M3)
export const REGISTRARS: readonly CommandRegistrar[] = [
  registerDoctor,
  registerTools,
  registerCache,
];

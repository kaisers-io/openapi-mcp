import type { Command } from '@commander-js/extra-typings';
import type { CliContext } from '../context.ts';
import type { RunState } from '../main.ts';
import { registerCache } from './cache.ts';
import { registerDoctor } from './doctor.ts';
import { registerHelp } from './help.ts';
import { registerCheck, registerServe } from './serve.ts';
import { registerTools } from './tools.ts';

export type CommandRegistrar = (program: Command, ctx: CliContext, state: RunState) => void;

export const REGISTRARS: readonly CommandRegistrar[] = [
  registerDoctor,
  registerTools,
  registerCache,
  registerServe,
  registerCheck,
  registerHelp,
];

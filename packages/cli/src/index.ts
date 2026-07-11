import { realContext } from './context.ts';
import { run } from './main.ts';

export { buildProgram, run } from './main.ts';
export type { RunState } from './main.ts';
export { realContext, testContext } from './context.ts';
export type { CliContext } from './context.ts';

if (import.meta.main) {
  process.exitCode = await run(realContext(), process.argv);
}

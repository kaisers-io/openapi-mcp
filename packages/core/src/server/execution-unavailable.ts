import type { ToolExecutor } from './dispatch.ts';
import { textOutcome } from './result.ts';

// The M4 stub executor for upstream (OpenAPI-generated) tools. M5 implements
// the real hardened fetch behind this SAME seam (tool, parsed args, signal) ->
// ToolCallOutcome. Every otherwise-valid call to an upstream tool returns a
// stable, honest error rather than attempting any request — never advertise
// this as a working call.
export const executionUnavailable: ToolExecutor = () =>
  Promise.resolve(
    textOutcome(
      'execution lands in M5 — this server can list tools and validate calls but cannot execute them yet',
      true,
    ),
  );

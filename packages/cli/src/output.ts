import type { Command } from '@commander-js/extra-typings';
import {
  DISPLAY_TEXT_MAX,
  EXIT,
  renderError,
  sanitizeDisplayText,
  sanitizeSpecText,
} from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from './context.ts';

export interface OutputOptions {
  json: boolean;
  verbose: boolean;
}

// Warnings are single-line by contract; this bounds one hostile spec-derived value
const WARNING_DISPLAY_MAX = 1024;

export const getGlobalOpts = (program: Command): OutputOptions => {
  // Extra-typings erases accumulated option types on a plain Command parameter;
  // opts() takes no type arguments in v15, so coerce at this boundary.
  const opts = program.opts() as Record<string, unknown>;
  return { json: opts['json'] === true, verbose: opts['verbose'] === true };
};

export interface ActionResult {
  data: unknown;
  humanLines: readonly string[];
  // D11: exactOptionalPropertyTypes forces the explicit undefined
  warnings?: readonly string[] | undefined;
}

// Frozen call shape: warnings travel inside the result, never as a side channel,
// so a command cannot produce a warning that silently fails to be rendered.
export const emit = (ctx: CliContext, opts: OutputOptions, result: ActionResult): void => {
  const warnings = result.warnings ?? [];
  if (opts.json) {
    ctx.out(JSON.stringify({ ok: true, data: result.data, warnings }));
    return;
  }
  for (const line of result.humanLines) {
    ctx.out(line);
  }
  // Warnings go to stderr: stdout stays reserved for the command's own output so
  // it remains pipeable. Warnings can carry untrusted spec text (omitted paths,
  // dead filter patterns, cache diagnostics), and a warning must occupy exactly
  // one line, so the collapsing sanitizer is the correct one here —
  // sanitizeDisplayText is for rendered errors, where structure must survive.
  for (const warning of warnings) {
    ctx.errLine(`openapi-mcp: warning: ${sanitizeSpecText(warning, WARNING_DISPLAY_MAX)}`);
  }
};

export const emitError = (ctx: CliContext, opts: OutputOptions, err: unknown): number => {
  const rendered = renderError(err, { verbose: opts.verbose });
  if (opts.json) {
    ctx.out(
      JSON.stringify({
        ok: false,
        error: {
          code: rendered.code,
          message: rendered.message,
          ...(rendered.stack !== undefined ? { stack: rendered.stack } : {}),
        },
      }),
    );
    return rendered.exitCode;
  }
  // Rendered messages can carry untrusted spec text (Ajv instancePaths, YAML
  // parser messages, $ref echoes). This is the single human display boundary:
  // sanitize line-preservingly so multi-line validation output stays readable.
  ctx.errLine(`openapi-mcp: ${sanitizeDisplayText(rendered.message, DISPLAY_TEXT_MAX)}`);
  if (rendered.stack !== undefined) {
    ctx.errLine(sanitizeDisplayText(rendered.stack, DISPLAY_TEXT_MAX));
  }
  return rendered.exitCode;
};

export const wrapAction = async (
  ctx: CliContext,
  opts: OutputOptions,
  run: () => Promise<ActionResult>,
): Promise<number> => {
  try {
    const result = await run();
    emit(ctx, opts, result);
    return EXIT.OK;
  } catch (err) {
    return emitError(ctx, opts, err);
  }
};

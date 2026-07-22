import type { Command } from '@commander-js/extra-typings';
import {
  displayCells,
  DISPLAY_TEXT_MAX,
  EXIT,
  FRAME_MAX_LINES,
  FRAME_PER_LINE_MAX,
  gutterFrame,
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
  const warningGutter = 'openapi-mcp: warning: ';
  for (const warning of warnings) {
    const single = sanitizeSpecText(warning, WARNING_DISPLAY_MAX);
    const wrapped = gutterFrame([single], {
      gutter: warningGutter,
      terminalWidth: ctx.errWidth(),
      // Ceiling == the sanitized input's own cell count: gutterFrame can only
      // WRAP to terminalWidth, never re-truncate content sanitizeSpecText
      // already bounded (a same-valued perLineMax would double-truncate: the
      // sanitizer measures code UNITS, gutterFrame's cap measures display
      // CELLS, and its truncation marker's ellipsis is a 2-cell codepoint).
      perLineMax: displayCells(single),
      maxLines: 1,
    });
    for (const line of wrapped.lines) {
      ctx.errLine(line);
    }
  }
};

const ERROR_GUTTER = 'openapi-mcp: | ';

// Trusted header/footer, guttered hostile body: a multi-line or over-width
// message cannot spoof the framing lines because those two are never derived
// from untrusted text, and every body line is anchored by the gutter prefix.
const framedError = (ctx: CliContext, code: string, exitCode: number, bodyText: string): void => {
  const logicalLines = bodyText.split('\n');
  const body = gutterFrame(logicalLines, {
    gutter: ERROR_GUTTER,
    terminalWidth: ctx.errWidth(),
    perLineMax: FRAME_PER_LINE_MAX,
    maxLines: FRAME_MAX_LINES,
  });
  ctx.errLine(`openapi-mcp: error [${code}] (exit ${exitCode})`);
  for (const line of body.lines) {
    ctx.errLine(line);
  }
  const noun = body.logicalShown === 1 ? 'line' : 'lines';
  const suffix = body.truncated ? '; DETAILS TRUNCATED' : '';
  ctx.errLine(`openapi-mcp: [END ERROR: ${body.logicalShown} logical ${noun} shown${suffix}]`);
};

// Cell-aware (not code-unit) width check: a CJK/fullwidth line can be short in
// code units yet overflow the terminal in display cells (the H1 fix).
const fitsCompact = (line: string, width: number | undefined): boolean =>
  width === undefined || displayCells(`openapi-mcp: ${line}`) <= width;

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
  const message = sanitizeDisplayText(rendered.message, DISPLAY_TEXT_MAX);
  const stack =
    rendered.stack !== undefined
      ? sanitizeDisplayText(rendered.stack, DISPLAY_TEXT_MAX)
      : undefined;
  // Compact only for a single short line with no stack: nothing to spoof.
  if (stack === undefined && !message.includes('\n') && fitsCompact(message, ctx.errWidth())) {
    ctx.errLine(`openapi-mcp: ${message}`);
    return rendered.exitCode;
  }
  const bodyText = stack === undefined ? message : `${message}\n${stack}`;
  framedError(ctx, rendered.code, rendered.exitCode, bodyText);
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

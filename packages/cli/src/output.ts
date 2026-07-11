import { EXIT, renderError } from '@kaisers-io/openapi-mcp-core';
import type { CliContext } from './context.ts';

export interface OutputOptions {
  json: boolean;
  verbose: boolean;
}

export const emit = (
  ctx: CliContext,
  opts: OutputOptions,
  data: unknown,
  humanLines: readonly string[],
): void => {
  if (opts.json) {
    ctx.out(JSON.stringify({ ok: true, data, warnings: [] }));
    return;
  }
  for (const line of humanLines) {
    ctx.out(line);
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
  ctx.errLine(`openapi-mcp: ${rendered.message}`);
  if (rendered.stack !== undefined) {
    ctx.errLine(rendered.stack);
  }
  return rendered.exitCode;
};

export interface ActionResult {
  data: unknown;
  humanLines: readonly string[];
}

export const wrapAction = async (
  ctx: CliContext,
  opts: OutputOptions,
  run: () => Promise<ActionResult>,
): Promise<number> => {
  try {
    const result = await run();
    emit(ctx, opts, result.data, result.humanLines);
    return EXIT.OK;
  } catch (err) {
    return emitError(ctx, opts, err);
  }
};

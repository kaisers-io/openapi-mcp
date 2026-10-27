import type { Command } from '@commander-js/extra-typings';
import {
  CALL_TOOL_NAME,
  createDispatcher,
  DISPLAY_TEXT_MAX,
  dryRunCall,
  EXIT,
  OpenapiMcpError,
  sanitizeSpecText,
  textOutcome,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { DryRunCheck, DryRunReport, ToolExecutor } from '@kaisers-io/openapi-mcp-core';
import type { Occurrence } from '../api-options.ts';
import type { CliContext } from '../context.ts';
import { emitError, getGlobalOpts } from '../output.ts';
import type { RunState } from '../main.ts';
import { prepareServe } from './serve-action.ts';
import type { ServeCmdOpts } from './serve-action.ts';

// `call --dry-run` (issue #78): one tool call through the dispatcher of
// `serve`, with the same options, so its arguments are validated exactly as
// a host's call would be; the request is then built by the executor's own
// steps and described instead of sent. No request reaches the operation's
// URL or an OAuth token endpoint. Sending from the CLI is out of scope.

export type CallCmdOpts = ServeCmdOpts & { argsJson?: string; dryRun?: boolean };

const WARNING_PREFIX = 'openapi-mcp: warning: ';

const parseArgs = (raw: string | undefined): unknown => {
  if (raw === undefined) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw usageError('--args-json is not valid JSON');
  }
};

const checkLine = (name: string, check: DryRunCheck): string =>
  `${name}: ${check.status}${check.status === 'allowed' ? '' : ` (${check.reason})`}`;

const humanLinesOf = (tool: string, report: DryRunReport): string[] => [
  `${tool}: ${report.method} ${report.origin}${sanitizeSpecText(report.path, DISPLAY_TEXT_MAX)}`,
  `query: ${report.query.length === 0 ? 'none' : sanitizeSpecText(report.query.join(', '), DISPLAY_TEXT_MAX)}`,
  `headers: ${report.headers
    .map((header) =>
      header.credential === undefined ? header.name : `${header.name} (${header.credential})`,
    )
    .join(', ')}`,
  `body: ${report.body === 'none' ? 'none' : `${report.body.mediaType ?? 'no media type'}, ${String(report.body.bytes)} bytes`}`,
  ...report.uploads.map(
    (upload) =>
      `upload: ${upload.field} from ${sanitizeSpecText(upload.file, DISPLAY_TEXT_MAX)}, ${String(upload.bytes)} bytes`,
  ),
  checkLine('route', report.checks.route),
  checkLine('egress', report.checks.egress),
  checkLine('budgets', report.checks.budgets),
  `not evaluated: ${report.notEvaluated.join('; ')}`,
];

export const runCall = async (
  command: Command<[string], CallCmdOpts>,
  tool: string,
  cmdOpts: CallCmdOpts,
  ctx: CliContext,
  state: RunState,
  occurrences: readonly Occurrence[],
): Promise<void> => {
  const opts = getGlobalOpts(command.parent as Command);
  const warnings: string[] = [];
  const collecting: CliContext = {
    ...ctx,
    errWidth: () => {},
    errLine: (line) => {
      warnings.push(line.replace(WARNING_PREFIX, ''));
    },
  };
  let closeExecutor: (() => Promise<void>) | undefined;
  try {
    if (cmdOpts.dryRun !== true) {
      throw usageError('call needs --dry-run: it shows the request a tool call would send');
    }
    const args = parseArgs(cmdOpts.argsJson);
    const prepared = await prepareServe(
      command,
      cmdOpts,
      collecting,
      occurrences,
      (close) => {
        closeExecutor = close;
      },
      // Prepared as `serve` prepares, upload folder included, so a named
      // upload is read as a call would read it
    );
    const { snapshot } = prepared;
    // Only an operation: a meta or discovery tool sends no request
    const discover = snapshot.toolMode === 'discover';
    const known = discover
      ? Object.hasOwn(snapshot.operationsByName, tool)
      : snapshot.toolsByName[tool]?.kind === 'upstream';
    if (!known) {
      throw usageError(
        `no exposed operation is named "${sanitizeSpecText(tool, DISPLAY_TEXT_MAX)}"; "openapi-mcp tools" with the same options lists them`,
      );
    }
    let report: DryRunReport | undefined;
    const executor: ToolExecutor = async (target, data) => {
      const result = await dryRunCall(
        prepared.executorConfigFor(target),
        target,
        data,
        (hostname) =>
          ctx.transport.resolve(hostname, ctx.transport.timeoutSignal(prepared.timeoutMs)),
      );
      if ('refused' in result) {
        return result.refused;
      }
      ({ report } = result);
      return textOutcome('dry run', false);
    };
    const dispatcher = createDispatcher({
      ...prepared.dispatcherDeps,
      snapshot,
      executor,
      limiter: { consume: () => true, retryAfterMs: () => 0 },
    });
    const dispatched = await dispatcher.call(
      discover
        ? {
            name: CALL_TOOL_NAME,
            arguments: { name: tool, arguments: args },
            signal: AbortSignal.timeout(prepared.timeoutMs),
          }
        : { name: tool, arguments: args, signal: AbortSignal.timeout(prepared.timeoutMs) },
    );
    // `known` above rules out an unknown tool
    const { outcome } = dispatched as Extract<typeof dispatched, { kind: 'outcome' }>;
    if (report === undefined || outcome.isError) {
      // The tool error a host would see, already redacted by the dispatcher
      const text = outcome.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      state.exitCode = emitError(
        ctx,
        opts,
        new OpenapiMcpError('tool_error', text, EXIT.VALIDATION),
      );
      return;
    }
    const refused = Object.values(report.checks).some((check) => check.status === 'refused');
    if (opts.json) {
      const { warningReasons } = prepared;
      ctx.out(
        JSON.stringify({
          ok: !refused,
          data: { tool, ...report },
          warnings,
          ...(warningReasons.length === 0 ? {} : { warningReasons }),
        }),
      );
    } else {
      for (const line of humanLinesOf(tool, report)) {
        ctx.out(line);
      }
      for (const warning of warnings) {
        ctx.errLine(`${WARNING_PREFIX}${warning}`);
      }
    }
    state.exitCode = refused ? EXIT.VALIDATION : EXIT.OK;
  } catch (error) {
    state.exitCode = emitError(ctx, opts, error);
  } finally {
    await closeExecutor?.();
  }
};

import type { Command } from '@commander-js/extra-typings';
import { EXIT, parseHeaderEnvMapping, renderError } from '@kaisers-io/openapi-mcp-core';
import { apiViews } from '../api-options.ts';
import type { Occurrence } from '../api-options.ts';
import type { CliContext } from '../context.ts';
import { getGlobalOpts } from '../output.ts';
import type { RunState } from '../main.ts';
import { optionDefaults, prepareServe } from './serve-action.ts';
import type { ServeCmdOpts, ServeCommand } from './serve-action.ts';

// `check` (issue #77): the startup of `serve` with the same options, reported
// instead of served. Every environment variable the options name is checked
// first, all of them, never printing a value; then the preparation runs as
// `serve` would, without the upload folder, and with every output schema
// compiled, also under discover. No transport is opened and no operation is
// called.

type Variable = { name: string; flag: string; api?: string; set: boolean };
type Stage = { status: 'ok' | 'failed' | 'skipped'; error?: { code: string; message: string } };

const WARNING_PREFIX = 'openapi-mcp: warning: ';

const variablesOf = (
  command: ServeCommand,
  cmdOpts: ServeCmdOpts,
  occurrences: readonly Occurrence[],
  ctx: CliContext,
): Variable[] => {
  const variables: Variable[] = [];
  const add = (name: string, flag: string, api: string | undefined): void => {
    const value = ctx.env[name];
    variables.push({
      name,
      flag,
      ...(api === undefined ? {} : { api }),
      set: value !== undefined && value !== '',
    });
  };
  const views = apiViews(cmdOpts, occurrences, optionDefaults(command)) ?? [
    { name: undefined, options: cmdOpts },
  ];
  for (const { name: api, options } of views) {
    for (const raw of options.specHeaderEnv) {
      add(parseHeaderEnvMapping(raw).envVar, '--spec-header-env', api);
    }
    for (const raw of options.headerEnv) {
      add(parseHeaderEnvMapping(raw).envVar, '--header-env', api);
    }
    if (options.upstreamOauthClientIdEnv !== undefined) {
      add(options.upstreamOauthClientIdEnv, '--upstream-oauth-client-id-env', api);
    }
    if (options.upstreamOauthClientSecretEnv !== undefined) {
      add(options.upstreamOauthClientSecretEnv, '--upstream-oauth-client-secret-env', api);
    }
  }
  if (cmdOpts.http === true && cmdOpts.httpTokenEnv !== undefined) {
    add(cmdOpts.httpTokenEnv, '--http-token-env', undefined);
  }
  return variables;
};

const humanLinesOf = (data: CheckData): string[] => [
  `environment: ${data.environment.status}`,
  ...data.environment.variables.map(
    (variable) =>
      `  ${variable.name} (${variable.api === undefined ? '' : `${variable.api} `}${variable.flag}): ${variable.set ? 'set' : 'missing'}`,
  ),
  `startup: ${data.startup.status}${data.startup.error === undefined ? '' : `: ${data.startup.error.message}`}`,
  ...(data.toolMode === undefined
    ? []
    : [
        `tool mode: ${data.toolMode}${data.toolModeReason === undefined ? '' : ` (auto: ${data.toolModeReason})`}`,
      ]),
  ...(data.apis ?? []).map(
    (api) =>
      `${api.name === undefined ? 'api' : `api ${api.name}`}: ${api.baseUrl}, ${String(api.exposed.length)} operations exposed`,
  ),
  ...(data.listedTools === undefined
    ? []
    : [`tools the host lists: ${String(data.listedTools.length)}`]),
];

type Prepared = Awaited<ReturnType<typeof prepareServe>>;

type CheckData = {
  environment: { status: Stage['status']; variables: Variable[] };
  startup: Stage;
  toolMode?: string;
  toolModeReason?: string;
  apis?: Prepared['apis'];
  listedTools?: string[];
};

export const runCheck = async (
  command: Command<[], ServeCmdOpts>,
  cmdOpts: ServeCmdOpts,
  ctx: CliContext,
  state: RunState,
  occurrences: readonly Occurrence[],
): Promise<void> => {
  const opts = getGlobalOpts(command.parent as Command);
  const warnings: string[] = [];
  // The startup warnings of `serve`, collected for the report, unwrapped
  const collecting: CliContext = {
    ...ctx,
    errWidth: () => {},
    errLine: (line) => {
      warnings.push(line.replace(WARNING_PREFIX, ''));
    },
  };
  const variables = variablesOf(command, cmdOpts, occurrences, ctx);
  const missing = variables.some((variable) => !variable.set);
  let exitCode: number = missing ? EXIT.USAGE : EXIT.OK;
  let startup: Stage = { status: 'skipped' };
  let prepared: Prepared | undefined;
  if (!missing) {
    let closeExecutor: (() => Promise<void>) | undefined;
    try {
      prepared = await prepareServe(
        command,
        cmdOpts,
        collecting,
        occurrences,
        (close) => {
          closeExecutor = close;
        },
        true,
      );
      startup = { status: 'ok' };
    } catch (error) {
      const { code, message, exitCode: failed } = renderError(error, { verbose: false });
      startup = { status: 'failed', error: { code, message } };
      exitCode = failed;
    } finally {
      await closeExecutor?.();
    }
  }
  const data: CheckData = {
    environment: { status: missing ? 'failed' : 'ok', variables },
    startup,
    ...(prepared === undefined
      ? {}
      : {
          toolMode: prepared.snapshot.toolMode,
          ...(prepared.toolModeReason === undefined
            ? {}
            : { toolModeReason: prepared.toolModeReason }),
          apis: prepared.apis,
          listedTools: prepared.snapshot.tools.map((tool) => tool.name),
        }),
  };
  if (opts.json) {
    ctx.out(JSON.stringify({ ok: exitCode === EXIT.OK, data, warnings }));
  } else {
    for (const line of humanLinesOf(data)) {
      ctx.out(line);
    }
    for (const warning of warnings) {
      ctx.errLine(`${WARNING_PREFIX}${warning}`);
    }
  }
  state.exitCode = exitCode;
};

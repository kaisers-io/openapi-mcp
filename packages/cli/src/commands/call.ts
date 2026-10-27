import type { Command } from '@commander-js/extra-typings';
import type { CallCmdOpts } from './call-action.ts';
import type { CommandRegistrar } from './registry.ts';
import { registerServeOptions } from './serve.ts';

// `call --dry-run` (issue #78) takes every option of `serve`, like `check`;
// the action is imported when it runs, as for `serve`.
export const registerCall: CommandRegistrar = (program, ctx, state) => {
  const { command, occurrences } = registerServeOptions(
    program
      .command('call')
      .argument('<tool>', 'the tool name the host lists; in discover mode, the operation name')
      .description(
        'show the request a tool call would send, with the same options as serve, without sending it (needs --dry-run)',
      )
      .option('--args-json <json>', 'the tool call arguments as a JSON object')
      .option(
        '--dry-run',
        'build and describe the request instead of sending it',
      ) as unknown as Command,
  );
  const call = command as unknown as Command<[string], CallCmdOpts>;
  call.action(async (tool: string, cmdOpts: CallCmdOpts) => {
    const { runCall } = await import('./call-action.ts');
    await runCall(call, tool, cmdOpts, ctx, state, occurrences);
  });
};

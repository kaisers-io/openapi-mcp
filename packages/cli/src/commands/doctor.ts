import { join } from 'node:path';
import { validationError } from '@kaisers-io/openapi-mcp-core';
import pkg from '../../package.json' with { type: 'json' };
import type { CliContext } from '../context.ts';
import { getGlobalOpts, wrapAction } from '../output.ts';
import type { CommandRegistrar } from './registry.ts';

export const APP_DIR_SEGMENTS = ['.kaisers-io', 'openapi-mcp'] as const;

const resolveAppRoot = (ctx: CliContext): string => {
  const home = ctx.homeDir();
  if (home === undefined || home === '') {
    throw validationError('cannot resolve the home directory for the openapi-mcp app root');
  }
  return join(home, ...APP_DIR_SEGMENTS);
};

export const registerDoctor: CommandRegistrar = (program, ctx, state) => {
  program
    .command('doctor')
    .description('diagnostics: CLI and Node versions, app root and cache root')
    .action(async () => {
      const opts = getGlobalOpts(program);
      state.exitCode = await wrapAction(ctx, opts, () => {
        const appRoot = resolveAppRoot(ctx);
        const cacheRoot = join(appRoot, 'cache');
        const data = {
          cliVersion: pkg.version,
          nodeVersion: ctx.nodeVersion,
          appRoot,
          cacheRoot,
          cacheRootExists: ctx.pathExists(cacheRoot),
        };
        return Promise.resolve({
          data,
          humanLines: [
            `openapi-mcp ${data.cliVersion} (node ${data.nodeVersion})`,
            `app root:   ${data.appRoot}`,
            `cache root: ${data.cacheRoot}${data.cacheRootExists ? '' : ' (not created yet)'}`,
          ],
        });
      });
    });
};

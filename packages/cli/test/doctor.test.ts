import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// The roots are joined with the platform separator: '/home/tester/.kaisers-io/openapi-mcp' on POSIX
const APP_ROOT = join('/home/tester', '.kaisers-io', 'openapi-mcp');
const CACHE_ROOT = join(APP_ROOT, 'cache');

describe('doctor', () => {
  it('reports versions, app root, and cache root in JSON mode', async () => {
    const lines: string[] = [];
    const ctx = testContext({
      lines,
      homeDir: () => '/home/tester',
      nodeVersion: '24.12.0',
      pathExists: (path) => path === CACHE_ROOT,
    });
    const code = await run(ctx, ['node', 'openapi-mcp', '--json', 'doctor']);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      ok: boolean;
      data: {
        cliVersion: string;
        nodeVersion: string;
        appRoot: string;
        cacheRoot: string;
        cacheRootExists: boolean;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.cliVersion).toMatch(/^\d+\.\d+\.\d+/u);
    expect(envelope.data.nodeVersion).toBe('24.12.0');
    expect(envelope.data.appRoot).toBe(APP_ROOT);
    expect(envelope.data.cacheRoot).toBe(CACHE_ROOT);
    expect(envelope.data.cacheRootExists).toBe(true);
  });

  it('prints human-readable lines in human mode', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines, homeDir: () => '/home/tester' });
    const code = await run(ctx, ['node', 'openapi-mcp', 'doctor']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain('openapi-mcp');
    expect(text).toContain(CACHE_ROOT);
    expect(text).toContain('(not created yet)');
  });

  it('fails with a validation error when no home directory can be resolved', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, homeDir: () => {} });
    const code = await run(ctx, ['node', 'openapi-mcp', 'doctor']);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('home directory');
  });
});

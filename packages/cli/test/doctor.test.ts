import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

describe('doctor', () => {
  it('reports versions, app root, and cache root in JSON mode', async () => {
    const lines: string[] = [];
    const ctx = testContext({
      lines,
      homeDir: () => '/home/tester',
      nodeVersion: '24.12.0',
      pathExists: (path) => path === '/home/tester/.kaisers-io/openapi-mcp/cache',
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
    expect(envelope.data.appRoot).toBe('/home/tester/.kaisers-io/openapi-mcp');
    expect(envelope.data.cacheRoot).toBe('/home/tester/.kaisers-io/openapi-mcp/cache');
    expect(envelope.data.cacheRootExists).toBe(true);
  });

  it('prints human-readable lines in human mode', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines, homeDir: () => '/home/tester' });
    const code = await run(ctx, ['node', 'openapi-mcp', 'doctor']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain('openapi-mcp');
    expect(text).toContain('/home/tester/.kaisers-io/openapi-mcp/cache');
    expect(text).toContain('(not created yet)');
  });

  it('fails with a validation error when no home directory can be resolved', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, homeDir: () => undefined });
    const code = await run(ctx, ['node', 'openapi-mcp', 'doctor']);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('home directory');
  });
});

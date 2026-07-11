import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';
import type { CommandRegistrar } from '../src/commands/registry.ts';

describe('run', () => {
  it('prints the version and exits 0', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    const code = await run(ctx, ['node', 'openapi-mcp', '--version']);
    expect(code).toBe(EXIT.OK);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('prints plain version text even with --json (documented exception)', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    const code = await run(ctx, ['node', 'openapi-mcp', '--json', '--version']);
    expect(code).toBe(EXIT.OK);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('prints help and exits 0', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    const code = await run(ctx, ['node', 'openapi-mcp', '--help']);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('Usage: openapi-mcp');
  });

  it('treats an unknown command as a usage error on stderr with exit 2', async () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    const code = await run(ctx, ['node', 'openapi-mcp', 'frobnicate']);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('frobnicate');
    expect(lines).toEqual([]);
  });

  it('routes usage errors through the JSON envelope when --json is set', async () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    const code = await run(ctx, ['node', 'openapi-mcp', '--json', 'frobnicate']);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines).toEqual([]);
    const envelope = JSON.parse(lines[0]!) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('usage');
  });

  it('does not leak exit codes across invocations in one process', async () => {
    const ctxFail = testContext({ errLines: [] });
    const failCode = await run(ctxFail, ['node', 'openapi-mcp', 'frobnicate']);
    expect(failCode).toBe(EXIT.USAGE);
    const lines: string[] = [];
    const ctxOk = testContext({ lines });
    const okCode = await run(ctxOk, ['node', 'openapi-mcp', '--version']);
    expect(okCode).toBe(EXIT.OK);
    expect(process.exitCode).toBeUndefined();
  });

  it('runs commands from injected registrars and routes plain thrown errors as unexpected', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const boom: CommandRegistrar = (program) => {
      program.command('boom').action(() => {
        throw new Error('kaboom');
      });
    };
    const code = await run(ctx, ['node', 'openapi-mcp', 'boom'], [boom]);
    expect(code).toBe(EXIT.UNEXPECTED);
    expect(errLines).toEqual(['openapi-mcp: kaboom']);
  });

  it('routes commander error output through the writeErr callback', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const helpToStderr: CommandRegistrar = (program) => {
      program.command('helpme').action(() => {
        program.outputHelp({ error: true });
      });
    };
    const code = await run(ctx, ['node', 'openapi-mcp', 'helpme'], [helpToStderr]);
    expect(code).toBe(EXIT.OK);
    expect(errLines.join('\n')).toContain('Usage: openapi-mcp');
  });

  it('keeps the default registrars when none are injected', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines, homeDir: () => '/home/tester' });
    const code = await run(ctx, ['node', 'openapi-mcp', 'doctor']);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('app root:');
  });
});

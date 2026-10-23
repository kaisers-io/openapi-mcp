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

  // The help text must describe what the flags do in each command: in serve,
  // --allow-private-network also governs API egress, and --http-host is refused
  // in static mode for every value (not only for non-loopback ones).
  it('describes --allow-private-network and --http-host by their real scope', async () => {
    const helpOf = async (command: string): Promise<string> => {
      const lines: string[] = [];
      const code = await run(testContext({ lines }), ['node', 'openapi-mcp', command, '--help']);
      expect(code).toBe(EXIT.OK);
      // Commander wraps long descriptions; compare on single spaces
      return lines.join('\n').replaceAll(/\s+/gu, ' ');
    };
    const serve = await helpOf('serve');
    expect(serve).toContain(
      '--allow-private-network permit private/loopback addresses for spec fetch redirects, for API requests to a spec-derived origin or redirect, and for the --upstream-oauth-* token URL (never cloud-metadata)',
    );
    expect(serve).toContain(
      '--http-host <addr> IP address to bind; only with --http-auth oauth (static mode always binds 127.0.0.1)',
    );
    expect(serve).not.toContain('any other requires --http-auth oauth');
    const tools = await helpOf('tools');
    expect(tools).toContain(
      '--allow-private-network permit private/loopback redirect targets during the spec fetch (never cloud-metadata)',
    );
  });

  // Issue #3: the flag is shared by serve and tools, with one help text.
  it('describes --nullable-response-fields in serve and tools help', async () => {
    const help =
      '--nullable-response-fields admit null for every object property in derived output schemas (for specs, e.g. springdoc, that omit "nullable")';
    for (const command of ['serve', 'tools']) {
      const lines: string[] = [];
      const code = await run(testContext({ lines }), ['node', 'openapi-mcp', command, '--help']);
      expect(code).toBe(EXIT.OK);
      expect(lines.join('\n').replaceAll(/\s+/gu, ' ')).toContain(help);
    }
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

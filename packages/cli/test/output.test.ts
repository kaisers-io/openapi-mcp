import { describe, expect, it } from 'vitest';
import { EXIT, usageError } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { emit, emitError, wrapAction } from '../src/output.ts';

describe('emit', () => {
  it('prints human lines to stdout in human mode', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(ctx, { json: false, verbose: false }, { a: 1 }, ['first', 'second']);
    expect(lines).toEqual(['first', 'second']);
  });

  it('prints one JSON envelope in json mode', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(ctx, { json: true, verbose: false }, { a: 1 }, ['ignored']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, data: { a: 1 }, warnings: [] });
  });
});

describe('emitError', () => {
  it('writes errors to stderr with prefix in human mode and returns the exit code', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const code = emitError(ctx, { json: false, verbose: false }, usageError('bad flag'));
    expect(code).toBe(EXIT.USAGE);
    expect(errLines).toEqual(['openapi-mcp: bad flag']);
  });

  it('appends the stack line in verbose human mode', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const code = emitError(ctx, { json: false, verbose: true }, usageError('bad flag'));
    expect(code).toBe(EXIT.USAGE);
    expect(errLines[0]).toBe('openapi-mcp: bad flag');
    expect(errLines[1]).toContain('output.test.ts');
  });

  it('writes the error envelope to stdout in json mode', () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    const code = emitError(ctx, { json: true, verbose: false }, usageError('bad flag'));
    expect(code).toBe(EXIT.USAGE);
    expect(errLines).toEqual([]);
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: false,
      error: { code: 'usage', message: 'bad flag' },
    });
  });

  it('includes the stack in the json envelope when verbose', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emitError(ctx, { json: true, verbose: true }, usageError('bad flag'));
    const envelope = JSON.parse(lines[0]!) as { error: { stack?: string } };
    expect(envelope.error.stack).toContain('output.test.ts');
  });
});

describe('wrapAction', () => {
  it('emits success data and returns OK', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    const code = await wrapAction(ctx, { json: true, verbose: false }, () =>
      Promise.resolve({ data: { ok: true }, humanLines: ['done'] }),
    );
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, data: { ok: true }, warnings: [] });
  });

  it('catches thrown errors and returns their exit code', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const code = await wrapAction(ctx, { json: false, verbose: false }, () => {
      throw usageError('nope');
    });
    expect(code).toBe(EXIT.USAGE);
    expect(errLines).toEqual(['openapi-mcp: nope']);
  });
});

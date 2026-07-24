import { describe, expect, it } from 'vitest';
import { EXIT, sanitizeSpecText, usageError, validationError } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { emit, emitError, emitWarnings, wrapAction, type ActionResult } from '../src/output.ts';

describe('emit', () => {
  it('prints human lines to stdout in human mode', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(ctx, { json: false, verbose: false }, { data: { a: 1 }, humanLines: ['first', 'second'] });
    expect(lines).toEqual(['first', 'second']);
  });

  it('prints one JSON envelope in json mode', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(ctx, { json: true, verbose: false }, { data: { a: 1 }, humanLines: ['ignored'] });
    expect(lines).toHaveLength(1);
    // An omitted warnings field still normalises to [] on the wire
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

  it('frames a multi-line error with header, gutter, and footer', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines }); // Undefined errWidth() -> no hard-wrap
    const err = validationError(
      'spec failed OpenAPI 3.0.3 schema validation:\n  /paths/~1a\u001B]0;PWNED\u001B\\x/get: must be object',
    );
    emitError(ctx, { json: false, verbose: false }, err);
    expect(errLines).toEqual([
      'openapi-mcp: error [validation] (exit 3)',
      'openapi-mcp: | spec failed OpenAPI 3.0.3 schema validation:',
      'openapi-mcp: |   /paths/~1a]0;PWNED\\x/get: must be object',
      'openapi-mcp: [END ERROR: 2 logical lines shown]',
    ]);
    // No escape survives, and no body line sits at column zero
    for (const line of errLines) {
      expect(line).not.toContain('\u001B');
      expect(line.startsWith('openapi-mcp:')).toBe(true);
    }
  });

  it('keeps a short single-line error compact', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emitError(ctx, { json: false, verbose: false }, usageError('bad flag'));
    expect(errLines).toEqual(['openapi-mcp: bad flag']);
  });

  it('promotes a single line that overflows the TTY width to framed mode', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, errWidth: () => 40 });
    emitError(ctx, { json: false, verbose: false }, validationError('z'.repeat(60)));
    expect(errLines[0]).toBe('openapi-mcp: error [validation] (exit 3)');
    expect(errLines.at(-1)).toBe('openapi-mcp: [END ERROR: 1 logical line shown]');
    // Every body physical line fits the width and carries the gutter
    for (const line of errLines.slice(1, -1)) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line.startsWith('openapi-mcp: | ')).toBe(true);
    }
  });

  it('marks the footer truncated when the body exceeds the line-count cap', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const body = Array.from({ length: 60 }, (_v, i) => `entry ${i}`).join('\n');
    emitError(ctx, { json: false, verbose: false }, validationError(body));
    expect(errLines.at(-1)).toBe(
      'openapi-mcp: [END ERROR: 40 logical lines shown; DETAILS TRUNCATED]',
    );
  });

  it('does not keep a wide (CJK) single line compact when it overflows the width in cells', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, errWidth: () => 40 });
    // 27 CJK chars = 54 cells; + "openapi-mcp: " (13) = 67 cells > 40, so the
    // pre-fix code-unit check (27 + 13 = 40) wrongly kept it compact.
    emitError(ctx, { json: false, verbose: false }, validationError('界'.repeat(27)));
    expect(errLines[0]).toBe('openapi-mcp: error [validation] (exit 3)');
    expect(errLines.at(-1)!.startsWith('openapi-mcp: [END ERROR:')).toBe(true);
  });

  it('frames the stack in verbose human mode', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emitError(ctx, { json: false, verbose: true }, usageError('bad flag'));
    expect(errLines[0]).toBe('openapi-mcp: error [usage] (exit 2)');
    expect(
      errLines.some((l) => l.startsWith('openapi-mcp: | ') && l.includes('output.test.ts')),
    ).toBe(true);
    expect(errLines.at(-1)!.startsWith('openapi-mcp: [END ERROR:')).toBe(true);
  });

  it('sanitizes the stack line in verbose human mode', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const err = usageError('bad flag');
    err.stack = 'Error: bad flag\n    at \u001B]0;PWNED\u0007evil.ts:1:1';
    emitError(ctx, { json: false, verbose: true }, err);
    for (const line of errLines) {
      expect(line).not.toContain('\u001B');
      expect(line).not.toContain('\u0007');
    }
  });

  it('leaves the json envelope raw — JSON encoding already escapes controls', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emitError(ctx, { json: true, verbose: false }, validationError('evil\u001Bmessage'));
    const envelope = JSON.parse(lines[0]!) as { error: { message: string } };
    expect(envelope.error.message).toBe('evil\u001Bmessage');
    // The raw stdout line carries the escape only in its \u-encoded form
    expect(lines[0]).toContain('\\u001b');
    expect(lines[0]).not.toContain('\u001B');
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

describe('warnings channel', () => {
  it('carries warnings in the json envelope', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(
      ctx,
      { json: true, verbose: false },
      {
        data: { a: 1 },
        humanLines: ['ignored'],
        warnings: ['first', 'second'],
      },
    );
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: true,
      data: { a: 1 },
      warnings: ['first', 'second'],
    });
  });

  it('writes warnings to stderr in human mode, leaving stdout untouched', () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: { a: 1 },
        humanLines: ['payload'],
        warnings: ['careful'],
      },
    );
    // Stdout stays reserved for the command's own output so it remains pipeable
    expect(lines).toEqual(['payload']);
    expect(errLines).toEqual(['openapi-mcp: warning: careful']);
  });

  it('writes one stderr line per warning', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['one', 'two', 'three'],
      },
    );
    expect(errLines).toEqual([
      'openapi-mcp: warning: one',
      'openapi-mcp: warning: two',
      'openapi-mcp: warning: three',
    ]);
  });

  it('sanitizes untrusted spec text out of a human warning', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['GET /a\u001B]0;PWNED\u001B\\x omitted'],
      },
    );
    expect(errLines[0]).not.toContain('\u001B');
    expect(errLines[0]).toBe('openapi-mcp: warning: GET /a]0;PWNED\\x omitted');
  });

  // Serve.ts (Task 6 security fix) calls emitWarnings() directly -- never
  // emit() -- so the sanitization it relies on must be proven against
  // emitWarnings() itself, not only inferred from emit() delegating to it.
  // The ESC byte is built at runtime, never typed/pasted literally.
  it('emitWarnings() sanitizes untrusted spec text directly, independent of emit()', () => {
    const esc = String.fromCodePoint(0x1b);
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emitWarnings(ctx, [`GET /a${esc}]0;PWNED${esc}\\x omitted`]);
    expect(errLines[0]).not.toContain(esc);
    expect(errLines[0]).toBe('openapi-mcp: warning: GET /a]0;PWNED\\x omitted');
  });

  it('collapses a multi-line warning onto one line', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['first\nsecond'],
      },
    );
    // Warnings are single-line by contract: sanitizeSpecText, not sanitizeDisplayText
    expect(errLines).toEqual(['openapi-mcp: warning: first second']);
  });

  it('caps a hostile spec-derived warning', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['x'.repeat(5000)],
      },
    );
    expect(errLines[0]!.length).toBeLessThanOrEqual('openapi-mcp: warning: '.length + 1024);
  });

  it('hard-wraps a long warning to the TTY width, repeating the prefix', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, errWidth: () => 30 });
    emit(
      ctx,
      { json: false, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['w'.repeat(40)],
      },
    );
    for (const line of errLines) {
      expect(line.length).toBeLessThanOrEqual(30);
      expect(line.startsWith('openapi-mcp: warning: ')).toBe(true);
    }
    // The full payload is preserved across the wrapped lines
    expect(errLines.map((l) => l.slice('openapi-mcp: warning: '.length)).join('')).toBe(
      'w'.repeat(40),
    );
  });

  it('wraps a warning without re-truncating the sanitize-capped content (incl. wide chars)', () => {
    const gutter = 'openapi-mcp: warning: ';
    for (const raw of ['界'.repeat(1024), '界'.repeat(2000), 'w'.repeat(4000)]) {
      const errLines: string[] = [];
      const ctx = testContext({ errLines }); // Undefined errWidth() -> one line, easy reconstruction
      emit(ctx, { json: false, verbose: false }, { data: {}, humanLines: [], warnings: [raw] });
      const reconstructed = errLines.map((l) => l.slice(gutter.length)).join('');
      expect(reconstructed).toBe(sanitizeSpecText(raw, 1024)); // Exactly one marker, no double-truncation
    }
  });

  it('leaves the json warning raw — JSON encoding already escapes controls', () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    emit(
      ctx,
      { json: true, verbose: false },
      {
        data: {},
        humanLines: [],
        warnings: ['evil\u001Bwarning'],
      },
    );
    const envelope = JSON.parse(lines[0]!) as { warnings: string[] };
    expect(envelope.warnings[0]).toBe('evil\u001Bwarning');
    // The raw stdout line carries the escape only in its \u-encoded form
    expect(lines[0]).toContain('\\u001b');
    expect(lines[0]).not.toContain('\u001B');
  });

  it('passes warnings from an ActionResult through wrapAction in json mode', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    const result: ActionResult = { data: { ok: 1 }, humanLines: [], warnings: ['dead pattern'] };
    const code = await wrapAction(ctx, { json: true, verbose: false }, () =>
      Promise.resolve(result),
    );
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: true,
      data: { ok: 1 },
      warnings: ['dead pattern'],
    });
  });

  it('passes warnings from an ActionResult through wrapAction in human mode', async () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    const code = await wrapAction(ctx, { json: false, verbose: false }, () =>
      Promise.resolve({ data: {}, humanLines: ['body'], warnings: ['dead pattern'] }),
    );
    expect(code).toBe(EXIT.OK);
    expect(lines).toEqual(['body']);
    expect(errLines).toEqual(['openapi-mcp: warning: dead pattern']);
  });

  it('emits no warning lines when an ActionResult omits the field', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    await wrapAction(ctx, { json: false, verbose: false }, () =>
      Promise.resolve({ data: {}, humanLines: [] }),
    );
    expect(errLines).toEqual([]);
  });

  it('emits no warnings when a command fails — the error path owns stderr', async () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines });
    const code = await wrapAction(ctx, { json: false, verbose: false }, () =>
      Promise.reject(usageError('bad flag')),
    );
    expect(code).toBe(EXIT.USAGE);
    expect(errLines).toEqual(['openapi-mcp: bad flag']);
  });
});

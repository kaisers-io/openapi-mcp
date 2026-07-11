import { afterEach, describe, expect, it, vi } from 'vitest';
import { realContext, testContext } from '../src/context.ts';

describe('realContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the real process facts', () => {
    const ctx = realContext();
    expect(ctx.nodeVersion).toBe(process.versions.node);
    expect(ctx.env).toBe(process.env);
    expect(typeof ctx.homeDir()).toBe('string');
    expect(ctx.pathExists('/definitely/not/a/real/path/xyz')).toBe(false);
  });

  it('writes lines to stdout and stderr', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ctx = realContext();
    ctx.out('hello');
    ctx.errLine('oops');
    expect(outSpy).toHaveBeenCalledWith('hello\n');
    expect(errSpy).toHaveBeenCalledWith('oops\n');
  });

  it('now() returns the current epoch', () => {
    const before = Date.now();
    const ctx = realContext();
    expect(ctx.now()).toBeGreaterThanOrEqual(before);
  });
});

describe('testContext', () => {
  it('captures output and provides safe defaults', async () => {
    const lines: string[] = [];
    const ctx = testContext({ lines });
    ctx.out('captured');
    expect(lines).toEqual(['captured']);
    expect(ctx.homeDir()).toBeUndefined();
    expect(ctx.pathExists('/anything')).toBe(false);
    expect(ctx.now()).toBe(0);
    await expect(ctx.fetcher('https://example.com')).rejects.toThrow('no fetcher');
  });
});

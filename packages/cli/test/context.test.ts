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

  it('reads real files, reports sizes, and exposes cwd', async () => {
    const ctx = realContext();
    const { fileURLToPath } = await import('node:url');
    const self = fileURLToPath(import.meta.url);
    const text = await ctx.readFileText(self);
    expect(text).toContain('realContext');
    await expect(ctx.fileSizeBytes(self)).resolves.toBeGreaterThan(0);
    expect(ctx.cwd()).toBe(process.cwd());
    const addresses = await ctx.lookup('localhost', new AbortController().signal);
    expect(addresses.length).toBeGreaterThan(0);
    await expect(ctx.lookup('localhost', AbortSignal.abort())).rejects.toThrow('aborted');
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
    expect(ctx.cwd()).toBe('/test-cwd');
    await expect(ctx.fetcher('https://example.com')).rejects.toThrow('no fetcher');
    await expect(ctx.readFileText('/x')).rejects.toThrow('no file access');
    await expect(ctx.fileSizeBytes('/x')).rejects.toThrow('no file access');
    await expect(ctx.lookup('example.com', new AbortController().signal)).rejects.toThrow(
      'no dns lookup',
    );
  });
});

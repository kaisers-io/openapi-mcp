import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const linkMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const rmMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: (...args: unknown[]) => openMock(...args),
    link: (...args: unknown[]) => linkMock(...args),
    rm: (...args: unknown[]) => rmMock(...args),
  } as typeof actual;
});

// Import AFTER vi.mock so realContext binds the mocked fs primitives.
const { realContext } = await import('../src/context.ts');

describe('createExclusive atomic publish', () => {
  beforeEach(() => {
    openMock.mockReset();
    linkMock.mockReset();
    rmMock.mockReset().mockResolvedValue();
  });

  it('never publishes or removes the lock path when the record write fails', async () => {
    const closed = vi.fn<() => Promise<void>>(() => Promise.resolve());
    openMock.mockResolvedValue({
      writeFile: () => Promise.reject(new Error('EIO')),
      chmod: () => Promise.resolve(),
      sync: () => Promise.resolve(),
      close: closed,
    });
    linkMock.mockResolvedValue();
    await expect(
      realContext().cacheFs.createExclusive('/cache/ns/.lock', 'record'),
    ).rejects.toThrow(/EIO/u);
    // Open received a TEMP path, never the lock path (proves temp-first, and
    // catches an "old-shape" implementation that writes directly to the lock).
    const openPath = openMock.mock.calls[0]?.[0] as string;
    expect(openPath).not.toBe('/cache/ns/.lock');
    expect(openPath.includes('.lock.') && openPath.endsWith('.tmp')).toBe(true);
    // The temp is created EXCLUSIVELY (wx) at mode 0600 — a truncating or
    // non-exclusive open would let a planted temp be written through.
    expect(openMock.mock.calls[0]?.[1]).toBe('wx');
    expect(openMock.mock.calls[0]?.[2]).toBe(0o600);
    // The temp is cleaned up even when the record write fails (finally runs rm).
    expect(rmMock.mock.calls.map((c) => c[0] as string)).toContain(openPath);
    expect(closed).toHaveBeenCalledWith();
    expect(linkMock).toHaveBeenCalledTimes(0); // Write failed before publish
    expect(rmMock.mock.calls.map((c) => c[0] as string)).not.toContain('/cache/ns/.lock');
  });

  it('publishes the lock by linking the temp into place on success', async () => {
    openMock.mockResolvedValue({
      writeFile: () => Promise.resolve(),
      chmod: () => Promise.resolve(),
      sync: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    linkMock.mockResolvedValue();
    expect(await realContext().cacheFs.createExclusive('/cache/ns/.lock', 'record')).toBe(true);
    expect(linkMock.mock.calls[0]?.[1]).toBe('/cache/ns/.lock');
    // Link's SOURCE is exactly the temp that open created (temp-first → publish).
    const tmpPath = openMock.mock.calls[0]?.[0] as string;
    expect(linkMock.mock.calls[0]?.[0]).toBe(tmpPath);
    // The temp is removed after a successful publish (no .tmp leak).
    expect(rmMock.mock.calls.map((c) => c[0] as string)).toContain(tmpPath);
  });

  it('returns false when the lock is already held (link EEXIST)', async () => {
    openMock.mockResolvedValue({
      writeFile: () => Promise.resolve(),
      chmod: () => Promise.resolve(),
      sync: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    linkMock.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    expect(await realContext().cacheFs.createExclusive('/cache/ns/.lock', 'record')).toBe(false);
  });

  it('a temp-cleanup failure does not fail a successful acquisition', async () => {
    openMock.mockResolvedValue({
      writeFile: () => Promise.resolve(),
      chmod: () => Promise.resolve(),
      sync: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    linkMock.mockResolvedValue();
    rmMock.mockRejectedValue(new Error('rm failed')); // Temp cleanup throws AFTER publish
    expect(await realContext().cacheFs.createExclusive('/cache/ns/.lock', 'record')).toBe(true);
  });
});

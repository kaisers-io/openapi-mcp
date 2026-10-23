import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realContext } from '../src/context.ts';

// The real cache runtime and file timestamps behind `cache unlock` and the
// lock-holder report (kaisers-io/openapi-mcp-archive#65), exercised in-process
// (issue kaisers-io/openapi-mcp-archive#86 floors).
describe('realContext cache runtime', () => {
  const { runtime } = realContext().cacheFs;

  it('reports this process as alive and an impossible pid as gone', () => {
    expect(runtime?.pid).toBe(process.pid);
    expect(runtime?.isProcessAlive(process.pid)).toBe(true);
    // Above Linux's and macOS's pid ceilings, so the kernel answers ESRCH
    expect(runtime?.isProcessAlive(2_147_483_646)).toBe(false);
  });

  it('reads a file modification time without following it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-mtime-'));
    try {
      const path = join(dir, 'lock');
      await writeFile(path, '{}');
      const info = await stat(path);
      const expected = info.mtimeMs;
      await expect(realContext().cacheFs.modifiedAtMs?.(path)).resolves.toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

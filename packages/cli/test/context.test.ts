import { spawnSync } from 'node:child_process';
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readExactly, realContext, testContext } from '../src/context.ts';

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

const modeOf = async (path: string): Promise<string> => {
  const stats = await stat(path);
  return (stats.mode & 0o7777).toString(8);
};

describe('realContext cacheFs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-cachefs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates directories at 0700 including parents', async () => {
    const target = join(dir, 'ns', 'objects');
    await realContext().cacheFs.mkdirSecure(target);
    expect(await modeOf(target)).toBe('700');
    expect(await modeOf(join(dir, 'ns'))).toBe('700');
  });

  it('propagates a non-absence stat failure from pathExists instead of reporting false (D17)', async () => {
    // An unreadable parent must never be reported as "nothing cached here":
    // a miss is the one outcome that may become trust-on-first-use
    const locked = join(dir, 'locked');
    await mkdir(locked, { mode: 0o700 });
    await writeFile(join(locked, 'meta.json'), '{}');
    await chmod(locked, 0o000);
    try {
      await expect(
        realContext().cacheFs.pathExists(join(locked, 'meta.json')),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('still reports false for genuine absence, including a non-directory component', async () => {
    const { cacheFs } = realContext();
    await writeFile(join(dir, 'afile'), 'x');
    expect(await cacheFs.pathExists(join(dir, 'nope'))).toBe(false);
    // ENOTDIR: "afile" is not a directory, so the target is absent
    expect(await cacheFs.pathExists(join(dir, 'afile', 'under'))).toBe(false);
  });

  it('leaves no temp file behind when the write fails midway (D3)', async () => {
    // A read-only directory fails the rename; the temp must not survive it
    const target = join(dir, 'ro');
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, 'meta.json'), 'old');
    await chmod(target, 0o500);
    try {
      await expect(
        realContext().cacheFs.writeFileAtomic(join(target, 'meta.json'), 'new'),
      ).rejects.toThrowError();
    } finally {
      await chmod(target, 0o700);
    }
    const entries = await readdir(target);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('repairs the mode of a directory that already exists (D4)', async () => {
    // An entry created under a permissive umask by an earlier version must be
    // repaired, not inherited — mkdir's mode option does not apply to it
    const target = join(dir, 'ns');
    await mkdir(target, { mode: 0o755 });
    expect(await modeOf(target)).toBe('755');
    await realContext().cacheFs.mkdirSecure(target);
    expect(await modeOf(target)).toBe('700');
  });

  it('refuses to chmod a non-directory sitting at the namespace path (round-9 finding)', async () => {
    // `stat` succeeding does not mean it is a directory — a regular file at
    // the target path must be refused rather than silently made 0700
    // (executable), which would only defer the real failure to the first
    // write inside it.
    const target = join(dir, 'not-a-dir');
    await writeFile(target, 'x', { mode: 0o644 });
    await expect(realContext().cacheFs.mkdirSecure(target)).rejects.toMatchObject({
      code: 'validation',
    });
    expect(await modeOf(target)).toBe('644');
  });

  it('writes new files at 0600', async () => {
    const file = join(dir, 'meta.json');
    await realContext().cacheFs.writeFileAtomic(file, '{"a":1}');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}');
    expect(await modeOf(file)).toBe('600');
  });

  it('enforces 0600 when replacing a file that was created world-readable (D3)', async () => {
    // A plain writeFile with { mode } would leave this at 0644: the mode option
    // only applies at creation. The temp-file + rename path is what fixes it.
    const file = join(dir, 'meta.json');
    await writeFile(file, 'old', { mode: 0o644 });
    expect(await modeOf(file)).toBe('644');
    await realContext().cacheFs.writeFileAtomic(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(await modeOf(file)).toBe('600');
  });

  it('leaves no temp files behind after a successful write', async () => {
    await realContext().cacheFs.writeFileAtomic(join(dir, 'meta.json'), 'x');
    expect(await readdir(dir)).toEqual(['meta.json']);
  });

  it('reads a file at exactly the cap and rejects one byte over it', async () => {
    const { cacheFs } = realContext();
    const file = join(dir, 'meta.json');
    await cacheFs.writeFileAtomic(file, 'x'.repeat(100));
    expect(await cacheFs.readFileTextCapped(file, 100)).toHaveLength(100);
    await expect(cacheFs.readFileTextCapped(file, 99)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects a missing file rather than returning empty text', async () => {
    await expect(
      realContext().cacheFs.readFileTextCapped(join(dir, 'nope'), 100),
    ).rejects.toThrowError();
  });

  it('creates a lock file exclusively at 0600 and reports an existing one', async () => {
    const { cacheFs } = realContext();
    const lock = join(dir, '.lock');
    expect(await cacheFs.createExclusive(lock, 'one')).toBe(true);
    expect(await modeOf(lock)).toBe('600');
    // The second attempt must neither throw nor clobber the incumbent record
    expect(await cacheFs.createExclusive(lock, 'two')).toBe(false);
    expect(await readFile(lock, 'utf8')).toBe('one');
  });

  it('removes a file and tolerates removing a missing one', async () => {
    const { cacheFs } = realContext();
    const file = join(dir, 'gone');
    await cacheFs.writeFileAtomic(file, 'x');
    await cacheFs.removeFile(file);
    expect(await cacheFs.pathExists(file)).toBe(false);
    await expect(cacheFs.removeFile(file)).resolves.toBeUndefined();
  });

  it('reports existence for files and directories', async () => {
    const { cacheFs } = realContext();
    expect(await cacheFs.pathExists(join(dir, 'nope'))).toBe(false);
    await cacheFs.writeFileAtomic(join(dir, 'here'), 'x');
    expect(await cacheFs.pathExists(join(dir, 'here'))).toBe(true);
    expect(await cacheFs.pathExists(dir)).toBe(true);
  });

  it('removes a directory tree and tolerates a missing one', async () => {
    const { cacheFs } = realContext();
    await cacheFs.mkdirSecure(join(dir, 'ns', 'accepted'));
    await cacheFs.writeFileAtomic(join(dir, 'ns', 'accepted', 'spec.json'), '{}');
    await cacheFs.removeDir(join(dir, 'ns'));
    expect(await cacheFs.pathExists(join(dir, 'ns'))).toBe(false);
    await expect(cacheFs.removeDir(join(dir, 'ns'))).resolves.toBeUndefined();
  });

  it('lists directory entry names', async () => {
    const { cacheFs } = realContext();
    await cacheFs.mkdirSecure(join(dir, 'aaa'));
    await cacheFs.mkdirSecure(join(dir, 'bbb'));
    expect([...(await cacheFs.readDirNames(dir))].toSorted()).toEqual(['aaa', 'bbb']);
  });
});

describe('realContext cacheFs under a restrictive umask (D4)', () => {
  // The umask is PROCESS-WIDE state, so this cannot run inside the shared
  // vitest worker: setting it there would leak into every other test in the
  // file. It also cannot be skipped — this is the exact configuration in which
  // the round-1 implementation failed, and an in-process test cannot reach it.
  it('creates a usable 0700 tree where mkdir({recursive, mode}) fails with EACCES', async () => {
    const base = await mkdtemp(join(tmpdir(), 'openapi-mcp-umask-'));
    // Mkdtemp is subject to the umask too (probed: 0600 under 0177), so the
    // child repairs its own base before doing anything else
    const script = [
      'process.umask(0o177);',
      "const { chmod, mkdir, stat, writeFile } = await import('node:fs/promises');",
      "const { join } = await import('node:path');",
      // Node's `-e` eval mode does not insert a placeholder argv slot for the
      // evaluated script itself (unlike running an actual script file), so the
      // two extra args passed below land at argv[1] and argv[2] rather than
      // the argv[2]/argv[3] a script file would see. Probed directly against
      // this Node build before writing this comment.
      'const base = process.argv[1];',
      'await chmod(base, 0o700);',
      'const { realContext } = await import(process.argv[2]);',
      'const modeOf = async (p) => ((await stat(p)).mode & 0o7777).toString(8);',
      // First prove the naive form really is broken here, so this test fails
      // loudly if a future Node makes it work and the decision becomes stale
      "let naive = 'succeeded';",
      "try { await mkdir(join(base, 'naive', 'a', 'b'), { recursive: true, mode: 0o700 }); }",
      'catch (err) { naive = err.code; }',
      // Then prove mkdirSecure produces a usable tree under the same umask
      "const target = join(base, 'ns', 'objects');",
      'await realContext().cacheFs.mkdirSecure(target);',
      "await writeFile(join(target, 'probe.json'), '{}');",
      "console.log(JSON.stringify({ naive, leaf: await modeOf(target), parent: await modeOf(join(base, 'ns')) }));",
    ].join('\n');
    const contextUrl = new URL('../src/context.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, base, contextUrl],
      {
        encoding: 'utf8',
      },
    );
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim()) as {
      naive: string;
      leaf: string;
      parent: string;
    };
    // The defect this decision exists for: the recursive form cannot even
    // create the tree, so a leaf-only chmod never runs
    expect(result.naive).toBe('EACCES');
    // And the per-component form yields a usable, correctly permissioned tree
    expect(result.leaf).toBe('700');
    expect(result.parent).toBe('700');
    await rm(base, { recursive: true, force: true });
  });
});

describe('testContext cacheFs', () => {
  it('rejects every filesystem operation by default', async () => {
    const { cacheFs } = testContext();
    await expect(cacheFs.mkdirSecure('/x')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.writeFileAtomic('/x', 'y')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.readFileTextCapped('/x', 10)).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.readDirNames('/x')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.removeDir('/x')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.pathExists('/x')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.createExclusive('/x', 'y')).rejects.toThrow(/no cache filesystem/u);
    await expect(cacheFs.removeFile('/x')).rejects.toThrow(/no cache filesystem/u);
  });

  it('accepts an override', async () => {
    const { cacheFs } = testContext({
      cacheFs: { ...testContext().cacheFs, pathExists: () => Promise.resolve(true) },
    });
    expect(await cacheFs.pathExists('/x')).toBe(true);
  });
});

// Round-8 finding 4. This is deliberately NOT a test against the real
// filesystem: a local regular file fills the buffer in one read (probed), so
// such a test passes whether or not the loop exists. Driving a fake handle is
// the only way to make the short read actually happen.
describe('readExactly', () => {
  const handleYielding = (chunks: readonly string[]): FileHandle => {
    let call = 0;
    return {
      read: (buffer: Buffer, offset: number) => {
        const chunk = chunks[call] ?? '';
        call += 1;
        const bytesRead = Buffer.from(chunk, 'utf8').copy(buffer, offset);
        return Promise.resolve({ bytesRead, buffer });
      },
    } as unknown as FileHandle;
  };

  it('keeps reading until the buffer is full when reads come back short', async () => {
    const buffer = Buffer.alloc(9);
    const handle = handleYielding(['abc', 'def', 'ghi']);
    expect(await readExactly(handle, buffer)).toBe(9);
    expect(buffer.toString('utf8')).toBe('abcdefghi');
  });

  it('is satisfied by a single full read', async () => {
    const buffer = Buffer.alloc(4);
    expect(await readExactly(handleYielding(['abcd']), buffer)).toBe(4);
    expect(buffer.toString('utf8')).toBe('abcd');
  });

  it('stops at a zero-byte read, returning the prefix that was present', async () => {
    // The file shrank between stat and read; the honest answer is what is there
    const buffer = Buffer.alloc(9);
    expect(await readExactly(handleYielding(['abc', '']), buffer)).toBe(3);
  });
});

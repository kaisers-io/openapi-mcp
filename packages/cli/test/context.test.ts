import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readExactly, realContext, resolveErrWidth, testContext } from '../src/context.ts';

// The fail-closed error paths of the real cacheFs are reached two ways below:
// with REAL mode bits (chmod 0o000/0o500, a restrictive umask), and with an
// INJECTED fs failure. Real mode bits are the honest end-to-end check, but a
// process holding CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH — uid 0 in a Docker
// CI image or devcontainer — bypasses them, so those cases cannot assert
// EACCES there. The injected variants exercise the same branches on every
// uid, so the coverage survives a root run. `spy: true` keeps every export
// the real implementation, only wrapped in a spy, so each call reaches the
// real filesystem unless a test queues a failure.
vi.mock(import('node:fs/promises'), { spy: true });

// Whether THIS process is denied `op` by a directory's mode bits. Probed
// behaviourally rather than by `process.getuid() === 0`: what bypasses mode
// bits is a capability, not the uid (probed: uid 0 with CAP_DAC_OVERRIDE and
// CAP_DAC_READ_SEARCH dropped via setpriv still gets EACCES; conversely a
// non-root process holding them bypasses mode bits), and the two capabilities
// cover different operations, so each probe mirrors the exact operation its
// tests rely on.
const deniedByModeBits = async (
  dirMode: number,
  op: (dir: string) => Promise<unknown>,
): Promise<boolean> => {
  const probe = await mkdtemp(join(tmpdir(), 'openapi-mcp-modebits-'));
  try {
    await writeFile(join(probe, 'file'), '');
    await chmod(probe, dirMode);
    await op(probe);
    return false;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      return true;
    }
    throw error;
  } finally {
    await chmod(probe, 0o700);
    await rm(probe, { recursive: true, force: true });
  }
};
// Search through a 0o000 directory (bypassed by either capability)
const searchDenied = await deniedByModeBits(0o000, (dir) => stat(join(dir, 'file')));
// Create inside a 0o500 directory (bypassed only by CAP_DAC_OVERRIDE)
const writeDenied = await deniedByModeBits(0o500, (dir) => mkdir(join(dir, 'sub')));
// Appended to the name of a real-mode-bit test only when it is skipped, so a
// skip says why in the reporter output, not only in this file
const skipNote = (denied: boolean): string =>
  denied ? '' : ' [skipped: this process bypasses real mode bits, e.g. root]';

const injectedFsError = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected ${syscall} failure, '${path}'`), {
    code,
    syscall,
    path,
  });

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

  it('removes its abort listener once the lookup settles (no leak on a long-lived signal)', async () => {
    const ctx = realContext();
    const controller = new AbortController();
    for (let index = 0; index < 5; index += 1) {
      await ctx.transport.resolve('localhost', controller.signal);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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

describe('errWidth', () => {
  it('defaults to undefined (not a TTY) in testContext', () => {
    expect(testContext().errWidth()).toBeUndefined();
  });

  it('honours an override', () => {
    expect(testContext({ errWidth: () => 100 }).errWidth()).toBe(100);
  });

  it('resolveErrWidth maps TTY/columns to a usable width and non-TTY to undefined', () => {
    expect(resolveErrWidth(false, 120)).toBeUndefined(); // Not a TTY -> no wrap
    expect(resolveErrWidth(true, 120)).toBe(120); // A real column count is used
    expect(resolveErrWidth(true, 0)).toBe(80); // TTY, no columns -> fallback
    // oxlint-disable-next-line unicorn/no-useless-undefined -- resolveErrWidth's columns is a required (non-optional) parameter; dropping the argument changes call arity and fails to type-check (TS2554)
    expect(resolveErrWidth(true, undefined)).toBe(80); // TTY, columns unknown -> fallback
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

  it.skipIf(!searchDenied)(
    `propagates a non-absence stat failure from pathExists instead of reporting false${skipNote(searchDenied)}`,
    async () => {
      // An unreadable parent must never be reported as "nothing cached here":
      // a miss is the one outcome that may become trust-on-first-use. The
      // injected variants below cover this branch where this test is skipped.
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
    },
  );

  it('still reports false for genuine absence, including a non-directory component', async () => {
    const { cacheFs } = realContext();
    await writeFile(join(dir, 'afile'), 'x');
    expect(await cacheFs.pathExists(join(dir, 'nope'))).toBe(false);
    // ENOTDIR: "afile" is not a directory, so the target is absent
    expect(await cacheFs.pathExists(join(dir, 'afile', 'under'))).toBe(false);
  });

  it.skipIf(!writeDenied)(
    `leaves no temp file behind when the write fails midway${skipNote(writeDenied)}`,
    async () => {
      // A read-only directory refuses the exclusive temp create (open "wx"
      // needs write permission on the directory); nothing may survive it. The
      // injected variants below cover this and the later rename failure.
      const target = join(dir, 'ro');
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, 'meta.json'), 'old');
      await chmod(target, 0o500);
      try {
        await expect(
          realContext().cacheFs.writeFileAtomic(join(target, 'meta.json'), 'new'),
        ).rejects.toThrow();
      } finally {
        await chmod(target, 0o700);
      }
      const entries = await readdir(target);
      expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    },
  );

  it('repairs the mode of a directory that already exists', async () => {
    // An entry created under a permissive umask by an earlier version must be
    // repaired, not inherited — mkdir's mode option does not apply to it
    const target = join(dir, 'ns');
    await mkdir(target, { mode: 0o755 });
    expect(await modeOf(target)).toBe('755');
    await realContext().cacheFs.mkdirSecure(target);
    expect(await modeOf(target)).toBe('700');
  });

  it('refuses to chmod a non-directory sitting at the namespace path', async () => {
    // `stat` succeeding does not mean it is a directory — a regular file at
    // the target path must be refused rather than silently made 0700
    // (executable), which would only defer the real failure to the first
    // write inside it.
    const target = join(dir, 'not-a-dir');
    await writeFile(target, 'x', { mode: 0o644 });
    // This is the dedicated cache_path_type code (still exit 3, via
    // EXIT.VALIDATION) rather than plain 'validation', so the --all sweep
    // can discriminate the signal by code, not by matching substrings in an
    // attacker-influenceable path.
    await expect(realContext().cacheFs.mkdirSecure(target)).rejects.toMatchObject({
      code: 'cache_path_type',
    });
    expect(await modeOf(target)).toBe('644');
  });

  // `stat`/`chmod` FOLLOW symlinks, so a same-user attacker who can write
  // into the 0700 cache root could plant a 16-hex namespace symlink pointing
  // at an arbitrary directory: an `!info.isDirectory()` guard built on
  // `stat` would never catch it (a symlink to a directory reports
  // isDirectory() === true through `stat`), so `chmod` would follow the
  // symlink and 0700 the attacker-chosen target, and subsequent
  // writeFileAtomic/clearNamespace calls would read, write, and delete
  // inside it.
  //
  // Load-bearing / falsifiable: this must fail if the lstat guard in
  // mkdirSecure's `missing.length === 0` branch is reverted to `stat` — with
  // `stat`, the symlink resolves to the (real, existing) victim directory,
  // `isDirectory()` is true, the guard never fires, and the victim's mode
  // would be silently forced to 0700 instead of the call being rejected.
  it('rejects a symlink planted at the namespace path instead of following it', async () => {
    const victim = await mkdtemp(join(tmpdir(), 'openapi-mcp-victim-'));
    await chmod(victim, 0o750);
    const namespace = join(dir, 'a1b2c3d4e5f60718'); // A plausible 16-hex namespace name
    await symlink(victim, namespace, 'dir');
    try {
      // This is cache_path_type, not 'validation' — see the non-directory
      // case above for why this code is used.
      await expect(realContext().cacheFs.mkdirSecure(namespace)).rejects.toMatchObject({
        code: 'cache_path_type',
      });
      // The victim directory itself must be untouched: no mode change, no
      // write landed inside it via the symlink.
      expect(await modeOf(victim)).toBe('750');
      expect(await readdir(victim)).toEqual([]);
    } finally {
      await rm(victim, { recursive: true, force: true });
    }
  });

  it('writes new files at 0600', async () => {
    const file = join(dir, 'meta.json');
    await realContext().cacheFs.writeFileAtomic(file, '{"a":1}');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}');
    expect(await modeOf(file)).toBe('600');
  });

  it('enforces 0600 when replacing a file that was created world-readable', async () => {
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
    ).rejects.toThrow();
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

// Uid-independent twins of the real-mode-bit tests above: the failure is
// injected at the exact fs call, so these run (and fail closed) as root too.
// Everything except the one queued failure still hits the real filesystem.
describe('realContext cacheFs with an injected fs failure', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-cachefs-fault-'));
  });

  afterEach(async () => {
    // Drop any queued failure a failing test did not consume, so it cannot
    // leak into the next test; the pass-through implementation is kept
    vi.mocked(open).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(stat).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  // EACCES is the case real mode bits produce; EIO and ELOOP are the other
  // non-absence failures isAbsenceError's rationale names
  it.each(['EACCES', 'EIO', 'ELOOP'])(
    'pathExists propagates a stat failure with %s instead of reporting false',
    async (code) => {
      const file = join(dir, 'meta.json');
      await writeFile(file, '{}');
      const failure = injectedFsError(code, 'stat', file);
      vi.mocked(stat).mockRejectedValueOnce(failure);
      await expect(realContext().cacheFs.pathExists(file)).rejects.toBe(failure);
    },
  );

  it('leaves the target intact and no temp file behind when the temp create fails', async () => {
    // The failure the real read-only-directory test produces
    const file = join(dir, 'meta.json');
    await writeFile(file, 'old');
    const failure = injectedFsError('EACCES', 'open', file);
    vi.mocked(open).mockRejectedValueOnce(failure);
    await expect(realContext().cacheFs.writeFileAtomic(file, 'new')).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['meta.json']);
  });

  it('removes the already-written temp file when the final rename fails', async () => {
    // The temp exists and is fully written by the time rename runs, so this
    // is the case where the cleanup actually has something to remove
    const file = join(dir, 'meta.json');
    await writeFile(file, 'old');
    const failure = injectedFsError('EACCES', 'rename', file);
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(realContext().cacheFs.writeFileAtomic(file, 'new')).rejects.toBe(failure);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['meta.json']);
  });
});

describe('realContext cacheFs under a restrictive umask', () => {
  // The umask is PROCESS-WIDE state, so this cannot run inside the shared
  // vitest worker: setting it there would leak into every other test in the
  // file. It also cannot be skipped — this is the exact configuration where
  // the naive recursive-mkdir approach fails, and an in-process test cannot
  // reach it. Not even as root: the defect is the non-searchable 0600
  // intermediate component, which is created the same way on every uid. Only
  // its symptom — EACCES on the next component — depends on whether this
  // process bypasses mode bits, so that one expectation follows the probe.
  it('creates a usable 0700 tree where mkdir({recursive, mode}) leaves a 0600 parent', async () => {
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
      "const naiveParent = await modeOf(join(base, 'naive'));",
      // Then prove mkdirSecure produces a usable tree under the same umask
      "const target = join(base, 'ns', 'objects');",
      'await realContext().cacheFs.mkdirSecure(target);',
      "await writeFile(join(target, 'probe.json'), '{}');",
      "console.log(JSON.stringify({ naive, naiveParent, leaf: await modeOf(target), parent: await modeOf(join(base, 'ns')) }));",
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
      naiveParent: string;
      leaf: string;
      parent: string;
    };
    // The defect this decision exists for: the recursive form creates its
    // intermediate component 0600 — no search bit — on every uid...
    expect(result.naiveParent).toBe('600');
    // ...so wherever mode bits apply it cannot even create the tree, and a
    // leaf-only chmod never runs (as root it succeeds, but leaves a tree no
    // non-root owner could traverse). Gated on writeDenied, not searchDenied:
    // creating naive/a is a write to the 0600 naive/ that also needs its
    // missing search bit, and Linux lets CAP_DAC_READ_SEARCH skip a directory
    // check only when the access does not include write, so only
    // CAP_DAC_OVERRIDE lets it through (verified with
    // `setpriv --bounding-set -dac_override` as root: EACCES)
    expect(result.naive).toBe(writeDenied ? 'EACCES' : 'succeeded');
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

// This is deliberately NOT a test against the real filesystem: a local
// regular file fills the buffer in one read (probed), so such a test passes
// whether or not the loop exists. Driving a fake handle is the only way to
// make the short read actually happen.
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

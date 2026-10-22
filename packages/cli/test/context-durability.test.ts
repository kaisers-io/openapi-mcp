import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Crash durability cannot be observed from inside one process: a write that
// skipped fsync reads back perfectly until the machine loses power. What CAN be
// observed is the ORDER of the syscalls the adapter issues, which is exactly
// what crash consistency depends on (LWN "Ensuring data reaches disk": write
// temp, fsync temp, rename, fsync the directory). The real node:fs/promises
// primitives still run against a real temp directory, so these tests also
// prove the recorded sequence produces the expected files; the wrapper only
// records each call (and lets a test fail one on purpose).
type Step = { op: string; path: string };

const steps: Step[] = [];
// Lets a test make a recorded call fail: the first rule matching op + path wins
type FailureRule = { op: string; matches: (path: string) => boolean; error: Error };
const failures: FailureRule[] = [];

const record = (op: string, path: string): void => {
  steps.push({ op, path });
  const failure = failures.find((rule) => rule.op === op && rule.matches(path));
  if (failure !== undefined) {
    throw failure.error;
  }
};

const failSync = (matches: (path: string) => boolean, code: string): void => {
  failures.push({
    op: 'sync',
    matches,
    error: Object.assign(new Error(`${code}: simulated`), { code }),
  });
};

const recordingHandle = (handle: FileHandle, path: string): FileHandle =>
  new Proxy(handle, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      return (...args: unknown[]) => {
        record(property, path);
        return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  });

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [path] = args;
      record('open', String(path));
      return recordingHandle(await actual.open(...args), String(path));
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      record('rename', `${String(args[0])} -> ${String(args[1])}`);
      return actual.rename(...args);
    },
    link: (...args: Parameters<typeof actual.link>) => {
      record('link', `${String(args[0])} -> ${String(args[1])}`);
      return actual.link(...args);
    },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      record('mkdir', String(args[0]));
      return actual.mkdir(...args);
    },
  } as typeof actual;
});

// Import AFTER vi.mock so realContext binds the recording fs primitives
const { realContext } = await import('../src/context.ts');

// Projects the recorded steps onto the ones that matter for durability, with
// the random temp name replaced by a stable placeholder
const durabilityTrace = (target: string): readonly string[] => {
  const dir = dirname(target);
  const name = basename(target);
  const tmpPattern = new RegExp(`/\\.${name.replaceAll('.', '\\.')}\\.[0-9a-f-]{36}\\.tmp`, 'gu');
  return steps
    .filter((step) =>
      ['open', 'writeFile', 'sync', 'datasync', 'close', 'rename', 'link'].includes(step.op),
    )
    .map((step) => `${step.op} ${step.path.replaceAll(tmpPattern, '/TMP').replaceAll(dir, 'DIR')}`);
};

describe('realContext cacheFs durability ordering', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-durable-'));
    steps.length = 0;
    failures.length = 0;
  });

  afterEach(async () => {
    failures.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it('writeFileAtomic fsyncs the temp before rename and the directory after it', async () => {
    const target = join(dir, 'meta.json');
    await realContext().cacheFs.writeFileAtomic(target, '{"a":1}\n');
    expect(durabilityTrace(target)).toStrictEqual([
      'open DIR/TMP',
      'writeFile DIR/TMP',
      'sync DIR/TMP',
      'close DIR/TMP',
      'rename DIR/TMP -> DIR/meta.json',
      'open DIR',
      'sync DIR',
      'close DIR',
    ]);
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('createExclusive fsyncs the record before link and the directory after it', async () => {
    const lock = join(dir, '.lock');
    expect(await realContext().cacheFs.createExclusive(lock, 'record')).toBe(true);
    expect(durabilityTrace(lock)).toStrictEqual([
      'open DIR/TMP',
      'writeFile DIR/TMP',
      'sync DIR/TMP',
      'close DIR/TMP',
      'link DIR/TMP -> DIR/.lock',
      'open DIR',
      'sync DIR',
      'close DIR',
    ]);
    expect(await readFile(lock, 'utf8')).toBe('record');
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    'tolerates a filesystem that cannot fsync a directory (%s)',
    async (code) => {
      const target = join(dir, 'meta.json');
      failSync((path) => path === dir, code);
      await expect(realContext().cacheFs.writeFileAtomic(target, 'x')).resolves.toBeUndefined();
      expect(await readFile(target, 'utf8')).toBe('x');
    },
  );

  it('propagates a real directory fsync failure from writeFileAtomic', async () => {
    failSync((path) => path === dir, 'EIO');
    await expect(
      realContext().cacheFs.writeFileAtomic(join(dir, 'meta.json'), 'x'),
    ).rejects.toThrow(/EIO/u);
    // No temp is left behind and the directory handle was closed
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
    expect(steps.at(-1)).toStrictEqual({ op: 'close', path: dir });
  });

  it('fails the write, and never renames, when the file fsync fails', async () => {
    const target = join(dir, 'meta.json');
    // The temp name is random, so match it by suffix
    failSync((path) => path.endsWith('.tmp'), 'EIO');
    await expect(realContext().cacheFs.writeFileAtomic(target, 'x')).rejects.toThrow(/EIO/u);
    expect(steps.some((step) => step.op === 'rename')).toBe(false);
    expect(await readdir(dir)).toStrictEqual([]);
  });

  it('a directory fsync failure never turns a published lock into a failed acquisition', async () => {
    // Throwing after link() would orphan the lock we just published: the
    // caller has not entered its release `finally` yet
    failSync((path) => path === dir, 'EIO');
    const lock = join(dir, '.lock');
    expect(await realContext().cacheFs.createExclusive(lock, 'record')).toBe(true);
    expect(await readFile(lock, 'utf8')).toBe('record');
  });

  it('mkdirSecure fsyncs the parent of every directory it creates', async () => {
    const leaf = join(dir, 'a', 'b');
    await realContext().cacheFs.mkdirSecure(leaf);
    const synced = steps.filter((step) => step.op === 'sync').map((step) => step.path);
    expect(synced).toStrictEqual([dir, join(dir, 'a')]);
    // Each parent sync happens after the mkdir it makes durable
    const order = steps
      .filter((step) => step.op === 'mkdir' || step.op === 'sync')
      .map((step) => `${step.op} ${step.path}`);
    expect(order).toStrictEqual([
      `mkdir ${join(dir, 'a')}`,
      `mkdir ${leaf}`,
      `sync ${dir}`,
      `sync ${join(dir, 'a')}`,
    ]);
  });
});

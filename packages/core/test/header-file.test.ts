import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHeaderFileSource, createRedactor, readHeaderFile } from '../src/index.ts';

// --header-file (#125): a credential header read from a file, checked on
// each read and registered with the redactor before it is first sent.

const posix = process.platform !== 'win32';
const MAX = 64;
const TOKEN_1 = 'Bearer example-token-not-a-secret-1';
const TOKEN_2 = 'Bearer example-token-not-a-secret-2';

let dir: string;

// An owner-only file, as the docs ask for
const write = (name: string, content: string | Uint8Array): string => {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

// The reason a read is refused with
const reasonFor = async (path: string): Promise<string> => {
  try {
    await readHeaderFile(path, MAX);
    return 'read';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('readHeaderFile', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openapi-mcp-header-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the value without one trailing LF or CRLF', async () => {
    const valueOf = async (name: string, content: string): Promise<string> => {
      const read = await readHeaderFile(write(name, content), MAX);
      return read.value;
    };
    expect(await valueOf('lf', `${TOKEN_1}\n`)).toBe(TOKEN_1);
    expect(await valueOf('crlf', `${TOKEN_1}\r\n`)).toBe(TOKEN_1);
    expect(await valueOf('none', TOKEN_1)).toBe(TOKEN_1);
    expect(await valueOf('latin1', 'Bearer café')).toBe('Bearer café');
  });

  it.each([
    ['empty', '', 'is empty'],
    ['only a line break', '\n', 'is empty'],
    ['two line breaks', `${TOKEN_1}\n\n`, 'contains control characters'],
    ['a tab', 'Bearer a\tb', 'contains control characters'],
    ['a header injection', `${TOKEN_1}\r\nX-Evil: 1`, 'contains control characters'],
    ['a character above U+00FF', 'Bearer €', 'contains a character above U+00FF'],
    ['a value over the budget', `Bearer ${'a'.repeat(MAX)}`, 'is over the 64-character'],
  ])('refuses a value that is %s', async (_label, content, reason) => {
    expect(await reasonFor(write('value', content))).toContain(reason);
  });

  it('refuses bytes that are not UTF-8, and a file far over the budget', async () => {
    const bytes = write('bytes', Uint8Array.from([0x42, 0xff, 0x42]));
    expect(await reasonFor(bytes)).toBe('is not valid UTF-8');
    const large = write('large', 'a'.repeat(1000));
    expect(await reasonFor(large)).toContain('is over the');
  });

  it('refuses a missing file and a directory', async () => {
    expect(await reasonFor(join(dir, 'missing'))).toBe('is missing');
    mkdirSync(join(dir, 'folder'));
    expect(await reasonFor(join(dir, 'folder'))).toBe('is not a regular file');
  });

  it.skipIf(!posix)('refuses a symbolic link, a hard link and a file others can read', async () => {
    const target = write('target', TOKEN_1);
    symlinkSync(target, join(dir, 'link'));
    expect(await reasonFor(join(dir, 'link'))).toBe('is a symbolic link');
    linkSync(target, join(dir, 'hard'));
    expect(await reasonFor(target)).toBe('has more than one link');
    const open = write('open', TOKEN_1);
    chmodSync(open, 0o640);
    expect(await reasonFor(open)).toContain('can be read or written by other users');
  });
});

// A redactor that records what is registered and retired
const recordingRedactor = () => {
  const redactor = createRedactor([]);
  const registered: string[] = [];
  const retired: string[] = [];
  return {
    redactor: {
      ...redactor,
      registerRuntimeSecret: (...args: Parameters<typeof redactor.registerRuntimeSecret>) => {
        registered.push(args[0]);
        redactor.registerRuntimeSecret(...args);
      },
      retireRuntimeSecret: (...args: Parameters<typeof redactor.retireRuntimeSecret>) => {
        retired.push(args[0]);
        redactor.retireRuntimeSecret(...args);
      },
    },
    registered,
    retired,
  };
};

const sourceFor = (path: string, recorder = recordingRedactor()) => ({
  recorder,
  source: createHeaderFileSource({
    name: 'Authorization',
    path,
    maxLength: MAX,
    redactor: recorder.redactor,
    now: () => 0,
  }),
});

describe('createHeaderFileSource', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openapi-mcp-header-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts without the file, names the path, and uses the file once it is there', async () => {
    const path = join(dir, 'api.token');
    const { source } = sourceFor(path);
    expect(await source.read()).toStrictEqual({
      error: `the header file ${JSON.stringify(path)} is missing`,
    });
    write('api.token', TOKEN_1);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
  });

  it('reads a renamed or rewritten file again, registers the new value and retires the old', async () => {
    const path = write('api.token', TOKEN_1);
    const { source, recorder } = sourceFor(path);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
    // A temp file renamed into place
    renameSync(write('api.token.tmp', TOKEN_2), path);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_2 });
    // Written in place
    writeFileSync(path, `${TOKEN_1}\n`);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
    expect(recorder.registered).toStrictEqual([TOKEN_1, TOKEN_2, TOKEN_1]);
    expect(recorder.retired).toStrictEqual([TOKEN_1, TOKEN_2]);
    // A replaced value stays redacted
    expect(recorder.redactor.redactString(`echo ${TOKEN_2}`)).not.toContain(TOKEN_2);
  });

  it('keeps the value of an unchanged file, and reads it again after a 401 for it', async () => {
    const path = write('api.token', TOKEN_1);
    const { source, recorder } = sourceFor(path);
    await source.read();
    await source.read();
    expect(recorder.registered).toStrictEqual([TOKEN_1]);
    // A late 401 for an older value leaves the current one alone
    source.stale('Bearer an-older-value');
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
    // Same metadata, new content: only a 401 makes it read again
    source.stale(TOKEN_1);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
  });

  it('fails closed on a bad file instead of falling back to the last good value', async () => {
    const path = write('api.token', TOKEN_1);
    const { source } = sourceFor(path);
    expect(await source.read()).toStrictEqual({ ok: TOKEN_1 });
    writeFileSync(path, '');
    expect(await source.read()).toStrictEqual({
      error: `the header file ${JSON.stringify(path)} is empty`,
    });
    rmSync(path);
    expect(await source.read()).toStrictEqual({
      error: `the header file ${JSON.stringify(path)} is missing`,
    });
  });

  it('shares one read between concurrent calls', async () => {
    const path = write('api.token', TOKEN_1);
    const { source, recorder } = sourceFor(path);
    const results = await Promise.all([source.read(), source.read(), source.read()]);
    expect(results).toStrictEqual([{ ok: TOKEN_1 }, { ok: TOKEN_1 }, { ok: TOKEN_1 }]);
    expect(recorder.registered).toStrictEqual([TOKEN_1]);
  });

  it('never sends a value the redactor cannot register', async () => {
    // A substring of the redaction marker cannot be redacted safely
    const path = write('api.token', 'red');
    const { source } = sourceFor(path);
    expect(await source.read()).toStrictEqual({
      error: `the header file ${JSON.stringify(path)} could not be registered for redaction`,
    });
  });

  it('escapes control characters of the path in its messages', async () => {
    const { source } = sourceFor(join(dir, 'a\nb'));
    const result = await source.read();
    expect('error' in result && result.error).toContain(String.raw`a\nb`);
  });
});

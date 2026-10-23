import { describe, expect, it } from 'vitest';
import { OpenapiMcpError, hashContent, loadSpecFromFile, parseSpecSource } from '../src/index.ts';

// The POSIX path grammar is pinned explicitly, so these cases mean the same on every runner;
// the Windows grammar has its own block below
const cwd = { cwd: '/work/project', platform: 'linux' } as const;

describe('parseSpecSource', () => {
  it('classifies an https URL', () => {
    const source = parseSpecSource('https://api.example.com/openapi.json?tenant=a', cwd);
    expect(source.kind).toBe('url');
    if (source.kind === 'url') {
      expect(source.url.href).toBe('https://api.example.com/openapi.json?tenant=a');
    }
  });

  it('classifies an http URL', () => {
    expect(parseSpecSource('http://localhost:8080/spec.yaml', cwd).kind).toBe('url');
  });

  it.each(['ftp://example.com/spec.json', 'file:///etc/spec.json', 'ssh://host/x'])(
    'rejects the non-http(s) scheme in %s',
    (raw) => {
      expect(() => parseSpecSource(raw, cwd)).toThrow(/only http: and https:/u);
    },
  );

  it('rejects URLs with userinfo credentials', () => {
    try {
      parseSpecSource('https://user:pass@example.com/spec.json', cwd);
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('usage');
      expect((error as OpenapiMcpError).message).toContain('--spec-header-env');
      expect((error as OpenapiMcpError).message).not.toContain('pass');
    }
  });

  it('rejects a syntactically invalid URL with a scheme', () => {
    expect(() => parseSpecSource('https://', cwd)).toThrow(OpenapiMcpError);
  });

  it('rejects an empty source', () => {
    expect(() => parseSpecSource('', cwd)).toThrow(OpenapiMcpError);
  });

  it.each(['file:/etc/spec.json', 'data:text/plain,x', 'mailto:x@example.com'])(
    'rejects scheme-prefixed non-http(s) input %s (no :// required)',
    (raw) => {
      expect(() => parseSpecSource(raw, cwd)).toThrow(/only http: and https:/u);
    },
  );

  it('treats a relative path containing a colon as a scheme and hints at the ./ escape', () => {
    expect(() => parseSpecSource('specs:v1.json', cwd)).toThrow(/\.\//u);
  });

  it.each(['api_key', 'token', 'ACCESS_TOKEN', 'x-auth', 'signature'])(
    'rejects credential-bearing query parameter %s without echoing the value',
    (name) => {
      try {
        parseSpecSource(`https://api.example.com/spec.json?${name}=hunter2`, cwd);
        expect.unreachable('expected a usage error');
      } catch (error) {
        expect((error as OpenapiMcpError).code).toBe('usage');
        expect((error as OpenapiMcpError).message).toContain(name);
        expect((error as OpenapiMcpError).message).not.toContain('hunter2');
      }
    },
  );

  it('allows benign query parameters', () => {
    expect(parseSpecSource('https://api.example.com/spec.json?version=2', cwd).kind).toBe('url');
  });

  it('resolves a relative file path against cwd', () => {
    expect(parseSpecSource('specs/petstore.yaml', cwd)).toEqual({
      kind: 'file',
      path: '/work/project/specs/petstore.yaml',
    });
  });

  it('keeps an absolute file path and normalizes dot segments', () => {
    expect(parseSpecSource('/tmp/spec.json', cwd)).toEqual({
      kind: 'file',
      path: '/tmp/spec.json',
    });
    expect(parseSpecSource('/tmp/a/../spec.json', cwd)).toEqual({
      kind: 'file',
      path: '/tmp/spec.json',
    });
  });

  it('keeps a drive-letter path a URL scheme outside Windows (unchanged POSIX behaviour)', () => {
    expect(() => parseSpecSource('C:/specs/api.json', cwd)).toThrow(/scheme "c:"/u);
  });
});

describe('parseSpecSource on Windows', () => {
  const win = { cwd: 'D:\\work\\project', platform: 'win32' } as const;

  it.each([
    ['C:\\specs\\api.json', 'C:\\specs\\api.json'],
    ['c:\\specs\\api.json', 'c:\\specs\\api.json'],
    ['C:/specs/api.json', 'C:\\specs\\api.json'],
    ['D:\\work\\a\\..\\api.json', 'D:\\work\\api.json'],
  ])('treats the drive-letter path %s as a file, not as a URL scheme', (raw, path) => {
    expect(parseSpecSource(raw, win)).toEqual({ kind: 'file', path });
  });

  it('treats a UNC path as a file', () => {
    expect(parseSpecSource('\\\\server\\share\\api.json', win)).toEqual({
      kind: 'file',
      path: '\\\\server\\share\\api.json',
    });
  });

  it('resolves a relative path against a drive-letter cwd with backslashes', () => {
    expect(parseSpecSource('specs/api.json', win)).toEqual({
      kind: 'file',
      path: 'D:\\work\\project\\specs\\api.json',
    });
  });

  it('still refuses a drive-relative path and every real scheme', () => {
    // "C:api.json" is relative to drive C's own current directory, a per-process state this
    // tool does not resolve; it stays a scheme error that hints at the "./" escape
    expect(() => parseSpecSource('C:api.json', win)).toThrow(/\.\//u);
    for (const raw of ['file:///C:/specs/api.json', 'ftp://example.com/x', 'mailto:x@example.com']) {
      expect(() => parseSpecSource(raw, win)).toThrow(/only http: and https:/u);
    }
    expect(parseSpecSource('https://api.example.com/spec.json', win).kind).toBe('url');
  });
});

describe('hashContent', () => {
  it('computes the sha256 hex digest', () => {
    expect(hashContent('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('loadSpecFromFile', () => {
  const deps = (text: string, size?: number) => ({
    readFileText: () => Promise.resolve(text),
    fileSizeBytes: () => Promise.resolve(size ?? Buffer.byteLength(text, 'utf8')),
  });

  it('loads text, hash, and display source', async () => {
    const loaded = await loadSpecFromFile('/tmp/spec.json', 1024, deps('{"a":1}'));
    expect(loaded).toEqual({
      text: '{"a":1}',
      contentHash: hashContent('{"a":1}'),
      displaySource: '/tmp/spec.json',
    });
  });

  it('rejects files over the size budget before reading them', async () => {
    let readCalled = false;
    const overBudget = {
      readFileText: () => {
        readCalled = true;
        return Promise.resolve('x');
      },
      fileSizeBytes: () => Promise.resolve(2048),
    };
    await expect(loadSpecFromFile('/tmp/big.json', 1024, overBudget)).rejects.toMatchObject({
      code: 'validation',
    });
    expect(readCalled).toBe(false);
  });

  it('maps a missing file to a not_found error naming the path', async () => {
    const missing = {
      readFileText: () => Promise.reject(new Error('ENOENT')),
      fileSizeBytes: () => Promise.reject(new Error('ENOENT: no such file')),
    };
    await expect(loadSpecFromFile('/tmp/missing.json', 1024, missing)).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('/tmp/missing.json') as string,
    });
  });

  it('maps a read failure after a successful stat to not_found', async () => {
    const readFails = {
      readFileText: () => Promise.reject(new Error('EACCES: permission denied')),
      fileSizeBytes: () => Promise.resolve(10),
    };
    await expect(loadSpecFromFile('/tmp/locked.json', 1024, readFails)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('re-checks the byte budget after reading (stat/read TOCTOU)', async () => {
    const grewBetweenStatAndRead = {
      readFileText: () => Promise.resolve('x'.repeat(2048)),
      fileSizeBytes: () => Promise.resolve(10),
    };
    await expect(
      loadSpecFromFile('/tmp/grew.json', 1024, grewBetweenStatAndRead),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

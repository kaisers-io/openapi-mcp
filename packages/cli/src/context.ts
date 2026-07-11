import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  errLine: (line: string) => void;
  fetcher: typeof fetch;
  now: () => number;
  nodeVersion: string;
  homeDir: () => string | undefined;
  pathExists: (path: string) => boolean;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
  cwd: () => string;
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
}

export const realContext = (): CliContext => ({
  env: process.env,
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  errLine: (line) => {
    process.stderr.write(`${line}\n`);
  },
  fetcher: fetch,
  now: () => Date.now(),
  nodeVersion: process.versions.node,
  homeDir: () => homedir(),
  pathExists: (path) => existsSync(path),
  readFileText: (path) => readFile(path, 'utf8'),
  fileSizeBytes: async (path) => {
    const stats = await stat(path);
    return stats.size;
  },
  cwd: () => process.cwd(),
  lookup: async (hostname, signal) => {
    signal.throwIfAborted();
    const pending = dnsLookup(hostname, { all: true });
    pending.catch(() => {
      // Consume a late rejection if the race below is lost to the deadline
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new Error('DNS lookup aborted by the fetch deadline'));
        },
        { once: true },
      );
    });
    aborted.catch(() => {
      // Consume the deadline rejection if the lookup won the race
    });
    const entries = await Promise.race([pending, aborted]);
    return entries.map((entry) => entry.address);
  },
});

export interface TestContextOverrides extends Partial<CliContext> {
  lines?: string[];
  errLines?: string[];
}

export const testContext = (overrides: TestContextOverrides = {}): CliContext => {
  const { lines = [], errLines = [], ...rest } = overrides;
  return {
    env: {},
    out: (line) => {
      lines.push(line);
    },
    errLine: (line) => {
      errLines.push(line);
    },
    fetcher: () => Promise.reject(new Error('no fetcher configured in testContext')),
    now: () => 0,
    nodeVersion: '24.12.0',
    homeDir: () => undefined,
    pathExists: () => false,
    readFileText: () => Promise.reject(new Error('no file access configured in testContext')),
    fileSizeBytes: () => Promise.reject(new Error('no file access configured in testContext')),
    cwd: () => '/test-cwd',
    lookup: () => Promise.reject(new Error('no dns lookup configured in testContext')),
    ...rest,
  };
};

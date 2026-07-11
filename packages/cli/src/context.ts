import { existsSync } from 'node:fs';
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
    ...rest,
  };
};

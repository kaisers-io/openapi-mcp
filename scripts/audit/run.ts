// Audits every package in pnpm-lock.yaml for known advisories at high or critical, and checks
// that the audit covered the whole lockfile (why, and the exit codes: lockfile.ts).
//
//   node scripts/audit/run.ts     from the workspace root, after `pnpm install`
//
// Runs in .github/workflows/audit.yml. What to do when it fails: CONTRIBUTING.md, "Dependency
// audit".
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { EXIT_INCOMPLETE, evaluate } from './lockfile.ts';
import type { AuditRun } from './lockfile.ts';

// Streamed, not buffered with a size cap: a report with many advisories runs to megabytes of JSON,
// past what spawnSync and execFile buffer by default, and a truncated report would read as an
// incomplete audit.
const collect = async (stream: Readable): Promise<string> => {
  let text = '';
  for await (const chunk of stream.setEncoding('utf8')) {
    text += String(chunk);
  }
  return text;
};

const runAudit = async (): Promise<AuditRun> => {
  const child = spawn('pnpm', ['audit', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [stdout, stderr, [status]] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    once(child, 'close') as Promise<[number | null]>,
  ]);
  return { status, stdout, stderr };
};

try {
  const outcome = evaluate(await readFile('pnpm-lock.yaml', 'utf8'), await runAudit());
  for (const line of outcome.log) {
    console.log(line);
  }
  for (const line of outcome.errors) {
    console.error(line);
  }
  process.exitCode = outcome.exitCode;
} catch (error) {
  // No pnpm on PATH, or no lockfile: the audit did not run, which is not a clean result.
  console.error(
    `::error::pnpm audit did not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = EXIT_INCOMPLETE;
}

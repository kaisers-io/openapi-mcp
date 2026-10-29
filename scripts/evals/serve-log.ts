// Starts `openapi-mcp serve` for an agent and writes the server's stderr, with
// its `--log json` call records, to a file. The harness reads that file after
// a run to see which API requests the server really sent, including the calls
// inside an execute_code program, which the agent's own log does not show.
//
//   node serve-log.ts <log file> <openapi-mcp bin> serve <serve arguments...>

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const [file, ...command] = process.argv.slice(2);
const log = createWriteStream(file!, { flags: 'a' });
const child = spawn(process.execPath, [...command, '--log', 'json'], {
  stdio: ['inherit', 'inherit', 'pipe'],
});
child.stderr.pipe(log);
child.on('exit', (code, signal) => {
  log.end(() => {
    process.exitCode = code ?? (signal === null ? 0 : 1);
  });
});
for (const name of ['SIGINT', 'SIGTERM'] as const) {
  process.on(name, () => {
    child.kill(name);
  });
}

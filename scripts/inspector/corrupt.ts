// Negative control for run.ts: starts `openapi-mcp` and passes its stdio through, but gives the
// first operation tool in every tools/list result an input schema no client accepts. run.ts
// requires the fixture check to FAIL through this wrapper, so a client that silently drops the
// broken tool and keeps the rest cannot pass as a clean list.
//
//   node corrupt.ts <openapi-mcp bin> <serve arguments...>

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface Message {
  result?: { tools?: { name: string; inputSchema?: unknown }[] };
}

const corrupt = (line: string): string => {
  try {
    const message = JSON.parse(line) as Message;
    const tool = message.result?.tools?.find((each) => each.name !== 'openapi_mcp_status');
    if (tool === undefined) {
      return line;
    }
    tool.inputSchema = { type: 'string' };
    return JSON.stringify(message);
  } catch {
    return line;
  }
};

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ['inherit', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  process.stdout.write(`${corrupt(line)}\n`);
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

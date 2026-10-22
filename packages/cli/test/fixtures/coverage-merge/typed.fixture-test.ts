// The inner suite coverage-subprocess.test.ts runs under the custom provider:
// it calls typed.ts in the worker and spawns a Node child that calls it too
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { double, sum } from './typed.ts';

it('runs typed.ts in the worker and in a child', async () => {
  expect(sum({ left: 2, right: 3 })).toBe(5);
  expect(double(4)).toBe(8);
  const child = spawn(process.execPath, [fileURLToPath(new URL('child.ts', import.meta.url))]);
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  // 'close', not 'exit': it fires after stdout has been read to the end
  const [code] = await once(child, 'close');
  expect(code).toBe(0);
  expect(stdout).toBe('3 OK!\n');
});

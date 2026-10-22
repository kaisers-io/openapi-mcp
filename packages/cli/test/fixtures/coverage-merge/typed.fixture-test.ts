// The inner suite coverage-subprocess.test.ts runs under the custom provider:
// it calls typed.ts in the worker and spawns a Node child that calls it too
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { double, sum } from './typed.ts';

it('runs typed.ts in the worker and in a child', async () => {
  expect(sum({ left: 2, right: 3 })).toBe(5);
  expect(double(4)).toBe(8);
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('child.ts', import.meta.url)),
  ]);
  expect(stdout).toBe('3 OK!\n');
});

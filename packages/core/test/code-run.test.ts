import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RUNNING_SCRIPTS,
  runScript,
  SCRIPT_LIMITS,
  workerFailure,
} from '../src/server/code/run.ts';
import type { NestedCall } from '../src/server/code/run.ts';

// The execute_code sandbox (issue #60): a script runs in QuickJS inside a
// worker, reaches nothing but api.call and console.log, and every limit
// ends it with a readable error.

const LIMITS = { ...SCRIPT_LIMITS, ms: 2000 };
const noSignal = new AbortController().signal;

const echo: NestedCall = (name, args) =>
  Promise.resolve({ ok: true, value: { status: 200, data: { name, args } } });

const run = (code: string, call: NestedCall = echo, limits = LIMITS) =>
  runScript(code, call, noSignal, limits);

describe('runScript — results', () => {
  it('returns the JSON result, the logs and every call with its status', async () => {
    const report = await run(`
      const thing = await api.call('getThing', { id: 'a' });
      console.log('got', thing.data, 1);
      return thing.data.args.id;
    `);
    expect(report).toStrictEqual({
      ok: true,
      result: 'a',
      logs: ['got {"name":"getThing","args":{"id":"a"}} 1'],
      calls: [{ name: 'getThing', status: 'ok' }],
    });
  });

  it('gives null for a script that returns nothing', async () => {
    expect(await run('await api.call("x");')).toMatchObject({ ok: true, result: null });
  });

  it('rejects api.call with the error text of a failed call', async () => {
    const failing: NestedCall = () => Promise.resolve({ ok: false, error: 'upstream said 404' });
    const report = await run(
      `try { await api.call('getThing', {}); } catch (error) { return error.message; }`,
      failing,
    );
    expect(report).toStrictEqual({
      ok: true,
      result: 'upstream said 404',
      calls: [{ name: 'getThing', status: 'error' }],
    });
  });

  it('passes arguments as JSON data, so nothing but data reaches the host', async () => {
    const seen: unknown[] = [];
    const record: NestedCall = (_name, args) => {
      seen.push(args);
      return Promise.resolve({ ok: true, value: {} });
    };
    await run(
      `await api.call('x', { id: 1, when: new Date(0), skip: undefined, fn() {}, ['__proto__']: { polluted: true } });`,
      record,
    );
    expect(seen).toStrictEqual([
      JSON.parse('{"id":1,"when":"1970-01-01T00:00:00.000Z","__proto__":{"polluted":true}}'),
    ]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reports a syntax error, a thrown error and values JSON cannot hold', async () => {
    expect(await run('return )')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^SyntaxError/u),
    });
    expect(await run('throw new RangeError("nope")')).toMatchObject({
      ok: false,
      error: 'RangeError: nope',
    });
    expect(await run('const a = {}; a.a = a; return a;')).toMatchObject({
      ok: false,
      error: 'TypeError: circular reference',
    });
    expect(await run('return 1n')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/BigInt/u),
    });
  });
});

describe('runScript — the sandbox has no ambient authority', () => {
  it('offers no Node, network, timer, host or module access', async () => {
    const report = await run(`return {
      require: typeof require, process: typeof process, fetch: typeof fetch,
      setTimeout: typeof setTimeout, setInterval: typeof setInterval,
      host: typeof __host, std: typeof std, os: typeof os, Buffer: typeof Buffer,
      WebAssembly: typeof WebAssembly, globals: Object.getOwnPropertyNames(globalThis).filter((name) => /^[a-z_]/u.test(name)),
    };`);
    expect(report.result).toStrictEqual({
      require: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
      setTimeout: 'undefined',
      setInterval: 'undefined',
      host: 'undefined',
      std: 'undefined',
      os: 'undefined',
      Buffer: 'undefined',
      WebAssembly: 'undefined',
      globals: expect.arrayContaining(['api', 'console']),
    });
    // Beyond the standard ECMAScript globals, only api and console
    const standard = new Set([
      'globalThis',
      'undefined',
      'eval',
      'isFinite',
      'isNaN',
      'parseFloat',
      'parseInt',
      'decodeURI',
      'decodeURIComponent',
      'encodeURI',
      'encodeURIComponent',
      'escape',
      'unescape',
    ]);
    expect(
      (report.result as { globals: string[] }).globals
        .filter((name) => !standard.has(name))
        .toSorted(),
    ).toStrictEqual(['api', 'console']);
  });

  it('cannot import a module', async () => {
    expect(await run('return await import("os")')).toMatchObject({ ok: false });
    expect(await run('return await import("node:fs")')).toMatchObject({ ok: false });
  });

  it('cannot reach the host functions behind api and console', async () => {
    const report = await run(
      'return [Object.isFrozen(api), Object.keys(api), typeof host, typeof stringify];',
    );
    expect(report.result).toStrictEqual([true, ['call'], 'undefined', 'undefined']);
  });
});

describe('runScript — limits', () => {
  it('refuses calls past the budget without sending them', async () => {
    let sent = 0;
    const counting: NestedCall = () => {
      sent += 1;
      return Promise.resolve({ ok: true, value: {} });
    };
    const report = await run(
      'for (let i = 0; i < 60; i++) { await api.call("x"); } return 1;',
      counting,
      { ...LIMITS, calls: 5 },
    );
    expect(sent).toBe(5);
    expect(report).toMatchObject({
      ok: false,
      error: 'Error: call limit reached: at most 5 api.call() per script',
    });
    expect(report.calls).toHaveLength(5);
  });

  it('keeps at most the configured number of calls in flight', async () => {
    let active = 0;
    let peak = 0;
    const slow: NestedCall = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return { ok: true, value: {} };
    };
    const report = await run(
      'return (await Promise.all(Array.from({ length: 12 }, (_, i) => api.call("op" + i)))).length;',
      slow,
    );
    expect(report.result).toBe(12);
    expect(peak).toBe(SCRIPT_LIMITS.concurrentCalls);
  });

  it('ends a busy loop, also one after an await, at the time limit', async () => {
    const short = { ...LIMITS, ms: 300 };
    for (const code of [
      'for (;;) {}',
      'await api.call("x"); for (;;) {}',
      'await new Promise(() => {});',
    ]) {
      const started = performance.now();
      expect(await run(code, echo, short)).toMatchObject({
        ok: false,
        error: 'time limit reached: the script ran longer than 0.3 s',
      });
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  it('ends a getter that loops while arguments are converted', async () => {
    expect(
      await run('await api.call("x", { get a() { for (;;) {} } });', echo, { ...LIMITS, ms: 300 }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^time limit reached/u) });
  });

  it('cancels calls still in flight or waiting when the time is up', async () => {
    const signals: AbortSignal[] = [];
    const hanging: NestedCall = (_name, _args, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    const report = await run(
      'await Promise.all(Array.from({ length: 6 }, () => api.call("x")));',
      hanging,
      { ...LIMITS, ms: 300 },
    );
    expect(report.calls.map((entry) => entry.status)).toStrictEqual(
      Array.from({ length: 6 }, () => 'cancelled'),
    );
    expect(signals).toHaveLength(SCRIPT_LIMITS.concurrentCalls);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('stops the script when the tool call is cancelled', async () => {
    const controller = new AbortController();
    const pending = runScript('for (;;) {}', echo, controller.signal, LIMITS);
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
    const aborted = AbortSignal.abort();
    expect(await runScript('return 1', echo, aborted, LIMITS)).toStrictEqual({
      ok: false,
      error: 'cancelled',
      calls: [],
    });
  });

  it('turns a memory hog into an error and stays within the memory ceiling', async () => {
    const before = process.memoryUsage().rss;
    for (const code of [
      'const a = []; for (;;) a.push(new Array(1e5).fill(1));',
      'const a = []; for (;;) a.push(new Uint8Array(1e7));',
      'let s = "x"; for (;;) s += s;',
      'const a = []; for (;;) a.push({ n: Math.random(), list: [1, 2, 3] });',
    ]) {
      expect(await run(code)).toMatchObject({ ok: false });
    }
    // The QuickJS heap limit alone let the process grow by more than a
    // gigabyte; the WebAssembly memory's maximum is the ceiling
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
  });

  it('refuses oversized arguments, an oversized result and too much received data', async () => {
    expect(await run('await api.call("x", { a: "y".repeat(200000) });')).toMatchObject({
      ok: false,
      error: `Error: arguments too large: at most ${String(SCRIPT_LIMITS.argsBytes)} bytes of JSON per api.call()`,
      calls: [],
    });
    expect(await run('return "x".repeat(60000);')).toMatchObject({
      ok: false,
      error: 'result too large (60002 bytes, at most 50000): return only the fields you need',
    });
    const big: NestedCall = () => Promise.resolve({ ok: true, value: 'z'.repeat(600) });
    const report = await run(
      'for (let i = 0; i < 3; i++) { await api.call("x"); } return 1;',
      big,
      { ...LIMITS, receivedBytes: 1000 },
    );
    expect(report).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Error: results too large/u),
    });
    expect(report.calls.map((entry) => entry.status)).toStrictEqual(['ok', 'error']);
  });

  it('caps the logs, empty lines included', async () => {
    const report = await run('for (let i = 0; i < 100000; i++) console.log(""); return 1;');
    expect(report.ok).toBe(true);
    expect(report.logs).toHaveLength(SCRIPT_LIMITS.logBytes);
    expect(report.logsTruncated).toBe(true);
  });

  it(`runs at most ${String(MAX_RUNNING_SCRIPTS)} scripts at once`, async () => {
    const reports = await Promise.all(
      Array.from({ length: MAX_RUNNING_SCRIPTS + 2 }, () => run('return 1')),
    );
    expect(reports.filter((report) => report.ok)).toHaveLength(MAX_RUNNING_SCRIPTS);
    expect(reports.find((report) => !report.ok)?.error).toBe(
      `${String(MAX_RUNNING_SCRIPTS)} scripts are already running; try again when one has finished`,
    );
    // The slots are free again afterwards
    expect(await run('return 2')).toMatchObject({ ok: true, result: 2 });
  });
});

describe('runScript — failures on the host side', () => {
  it('reports a call that throws as a failed call, not as a crash', async () => {
    const throwing: NestedCall = () => Promise.reject(new Error('dispatcher bug'));
    const report = await run(
      `try { await api.call('x'); } catch (error) { return error.message; }`,
      throwing,
    );
    expect(report).toStrictEqual({
      ok: true,
      result: 'the call failed unexpectedly',
      calls: [{ name: 'x', status: 'error' }],
    });
  });

  it('ignores a call that settles after the script ended, and records it as cancelled', async () => {
    let settled = false;
    const late: NestedCall = async () => {
      await sleep(100);
      settled = true;
      return { ok: true, value: {} };
    };
    const report = await run(`api.call('slow'); return 'done';`, late);
    expect(report).toStrictEqual({
      ok: true,
      result: 'done',
      calls: [{ name: 'slow', status: 'cancelled' }],
    });
    await sleep(200);
    expect(settled).toBe(true);
    expect(report.calls).toStrictEqual([{ name: 'slow', status: 'cancelled' }]);
  });

  it('ends the script when its worker fails', async () => {
    expect(await run('return 1', echo, { ...LIMITS, stackBytes: -1 })).toStrictEqual({
      ok: false,
      error: 'the script failed unexpectedly',
      calls: [],
    });
  });

  it('names a memory failure of the worker or the engine', () => {
    const memory = 'memory limit reached: the script used too much memory';
    const workerHeap = Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });
    expect(workerFailure(workerHeap)).toBe(memory);
    expect(workerFailure(new Error('Aborted(OOM)'))).toBe(memory);
    expect(workerFailure(new Error('Cannot set memory limit to negative number'))).toBe(
      'the script failed unexpectedly',
    );
  });
});

describe('runScript — the report stays bounded and the host stays up', () => {
  it('reports a result that is not JSON text instead of ending the server', async () => {
    for (const code of [
      'return () => 1;',
      'return Symbol("x");',
      'return { toJSON() { return undefined; } };',
      "JSON.stringify = () => 'not json'; return 1;",
      'JSON.stringify = () => 5; return 1;',
    ]) {
      expect(await run(code)).toStrictEqual({
        ok: false,
        error: 'the result is not a JSON value: return plain data',
        calls: [],
      });
    }
  });

  it('cuts an oversized operation name in the call record', async () => {
    const report = await run(
      `try { await api.call('x'.repeat(100000), {}); } catch {} return 1;`,
      () => Promise.resolve({ ok: false, error: 'unknown operation' }),
    );
    expect(report.calls).toStrictEqual([{ name: 'x'.repeat(128), status: 'error' }]);
  });

  it('cuts the error text of a script', async () => {
    for (const code of ["throw new Error('z'.repeat(3e6));", "throw 'z'.repeat(3e6);"]) {
      const report = await run(code);
      expect(report.ok).toBe(false);
      expect(report.error!.length).toBeLessThanOrEqual(8192);
    }
  });

  it('terminates the worker of every script, whatever ended it', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await run('return 1;');
      await run('throw new Error("stop");');
      await run('for (;;) {}', echo, { ...LIMITS, ms: 200 });
      expect(terminate).toHaveBeenCalledTimes(3);
    } finally {
      terminate.mockRestore();
    }
  });
});

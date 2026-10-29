import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSDeferredPromise } from 'quickjs-emscripten-core';
import type { FromHost, ScriptLimits, ToHost } from './protocol.ts';

// The worker side of execute_code (issue #60): one worker per script runs it
// in QuickJS, a JavaScript engine compiled to WebAssembly. The script sees
// only `api.call` and `console.log`; QuickJS has no file, network, timer or
// module access of its own, and this file adds none. Values cross the
// boundary as JSON text only.
//
// The host (run.ts) owns every limit that matters for safety: it counts and
// sends the calls, and it terminates this worker at the deadline whatever
// state the script is in. The limits here only turn a runaway script into a
// readable error before that happens.

const port = parentPort!;
const { code, limits } = workerData as { code: string; limits: ScriptLimits };
const post = (message: ToHost): void => port.postMessage(message);

// The QuickJS heap lives in this WebAssembly memory, whose maximum the engine
// cannot grow past: QuickJS' own memory limit alone let a script grow the
// process by more than a gigabyte in a measurement. 64 KiB pages; the
// module needs at least 256 of them to start. (The WebAssembly global has no
// type under the Node-only libraries this package compiles with.)
type WasmMemory = NonNullable<Parameters<typeof newVariant>[1]['wasmMemory']>;
const { Memory } = (
  globalThis as unknown as {
    WebAssembly: { Memory: new (size: { initial: number; maximum: number }) => WasmMemory };
  }
).WebAssembly;
const memory = new Memory({ initial: 256, maximum: limits.wasmMemoryBytes / 65_536 });
const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
const runtime = module.newRuntime();
runtime.setMemoryLimit(limits.heapBytes);
runtime.setMaxStackSize(limits.stackBytes);
runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.ms));
const vm: QuickJSContext = runtime.newContext();

const logs: string[] = [];
let logBytes = 0;
let logsTruncated = false;
const pending = new Map<number, QuickJSDeferredPromise>();
let nextId = 0;

const hostLog = vm.newFunction('log', (line) => {
  const text = vm.getString(line);
  // A line counts with its line break, so empty lines cannot pile up for free
  logBytes += Buffer.byteLength(text) + 1;
  if (logBytes <= limits.logBytes) {
    logs.push(text);
  } else {
    logsTruncated = true;
  }
});
const refusalOf = (args: string | undefined): string | undefined => {
  if (nextId >= limits.calls) {
    return `call limit reached: at most ${String(limits.calls)} api.call() per script`;
  }
  if (args !== undefined && Buffer.byteLength(args) > limits.argsBytes) {
    return `arguments too large: at most ${String(limits.argsBytes)} bytes of JSON per api.call()`;
  }
  return undefined;
};
// `name` and the JSON text of the arguments come from the prelude below. A
// call past the budget or with oversized arguments throws here, so a script
// cannot flood the host with messages; the host counts again.
const hostCall = vm.newFunction('call', (name, args) => {
  const text = vm.typeof(args) === 'string' ? vm.getString(args) : undefined;
  const refusal = refusalOf(text);
  if (refusal !== undefined) {
    return { error: vm.newError(refusal) };
  }
  const id = nextId++;
  const deferred = vm.newPromise();
  pending.set(id, deferred);
  post({ type: 'call', id, name: vm.getString(name), args: text });
  return deferred.handle;
});
const host = vm.newObject();
vm.setProp(host, 'log', hostLog);
vm.setProp(host, 'call', hostCall);
vm.setProp(vm.global, '__host', host);
for (const handle of [host, hostCall, hostLog]) {
  handle.dispose();
}

// Runs before the script, in its own scope: the only globals it adds are
// `api` and `console`, and the host functions are reachable only through them
const prelude = `(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const text = (value) => (typeof value === 'string' ? value : stringify(value) ?? String(value));
  globalThis.api = Object.freeze({
    call: async (name, args) => {
      if (typeof name !== 'string') throw new TypeError('api.call(name, args): name must be a string');
      return parse(await host.call(name, args === undefined ? undefined : stringify(args)));
    },
  });
  globalThis.console = Object.freeze({ log: (...values) => host.log(values.map(text).join(' ')) });
})();
`;
vm.unwrapResult(vm.evalCode(prelude, 'prelude.js')).dispose();

const describe = (handle: Parameters<QuickJSContext['dump']>[0]): string => {
  const error = vm.dump(handle) as { name?: unknown; message?: unknown } | undefined;
  return typeof error === 'object' && error !== null && typeof error.message === 'string'
    ? `${typeof error.name === 'string' ? error.name : 'Error'}: ${error.message}`
    : String(error);
};

const finish = (outcome: { ok: true; result: string } | { ok: false; error: string }): void => {
  post({ type: 'done', ...outcome, logs, logsTruncated });
};

port.on('message', (message: FromHost) => {
  const deferred = pending.get(message.id);
  if (deferred === undefined) {
    return;
  }
  pending.delete(message.id);
  if (message.ok) {
    const value = vm.newString(message.value);
    deferred.resolve(value);
    value.dispose();
  } else {
    const error = vm.newError(message.error);
    deferred.reject(error);
    error.dispose();
  }
  deferred.dispose();
  runtime.executePendingJobs();
});

// The script is the body of an async function; its result leaves as JSON
// text, so anything JSON cannot represent fails here, inside the sandbox
const started = vm.evalCode(
  `(async () => {\n${code}\n})().then((value) => JSON.stringify(value === undefined ? null : value))`,
  'script.js',
);
if (started.error) {
  finish({ ok: false, error: describe(started.error) });
  started.error.dispose();
} else {
  const settled = vm.resolvePromise(started.value);
  started.value.dispose();
  runtime.executePendingJobs();
  const result = await settled;
  if (result.error) {
    finish({ ok: false, error: describe(result.error) });
    result.error.dispose();
  } else {
    // JSON.stringify gives no text for a function or a symbol, and the
    // script may have replaced it; the host checks the text again
    if (vm.typeof(result.value) === 'string') {
      finish({ ok: true, result: vm.getString(result.value) });
    } else {
      finish({ ok: false, error: 'the result is not a JSON value: return plain data' });
    }
    result.value.dispose();
  }
}

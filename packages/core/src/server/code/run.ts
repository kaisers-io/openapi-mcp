import { Worker } from 'node:worker_threads';
import type { FromHost, ScriptLimits, ToHost } from './protocol.ts';

// The host side of execute_code (issue #60): runs one script in a fresh
// worker (worker.ts) and answers its api.call() messages through `call`,
// which the caller routes through the whole dispatcher. This side enforces
// every budget again and owns the deadline: when the script ends for any
// reason (a result, an error, the deadline, a cancelled tool call, a dead
// worker), the worker is terminated, calls still waiting never start, and
// calls in flight are aborted. The record of calls lives here, so it
// survives a terminated worker.

export const SCRIPT_LIMITS: ScriptLimits = {
  calls: 50,
  concurrentCalls: 4,
  ms: 30_000,
  wasmMemoryBytes: 80 * 1024 * 1024,
  heapBytes: 48 * 1024 * 1024,
  stackBytes: 512 * 1024,
  workerHeapMb: 64,
  argsBytes: 100_000,
  receivedBytes: 8 * 1024 * 1024,
  resultBytes: 50_000,
  logBytes: 10_000,
};

// Scripts running at once in this process, across every session: each one
// holds a worker and up to its memory limits
export const MAX_RUNNING_SCRIPTS = 4;
let running = 0;

export type NestedCall = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;

// A cancelled call was still waiting or in flight when the script ended. A
// call the worker refused (a budget) never reaches the host, so it has none.
export type CallStatus = 'ok' | 'error' | 'cancelled';

// The report repeats what the script passed, so both are bounded like the
// rest of it: a name at the length of an operation name, an error text at the
// size a tool error has
const NAME_MAX = 128;
const ERROR_MAX = 8192;
const NOT_JSON = 'the result is not a JSON value: return plain data';

export type ScriptReport = {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
  logsTruncated?: true;
  calls: { name: string; status: CallStatus }[];
};

// Source runs load worker.ts directly; the published bundle has it as its
// own entry next to the chunk that holds this file
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './execute-worker.mjs',
  import.meta.url,
);

const seconds = (ms: number): string => String(ms / 1000);

// Why a worker died: an allocation past the WebAssembly memory's maximum
// aborts the engine, and a worker heap past its limit ends the worker
export const workerFailure = (error: Error & { code?: string }): string =>
  error.code === 'ERR_WORKER_OUT_OF_MEMORY' || /^Aborted\(|out of memory/u.test(error.message)
    ? 'memory limit reached: the script used too much memory'
    : 'the script failed unexpectedly';

type Settled = Omit<ScriptReport, 'calls'>;

export const runScript = async (
  code: string,
  call: NestedCall,
  signal: AbortSignal,
  limits: ScriptLimits = SCRIPT_LIMITS,
): Promise<ScriptReport> => {
  if (signal.aborted) {
    return { ok: false, error: 'cancelled', calls: [] };
  }
  if (running >= MAX_RUNNING_SCRIPTS) {
    return {
      ok: false,
      error: `${String(MAX_RUNNING_SCRIPTS)} scripts are already running; try again when one has finished`,
      calls: [],
    };
  }
  running += 1;
  try {
    return await supervise(code, call, signal, limits);
  } finally {
    running -= 1;
  }
};

const supervise = (
  code: string,
  call: NestedCall,
  signal: AbortSignal,
  limits: ScriptLimits,
): Promise<ScriptReport> => {
  const calls: { name: string; status: CallStatus | 'queued' | 'sent' }[] = [];
  // Aborted exactly when the script has ended, for whatever reason
  const ended = new AbortController();
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  let received = 0;
  const report = Promise.withResolvers<ScriptReport>();
  const worker = new Worker(WORKER_URL, {
    workerData: { code, limits },
    resourceLimits: { maxOldGenerationSizeMb: limits.workerHeapMb },
    // QuickJS could not read the environment anyway; the worker gets none
    env: {},
    stdin: false,
  });

  // The one terminal transition: whatever ends the script, the report is
  // taken once, here, and nothing that settles later changes it
  const finish = (settled: Settled): void => {
    if (ended.signal.aborted) {
      return;
    }
    ended.abort();
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    for (const wake of waiting.splice(0)) {
      wake();
    }
    void worker.terminate();
    report.resolve({
      ...settled,
      calls: calls.map(({ name, status }) => ({
        name,
        status: status === 'queued' || status === 'sent' ? 'cancelled' : status,
      })),
    });
  };
  const fail = (error: string): void => {
    finish({ ok: false, error });
  };
  const onAbort = (): void => {
    fail('cancelled');
  };
  signal.addEventListener('abort', onAbort, { once: true });
  // Covers the worker's start too, and is never extended
  const timer = setTimeout(() => {
    fail(`time limit reached: the script ran longer than ${seconds(limits.ms)} s`);
  }, limits.ms);

  const reply = (message: FromHost): void => {
    if (!ended.signal.aborted) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
      worker.postMessage(message);
    }
  };
  const slot = (): Promise<void> => {
    const freed = Promise.withResolvers<void>();
    waiting.push(freed.resolve);
    return freed.promise;
  };
  const answer = async (id: number, name: string, args: string | undefined): Promise<void> => {
    const record: (typeof calls)[number] = { name: name.slice(0, NAME_MAX), status: 'queued' };
    calls.push(record);
    while (inFlight >= limits.concurrentCalls && !ended.signal.aborted) {
      await slot();
    }
    if (ended.signal.aborted) {
      return;
    }
    inFlight += 1;
    record.status = 'sent';
    try {
      const outcome = await call(
        name,
        args === undefined ? undefined : JSON.parse(args),
        ended.signal,
      );
      if (ended.signal.aborted) {
        return;
      }
      if (!outcome.ok) {
        record.status = 'error';
        reply({ id, ok: false, error: outcome.error });
        return;
      }
      const value = JSON.stringify(outcome.value) ?? 'null';
      received += Buffer.byteLength(value);
      if (received > limits.receivedBytes) {
        record.status = 'error';
        reply({
          id,
          ok: false,
          error: `results too large: the api.call() results of one script may hold at most ${String(limits.receivedBytes / 1024 / 1024)} MB together; request fewer or smaller results`,
        });
        return;
      }
      record.status = 'ok';
      reply({ id, ok: true, value });
    } catch {
      if (!ended.signal.aborted) {
        record.status = 'error';
        reply({ id, ok: false, error: 'the call failed unexpectedly' });
      }
    } finally {
      inFlight -= 1;
      waiting.shift()?.();
    }
  };

  worker.on('message', (message: ToHost) => {
    if (ended.signal.aborted) {
      return;
    }
    if (message.type === 'call') {
      // The worker refuses these itself; a message past them means the
      // worker is not behaving, and the script ends
      if (
        calls.length >= limits.calls ||
        (message.args !== undefined && Buffer.byteLength(message.args) > limits.argsBytes)
      ) {
        fail('the script exceeded its call limits');
        return;
      }
      void answer(message.id, message.name, message.args);
      return;
    }
    const extras = {
      ...(message.logs.length > 0 ? { logs: message.logs } : {}),
      ...(message.logsTruncated ? { logsTruncated: true as const } : {}),
    };
    if (!message.ok) {
      finish({ ok: false, error: message.error.slice(0, ERROR_MAX), ...extras });
      return;
    }
    const size = Buffer.byteLength(message.result);
    if (size > limits.resultBytes) {
      finish({
        ok: false,
        error: `result too large (${String(size)} bytes, at most ${String(limits.resultBytes)}): return only the fields you need`,
        ...extras,
      });
    } else {
      // The script can replace JSON.stringify, or return what JSON cannot
      // hold (a function, a symbol): its text may not parse
      let result: unknown;
      try {
        result = JSON.parse(message.result) as unknown;
      } catch {
        finish({ ok: false, error: NOT_JSON, ...extras });
        return;
      }
      finish({ ok: true, result, ...extras });
    }
  });
  worker.on('error', (error: Error & { code?: string }) => {
    fail(workerFailure(error));
  });
  worker.on('exit', () => {
    fail('the script failed unexpectedly');
  });
  return report.promise;
};

// The messages between execute_code's host side (run.ts) and its worker
// (worker.ts). Only strings and plain records cross: the script's values
// travel as JSON text.

export type ScriptLimits = {
  // The api.call() calls per script, counted by the host
  calls: number;
  // Nested calls in flight at once: a script's Promise.all must not fill the
  // executor's upstream queue, which every other tool call shares
  concurrentCalls: number;
  // Wall time for the whole script, nested calls included
  ms: number;
  // The WebAssembly memory QuickJS runs in (a hard ceiling), and the QuickJS
  // heap limit below it that turns an allocation failure into a script error
  wasmMemoryBytes: number;
  heapBytes: number;
  stackBytes: number;
  // The worker's own JavaScript heap, which holds call results in transit
  workerHeapMb: number;
  // The JSON text of one call's arguments, and of all call results a script
  // receives together: both are held outside the QuickJS heap on their way
  argsBytes: number;
  receivedBytes: number;
  resultBytes: number;
  logBytes: number;
};

export type ToHost =
  | { type: 'call'; id: number; name: string; args: string | undefined }
  | ({ type: 'done'; logs: string[]; logsTruncated: boolean } & (
      | { ok: true; result: string }
      | { ok: false; error: string }
    ));

export type FromHost = { id: number } & (
  | { ok: true; value: string }
  | { ok: false; error: string }
);

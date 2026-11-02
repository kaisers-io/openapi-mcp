// The two memory measurements of a `serve` session: peak RSS (reported) and
// the heap still in use after a full GC (gated; see heap-probe.ts for why).

import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { LIVE_HEAP_MARKER } from './heap-marker.ts';
import type { IntervalReport, ProbeRequest } from './heap-marker.ts';

const LIVE_HEAP_TIMEOUT_MS = 30_000;
const LIVE_HEAP_RE = new RegExp(`^${LIVE_HEAP_MARKER} (?<bytes>\\d+)$`, 'mu');
const VM_HWM_RE = /^VmHWM:\s+(?<kb>\d+) kB$/mu;

// Node flags of every measured serve process: the harness's heap probe
export const PROBE_FLAGS = [
  '--expose-gc',
  '--import',
  new URL('heap-probe.ts', import.meta.url).href,
] as const;

// Peak RSS of a live process. /proc is Linux-only; elsewhere the metric is
// simply absent from the report rather than estimated.
export const peakRssMB = async (pid: number): Promise<number | undefined> => {
  let status: string;
  try {
    status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
  } catch {
    return undefined;
  }
  const kb = VM_HWM_RE.exec(status)?.groups?.['kb'];
  return kb === undefined ? undefined : Number(kb) / 1024;
};

export type LiveHeapReader = {
  // Fed every stderr chunk of the child
  observe: (chunk: string) => void;
  // The child exited: a pending read fails with this
  fail: (error: Error) => void;
  // Asks the probe for the heap in use after a full GC, in MB; undefined
  // where POSIX signals are unavailable
  read: () => Promise<number | undefined>;
};

export const createLiveHeapReader = (child: ChildProcess): LiveHeapReader => {
  let waiter: PromiseWithResolvers<number> | undefined;
  let seen = '';
  return {
    observe: (chunk) => {
      if (waiter === undefined) {
        return;
      }
      seen += chunk;
      const bytes = LIVE_HEAP_RE.exec(seen)?.groups?.['bytes'];
      if (bytes !== undefined) {
        waiter.resolve(Number(bytes) / 1024 / 1024);
        waiter = undefined;
      }
    },
    fail: (error) => {
      waiter?.reject(error);
      waiter = undefined;
    },
    read: async () => {
      if (process.platform === 'win32') {
        return;
      }
      const current = Promise.withResolvers<number>();
      waiter = current;
      seen = '';
      const timeout = setTimeout(() => {
        current.reject(new Error('the server did not report its heap'));
      }, LIVE_HEAP_TIMEOUT_MS);
      child.kill('SIGUSR2');
      try {
        return await current.promise;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};

const INTERVAL_TIMEOUT_MS = 30_000;

export type IntervalProbe = {
  // Resolves once the probe has reset its counters
  start: () => Promise<void>;
  stop: () => Promise<IntervalReport>;
};

// The measured interval of heap-probe.ts over the child's IPC channel: one
// request at a time, each answered by the probe
export const createIntervalProbe = (child: ChildProcess): IntervalProbe => {
  // `start` is answered with "started", `stop` with the report
  const ask = async <Answer>(
    request: ProbeRequest,
    expected: (message: unknown) => boolean,
  ): Promise<Answer> => {
    const answer = Promise.withResolvers<Answer>();
    const onMessage = (message: unknown): void => {
      if (expected(message)) {
        answer.resolve(message as Answer);
      }
    };
    const onGone = (): void => {
      answer.reject(new Error(`the server exited before answering "${request}"`));
    };
    const timeout = setTimeout(() => {
      answer.reject(new Error(`the server did not answer "${request}"`));
    }, INTERVAL_TIMEOUT_MS);
    child.on('message', onMessage);
    child.once('exit', onGone);
    child.once('disconnect', onGone);
    try {
      if (!child.connected) {
        throw new Error(`the server has no probe channel for "${request}"`);
      }
      // A failed send rejects through its callback, never as an 'error' event
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- child.send reports a failed send only through this callback; without one it emits 'error' on the child
      child.send(request, (error) => {
        if (error !== null) {
          answer.reject(error);
        }
      });
      return await answer.promise;
    } finally {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onGone);
      child.off('disconnect', onGone);
    }
  };
  return {
    start: async () => {
      await ask<string>('start', (message) => message === 'started');
    },
    stop: () =>
      ask<IntervalReport>('stop', (message) => typeof message === 'object' && message !== null),
  };
};

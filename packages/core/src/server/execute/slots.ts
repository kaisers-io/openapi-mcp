// A bounded FIFO admission queue in front of the upstream executor. MCP
// hosts routinely issue several tool calls in parallel; failing every call
// past the concurrency cap made a burst of 17 parallel calls return an error
// for the 17th even though a slot would free up milliseconds later. Instead,
// a call past the cap WAITS for a slot — first come, first served — and only
// a call that finds the queue itself full, or that waits longer than its
// deadline, is refused. The queue length is capped, so a flood of calls
// still cannot pile up unbounded pending work.

export type SlotOutcome = 'acquired' | 'overloaded' | 'timeout' | 'cancelled';

export type SlotQueue = {
  // Resolves once the caller holds a slot ('acquired' — it MUST call
  // release() exactly once afterwards), or with the reason it never will.
  // `deadline` is called only when the caller actually has to wait, so the
  // uncontended path never starts a timer.
  acquire: (signal: AbortSignal, deadline: () => AbortSignal) => Promise<SlotOutcome>;
  release: () => void;
  // Observability for tests: slots held, and callers waiting.
  active: () => number;
  queued: () => number;
};

type Waiter = { grant: () => void };

export const createSlotQueue = (maxActive: number, maxQueued: number): SlotQueue => {
  // Imperative on purpose: `active` and `waiters` are genuinely mutable
  // shared state (a counting semaphore plus its wait list) — every acquire
  // and release must observe the other's effect immediately.
  let active = 0;
  const waiters: Waiter[] = [];

  const acquire = (signal: AbortSignal, deadline: () => AbortSignal): Promise<SlotOutcome> => {
    if (signal.aborted) {
      return Promise.resolve('cancelled');
    }
    // Never jump the queue: a free slot goes to an existing waiter first
    // (release() hands it over directly), so a newcomer only takes one
    // straight away when nobody is waiting.
    if (active < maxActive && waiters.length === 0) {
      active += 1;
      return Promise.resolve('acquired');
    }
    if (waiters.length >= maxQueued) {
      return Promise.resolve('overloaded');
    }
    const timer = deadline();
    if (timer.aborted) {
      return Promise.resolve('timeout');
    }
    const { promise, resolve } = Promise.withResolvers<SlotOutcome>();
    // One exit for every outcome: leaving the queue (cancel or deadline)
    // removes the waiter, so a slot released later is never handed to a
    // caller that already gave up; a grant finds it already shifted off.
    const settle = (outcome: SlotOutcome): void => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      signal.removeEventListener('abort', onAbort);
      timer.removeEventListener('abort', onTimeout);
      resolve(outcome);
    };
    const onAbort = (): void => {
      settle('cancelled');
    };
    const onTimeout = (): void => {
      settle('timeout');
    };
    const waiter: Waiter = {
      grant: () => {
        settle('acquired');
      },
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer.addEventListener('abort', onTimeout, { once: true });
    waiters.push(waiter);
    return promise;
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    // The slot passes straight to the next waiter; `active` is unchanged.
    next.grant();
  };

  return { acquire, release, active: () => active, queued: () => waiters.length };
};

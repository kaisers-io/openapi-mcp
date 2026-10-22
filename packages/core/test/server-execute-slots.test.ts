import { describe, expect, it } from 'vitest';
import { createSlotQueue } from '../src/server/execute/slots.ts';

const never = (): AbortSignal => new AbortController().signal;

describe('createSlotQueue', () => {
  it('admits up to maxActive at once, queues up to maxQueued, refuses the rest', async () => {
    const slots = createSlotQueue(2, 1);
    expect(await slots.acquire(never(), never)).toBe('acquired');
    expect(await slots.acquire(never(), never)).toBe('acquired');
    const waiting = slots.acquire(never(), never);
    expect(slots.queued()).toBe(1);
    expect(await slots.acquire(never(), never)).toBe('overloaded');
    slots.release();
    expect(await waiting).toBe('acquired');
    // The released slot passed straight to the waiter.
    expect(slots.active()).toBe(2);
    slots.release();
    slots.release();
    expect(slots.active()).toBe(0);
  });

  it('a newcomer never jumps an existing waiter, even at the instant a slot frees', async () => {
    const slots = createSlotQueue(1, 4);
    await slots.acquire(never(), never);
    const order: string[] = [];
    const first = slots.acquire(never(), never).then(() => order.push('first'));
    slots.release();
    const second = slots.acquire(never(), never).then(() => order.push('second'));
    await first;
    slots.release();
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('returns cancelled for an already-aborted signal without taking a slot', async () => {
    const slots = createSlotQueue(1, 1);
    expect(await slots.acquire(AbortSignal.abort(), never)).toBe('cancelled');
    expect(slots.active()).toBe(0);
  });

  it('returns timeout at once when the wait deadline has already passed', async () => {
    const slots = createSlotQueue(1, 1);
    await slots.acquire(never(), never);
    expect(await slots.acquire(never(), () => AbortSignal.abort())).toBe('timeout');
    expect(slots.queued()).toBe(0);
  });

  it('never starts a deadline for an uncontended acquire', async () => {
    const slots = createSlotQueue(1, 1);
    let started = 0;
    const deadline = (): AbortSignal => {
      started += 1;
      return never();
    };
    expect(await slots.acquire(never(), deadline)).toBe('acquired');
    expect(started).toBe(0);
  });

  it('removes its listeners once settled', async () => {
    const slots = createSlotQueue(1, 1);
    await slots.acquire(never(), never);
    const controller = new AbortController();
    const timer = new AbortController();
    const waiting = slots.acquire(controller.signal, () => timer.signal);
    slots.release();
    expect(await waiting).toBe('acquired');
    // Aborting afterwards is a no-op: no stale listener re-enters settle.
    controller.abort();
    timer.abort();
    expect(slots.active()).toBe(1);
    expect(slots.queued()).toBe(0);
  });
});

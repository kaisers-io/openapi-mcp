import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../src/freeze.ts';

describe('deepFreeze', () => {
  // Review of #55: a schema shared by many operations is walked once
  it('walks a graph shared by the walks of one build only once', () => {
    let reads = 0;
    const shared = {
      get nested() {
        reads += 1;
        return { leaf: 1 };
      },
    };
    const seen = new WeakSet<object>();
    deepFreeze({ first: shared }, seen);
    deepFreeze({ second: shared }, seen);
    expect(reads).toBe(1);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it('walks an object that was only frozen shallowly elsewhere', () => {
    const inner = { leaf: 1 };
    const outer = Object.freeze({ inner });
    deepFreeze(outer);
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it('freezes a cycle', () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first['second'] = second;
    deepFreeze(first);
    expect(Object.isFrozen(first) && Object.isFrozen(second)).toBe(true);
  });
});

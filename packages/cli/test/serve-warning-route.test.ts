import { describe, expect, it } from 'vitest';
import { testContext } from '../src/context.ts';
import { createTransportWarningRoute } from '../src/commands/serve.ts';

// In-process unit coverage for the bounded stderr route serve.ts hands both
// transports as their out-of-band error sink. The E2E suites drive the route
// through a real spawned subprocess (v8 coverage never sees inside a child),
// and a real subprocess cannot be made to cross the window without actually
// sleeping — so the window itself is exercised here, against the injected
// clock, which is the whole reason the route takes `ctx.now` instead of
// calling Date.now.
const routeWith = (nowMs: () => number) => {
  const errLines: string[] = [];
  return {
    errLines,
    route: createTransportWarningRoute(testContext({ errLines, now: nowMs }), 'http transport'),
  };
};

describe('createTransportWarningRoute', () => {
  it('emits the first warning immediately and drops the rest of a burst inside the window', () => {
    // A fixed clock: every error in this burst lands at the same instant, the
    // shape a client hammering one bad request repeatedly actually produces.
    const { errLines, route } = routeWith(() => 1000);
    for (let index = 0; index < 50; index += 1) {
      route(new Error(`rejection ${String(index)}`));
    }
    // Exactly one line — not 50. Falsification: without the window check this
    // is 50 lines of client-chosen text on the operator's stderr.
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toContain('http transport: rejection 0');
    // Framed and sanitized by the same warning path the startup diagnostics
    // use, never written raw.
    expect(errLines[0]).toMatch(/^openapi-mcp: warning: /u);
  });

  it('reports the suppressed COUNT on the next warning that gets through, once the window has passed', () => {
    let nowMs = 0;
    const { errLines, route } = routeWith(() => nowMs);
    route(new Error('first'));
    for (let index = 0; index < 7; index += 1) {
      nowMs = 999; // Still inside the window
      route(new Error('dropped'));
    }
    expect(errLines).toHaveLength(1);

    nowMs = 1000; // Exactly one window later: emission resumes
    route(new Error('second'));
    // The notice comes FIRST, then the warning that carried it out — a
    // reader sees what was lost before the line that follows it.
    expect(errLines).toHaveLength(3);
    expect(errLines[1]).toContain('http transport: 7 more warnings suppressed');
    expect(errLines[2]).toContain('http transport: second');
  });

  it('adds no notice when nothing was suppressed, and starts counting again after each emission', () => {
    let nowMs = 0;
    const { errLines, route } = routeWith(() => nowMs);
    route(new Error('first'));
    nowMs = 5000;
    route(new Error('second'));
    expect(errLines).toHaveLength(2);
    // A quiet gap must not manufacture a "0 more warnings suppressed" line.
    expect(errLines[1]).toContain('http transport: second');
    expect(errLines.join('\n')).not.toContain('suppressed');

    // The counter reset with that emission: the next suppressed run reports
    // only ITS own drops, never a running total from before.
    nowMs = 5001;
    route(new Error('dropped'));
    nowMs = 6001;
    route(new Error('third'));
    expect(errLines).toHaveLength(4);
    expect(errLines[2]).toContain('http transport: 1 more warnings suppressed');
  });

  it('labels each route independently — the stdio and HTTP sinks do not share a budget', () => {
    const errLines: string[] = [];
    const ctx = testContext({ errLines, now: () => 42 });
    const httpRoute = createTransportWarningRoute(ctx, 'http transport');
    const stdioRoute = createTransportWarningRoute(ctx, 'stdio transport');
    httpRoute(new Error('one'));
    stdioRoute(new Error('two'));
    // Two routes, one line each: a shared counter would swallow the second.
    expect(errLines).toHaveLength(2);
    expect(errLines[0]).toContain('http transport: one');
    expect(errLines[1]).toContain('stdio transport: two');
  });
});

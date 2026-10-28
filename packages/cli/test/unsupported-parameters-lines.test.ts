import { describe, expect, it } from 'vitest';
import { unsupportedParameterLines } from '../src/unsupported-parameters.ts';

// Issue #67: the startup lines about left-out parameters stay bounded and
// sanitized however many tools and parameters a spec has
const leaving = (toolName: string, ...names: string[]) => ({
  toolName,
  leftOutParameters: names.map((name) => ({ name, in: 'query' as const, reason: 'r' })),
});

describe('unsupportedParameterLines', () => {
  it('says nothing when nothing is left out and nothing could be', () => {
    expect(unsupportedParameterLines([{ toolName: 'a' }], [], { matches: [] })).toStrictEqual([]);
  });

  it('names ten tools and three parameters each at most', () => {
    const tools = Array.from({ length: 12 }, (_, index) =>
      leaving(`t${String(index)}`, 'a', 'b', 'c', 'd'),
    );
    const [line] = unsupportedParameterLines(tools, [], { matches: [] });
    expect(line).toBe(
      `--omit-unsupported-parameters: 12 tools leave out optional parameters the agent cannot set: ${Array.from(
        { length: 10 },
        (_, index) => `t${String(index)} (a, b, c, …)`,
      ).join(', ')} and 2 more; each with its reason: openapi-mcp --json tools`,
    );
  });

  it('sanitizes and bounds parameter names, which are spec text', () => {
    const [line] = unsupportedParameterLines([leaving('t', `x\u001B[2J${'y'.repeat(500)}`)], [], {
      matches: [],
    });
    expect(line).not.toContain('\u001B');
    expect(line?.length).toBeLessThan(250);
  });

  it('names an omitted operation without a tool name by its route', () => {
    const [line] = unsupportedParameterLines(
      [],
      [{ method: 'GET', path: '/a\u0007', reason: 'r', omittableParameters: ['expand'] }],
      { matches: [] },
    );
    expect(line).toBe(
      '1 operation is omitted only for optional parameters this server cannot send; --omit-unsupported-parameters <pattern> builds them without those parameters: GET /a (expand)',
    );
  });

  it('reports a pattern that matches only tools leaving nothing out, never a dead one', () => {
    expect(
      unsupportedParameterLines([leaving('t', 'a'), { toolName: 'u' }], [], {
        matches: [
          { raw: 'tag:u', toolNames: ['u'] },
          { raw: 'tag:t', toolNames: ['t', 'u'] },
          { raw: 'tag:none', toolNames: [] },
        ],
      }),
    ).toStrictEqual([
      '--omit-unsupported-parameters "tag:u" matches no operation with an optional parameter this server cannot send, so it changes nothing',
      '--omit-unsupported-parameters: 1 tool leaves out optional parameters the agent cannot set: t (a); each with its reason: openapi-mcp --json tools',
    ]);
  });
});

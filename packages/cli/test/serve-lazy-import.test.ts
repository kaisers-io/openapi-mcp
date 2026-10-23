import { describe, expect, it, vi } from 'vitest';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// The serve command imports its action on demand (issue
// kaisers-io/openapi-mcp-archive#91). When that chunk cannot be loaded (a
// broken install), the failure must take serve's own error path: plain text on
// stderr even under --json, nothing on stdout, which stays MCP-only.
vi.mock(import('../src/commands/serve-action.ts'), () => {
  throw new Error('chunk serve-action is missing');
});

describe('serve action that fails to load', () => {
  it('is reported on stderr only, even with --json', async () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const ctx = testContext({ lines, errLines });
    const code = await run(ctx, ['node', 'openapi-mcp', '--json', 'serve', '--spec', 'spec.json']);
    expect(code).not.toBe(0);
    expect(lines).toEqual([]);
    // Plain `openapi-mcp: <message>` text (vitest wraps the factory's error),
    // never the --json envelope
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines[0]).toMatch(/^openapi-mcp: .*error/iu);
    expect(errLines.join('\n')).not.toContain('"ok"');
  });
});

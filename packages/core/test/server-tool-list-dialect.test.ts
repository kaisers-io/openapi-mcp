import { describe, expect, it } from 'vitest';
import { hasDefaultDialect, listedTool } from '../src/server/tool-list.ts';

// Issue #49: the root `$schema` is left out only where the negotiated MCP
// revision makes JSON Schema 2020-12 the default dialect (2025-11-25 on)

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

describe('default dialect (#49)', () => {
  it('applies from revision 2025-11-25 on', () => {
    expect(hasDefaultDialect('2025-11-25')).toBe(true);
    expect(hasDefaultDialect('2026-07-28')).toBe(true);
    expect(hasDefaultDialect('2025-06-18')).toBe(false);
    expect(hasDefaultDialect('2024-11-05')).toBe(false);
    expect(hasDefaultDialect()).toBe(false);
  });

  it('drops only a root 2020-12 `$schema`, from the input and output schema', () => {
    const tool = {
      name: 't',
      inputSchema: {
        $schema: DIALECT,
        type: 'object',
        properties: { $schema: { type: 'string' } },
      },
      outputSchema: { $schema: DIALECT, type: 'object' },
    };
    expect(listedTool(tool)).toStrictEqual({
      name: 't',
      inputSchema: { type: 'object', properties: { $schema: { type: 'string' } } },
      outputSchema: { type: 'object' },
    });
    // Another dialect would change meaning without the keyword
    const draft7 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' };
    expect(listedTool({ inputSchema: draft7 }).inputSchema).toBe(draft7);
    expect(listedTool({ inputSchema: { type: 'object' } })).not.toHaveProperty('outputSchema');
  });
});

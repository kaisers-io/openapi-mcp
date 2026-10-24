import { describe, expect, it } from 'vitest';
import type { GeneratedTool } from '@kaisers-io/openapi-mcp-core';
import { outputSchemaOptOutWarningLines } from '../src/output-schema-opt-out.ts';

// Issue #13: the startup line naming the tools --omit-output-schema affected
describe('outputSchemaOptOutWarningLines', () => {
  const tools = (count: number, optedOut: boolean): GeneratedTool[] =>
    Array.from(
      { length: count },
      (_unused, index) =>
        ({
          toolName: `tool${String(index + 1)}`,
          ...(optedOut ? { outputSchemaOptedOut: true } : {}),
        }) as GeneratedTool,
    );

  it('says nothing when no tool was opted out', () => {
    expect(outputSchemaOptOutWarningLines(tools(3, false))).toEqual([]);
  });

  it('names up to ten tools and counts the rest', () => {
    expect(outputSchemaOptOutWarningLines(tools(2, true))).toEqual([
      '--omit-output-schema: response-schema validation is off for 2 tools, results are returned as text: tool1, tool2',
    ]);
    const [line] = outputSchemaOptOutWarningLines(tools(12, true));
    expect(line).toBe(
      '--omit-output-schema: response-schema validation is off for 12 tools, results are returned as text: tool1, tool2, tool3, tool4, tool5, tool6, tool7, tool8, tool9, tool10 and 2 more',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { SPEC_BUDGETS } from '../src/index.ts';

describe('SPEC_BUDGETS', () => {
  it('pins the spec budget values', () => {
    expect(SPEC_BUDGETS).toEqual({
      fetchTimeoutMs: 30_000,
      maxSpecBytes: 20 * 1024 * 1024,
      maxYamlAliases: 1000,
      maxParseDepth: 128,
      maxSchemaNodes: 500_000,
      maxRefDepth: 64,
      maxToolCount: 512,
      maxOperationCount: 4096,
      maxTextLength: 4096,
    });
  });
});

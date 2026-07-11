// Spec §4.1 resource budgets for untrusted spec input. All violations are hard
// validation errors raised before anything is cached or emitted.
export const SPEC_BUDGETS = {
  fetchTimeoutMs: 30_000,
  maxSpecBytes: 20 * 1024 * 1024,
  maxYamlAliases: 1000,
  maxParseDepth: 128,
  maxSchemaNodes: 500_000,
  maxRefDepth: 64,
  maxToolCount: 512,
  maxTextLength: 4096,
} as const;

export type SpecBudgets = typeof SPEC_BUDGETS;

// Resource budgets for untrusted spec input. All violations are hard
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
  // UTF-8 bytes of the root server URL after variable expansion. A base URL is
  // a prefix of every request URL, and RFC 9110 §4.1 only recommends
  // supporting 8000-octet request targets; real base URLs are a few dozen
  // bytes. Checked BEFORE the expansion is materialized (issue #37).
  maxServerUrlBytes: 2048,
} as const;

export type SpecBudgets = typeof SPEC_BUDGETS;

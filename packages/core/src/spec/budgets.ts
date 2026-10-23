// Resource budgets for untrusted spec input. All violations are hard
// validation errors. Every budget except maxToolCount is enforced before
// anything is cached or emitted; maxToolCount depends on the run's filters and
// is enforced after filtering, before anything is emitted.
export const SPEC_BUDGETS = {
  fetchTimeoutMs: 30_000,
  maxSpecBytes: 20 * 1024 * 1024,
  maxYamlAliases: 1000,
  maxParseDepth: 128,
  maxSchemaNodes: 500_000,
  maxRefDepth: 64,
  // Bounds what is EXPOSED to the model, i.e. the operations left after
  // --allow/--deny filtering (issue kaisers-io/openapi-mcp-archive#32)
  maxToolCount: 512,
  // The exposed-set budget under --tool-mode discover (issue
  // kaisers-io/openapi-mcp-archive#38). tools/list then carries four fixed
  // tools whatever the operation count, so this no longer bounds model context;
  // it bounds the per-operation tool generation, output-validator compilation
  // and search-index work instead, and is set to the raw operation cap so a
  // filter is never required just to start.
  maxDiscoverToolCount: 4096,
  // Raw sanity cap on the unfiltered document. maxSpecBytes and maxSchemaNodes
  // already bound the document's size; this bounds the per-operation
  // normalization, naming and filter-matching work, which runs over every
  // operation rather than at most maxToolCount. Large public APIs fit (the
  // GitHub REST description has 1,242 operations, Stripe 612).
  maxOperationCount: 4096,
  maxTextLength: 4096,
  // UTF-8 bytes of the root server URL after variable expansion. A base URL is
  // a prefix of every request URL, and RFC 9110 §4.1 only recommends
  // supporting 8000-octet request targets; real base URLs are a few dozen
  // bytes. Checked BEFORE the expansion is materialized (issue
  // kaisers-io/openapi-mcp-archive#37).
  maxServerUrlBytes: 2048,
} as const;

export type SpecBudgets = typeof SPEC_BUDGETS;

// Resource budgets for untrusted spec input. All violations are hard
// validation errors. Every budget except maxToolCount is enforced before
// anything is cached or emitted; maxToolCount depends on the run's filters and
// on which operations become tools, so the CLI enforces it on the tools it
// builds, before anything is emitted (issue #67).
export const SPEC_BUDGETS = {
  fetchTimeoutMs: 30_000,
  maxSpecBytes: 20 * 1024 * 1024,
  maxYamlAliases: 1000,
  maxParseDepth: 128,
  maxSchemaNodes: 500_000,
  maxRefDepth: 64,
  // Bounds what is EXPOSED to the model, i.e. the tools built from the
  // operations left after --allow/--deny filtering (issue
  // kaisers-io/openapi-mcp-archive#32, counted on built tools since #67)
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

// Hard ceiling on the LOGICAL size of everything a dereferencer hands out:
// the node count of the output read as a tree, i.e. every shared $ref target
// counted once per place it occurs. Unique allocations are bounded by
// SPEC_BUDGETS.maxSchemaNodes; this bounds what consumers that walk the
// output as a tree (schema conversion, JSON Schema emission, serialization)
// can be made to do. 2^40 occurrences of a 40-level "billion laughs" chain
// are refused from the memoized sizes alone, without walking anything. The
// $ref cycle check (refs.ts) walks at most this many nodes as well.
export const MAX_EXPANDED_NODES = 10_000_000;

export type SpecBudgets = typeof SPEC_BUDGETS;

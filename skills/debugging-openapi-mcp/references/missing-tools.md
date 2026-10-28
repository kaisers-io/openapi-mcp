# Tools are missing or unexpected

`CLI --json tools` with the entry's spec and filter options lists every operation that is not a
tool under `notExposed`, with its `decision` and `reason`. `CLI --json check` adds the tool mode
and the tools the host lists. Details:
[docs/filtering.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/filtering.md#how-a-decision-is-made).

Compare first: count the operations the user expects (their config, or what they say the agent
should do) and the tools in `data.tools`. Name each missing or extra operation with the row
below that explains it, and propose the fix.

| Evidence | Cause | Fix |
|---|---|---|
| `decision: read-only-default` | no `--allow`, so only reads are exposed | `--allow` for each operation the user wants, plus the reads |
| `decision: not-allowed` | `--allow` is given and no pattern matches it | add a pattern for it |
| `decision: denied`, `pattern` names the `--deny` | a deny matches it | narrow that deny |
| `decision: omitted`, with `omittableParameters` | only optional parameters the server cannot send keep it out (Stripe's `expand`, a `deepObject` array) | propose `--omit-unsupported-parameters "operationId:<id>"`; name the parameters the agent then cannot set, and add it only if the user agrees |
| `decision: omitted`, without `omittableParameters` | the operation uses something not supported | explain the reason; the spec needs a change (overlay) |
| a tool's `leftOutParameters` | `--omit-unsupported-parameters` built it without them | expected; the agent cannot set them |
| `decision: withheld` | a refreshed spec waits as a candidate and removed it | ask the user to review it: `openapi-mcp cache promote` |
| `decision: head-without-get` | a `HEAD` whose every URL also matches a `GET` that is not exposed; its calls would be refused | allow the `GET` too, or leave it out |
| `deadPatterns` | a pattern matches nothing | use the suggestion |
| `check` reports `toolMode: discover` | the host lists four tools, not one per operation | expected; or `--tool-mode per-operation` if the user wants one tool each |
| the host lists the first tools only | `--tools-page-size` and a host that ignores `nextCursor` | remove `--tools-page-size` |
| Codex `enabled_tools`, Gemini `includeTools` | the host hides tools | adjust the host setting (host file) |
| the CLI lists the tool, the host does not | the host was not restarted, or the server failed | host status (host file) |
| old tools after a spec change | `cacheStatus: candidate` | the user reviews and promotes the candidate |

Since 0.5.0 every selector ignores letter case and `*` in `operationId:`, `name:` and `tag:`
matches `/`. A pattern written for an older version can expose or exclude more than before.
Run `tools` with the old and the new version and compare the tool names.

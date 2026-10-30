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
| `decision: omitted`, reason `has a control or bidirectional-override character` | a parameter or property name, `enum`, `const`, `pattern` or `format` holds such a character | the spec needs a change; tell the user, the text may try to mislead the agent |
| `decision: omitted`, without `omittableParameters` | the operation uses something not supported | explain the reason; the spec needs a change (overlay) |
| a tool's `leftOutParameters` | `--omit-unsupported-parameters` built it without them | expected; the agent cannot set them |
| `decision: withheld` | a refreshed spec waits as a candidate and removed it | ask the user to review it: `openapi-mcp cache promote` |
| `decision: head-without-get` | a `HEAD` whose every URL also matches a `GET` that is not exposed; its calls would be refused | allow the `GET` too, or leave it out |
| `deadPatterns` | a pattern matches nothing | use the suggestion |
| `check` reports `toolMode: discover` | the host lists five tools (four with `--no-execute`), not one per operation | expected; or `--tool-mode per-operation` if the user wants one tool each |
| the host lists the first tools only | `--tools-page-size` and a host that ignores `nextCursor` | remove `--tools-page-size` |
| Codex `enabled_tools`, Gemini `includeTools` | the host hides tools | adjust the host setting (host file) |
| the CLI lists the tool, the host does not | the host was not restarted, or the server failed | host status (host file) |
| old tools after a spec change | `cacheStatus: candidate` | the user reviews and promotes the candidate |
| `spec refresh failed, serving the last known good accepted baseline` | the refresh failed; with `exceeds the 67108864-byte persisted-document budget`, the new spec is over 64 MiB | fix the cause it names; a spec that large does not update |

## Warnings that name operations

`serve`, `check` and `tools` print these on stderr. `--strict-filters` turns the first five into
errors (exit 3).

| Warning | Cause | Fix |
|---|---|---|
| `--allow "..." matches no operation`, `; closest: ...` | a typo, or an operation the spec does not have | use the suggestion |
| `it names only operations that are omitted as not supported`, `filtered out or omitted` | the pattern is right, but the operation is not a tool | the operation's `notExposed` row says why |
| `matches values that differ only by case` | case-insensitive matching joins two spellings | a pattern that names the one meant |
| `which is not exposed, is refused; review --allow, --deny and the spec` | an exposed path can match the same URL as an excluded one; such calls fail | allow both, or narrow the exposed one |
| `the check for overlapping paths ran out of its work budget` | the overlap list is incomplete | narrower patterns |
| `operations not exposed:` | counts per decision | `CLI --json tools` lists each one |
| `omitted` with a method and path | the reason follows the path; see below | as the reason says |
| `operations are omitted only for optional parameters this server cannot send` | `--omit-unsupported-parameters` would build them | the `omitted` row with `omittableParameters` above |
| `out optional parameters the agent cannot set` | the flag built them without those parameters | expected; tell the user which |
| `--omit-output-schema: response-schema validation is off for` | the flag is set for those tools | expected |
| `matches only tools without an output schema`, `so it changes nothing` | an opt-out pattern with no effect | remove it |

## Omission reasons

The `reason` of `decision: omitted` names what the server cannot handle. The spec needs a change
(an overlay, `docs/overlays.md`), or the user accepts the gap.

| Reason contains | What it means |
|---|---|
| `callbacks are not supported`, `webhooks are not supported`, `servers overrides are not supported` | features the server does not serve |
| `operations are never exposed` | `OPTIONS`, `TRACE`, `CONNECT` and `TRACK` never become tools |
| `cookie parameters are not supported` | a parameter `in: cookie` keeps the operation out |
| `uses allowReserved`, `uses content instead of schema`, `uses the unsupported style`, `deepObject requires` | a parameter form the server cannot send; often fixable with `--omit-unsupported-parameters` when optional |
| `the request body has no JSON, form-urlencoded, multipart/form-data or application/octet-stream content`, `with no deterministic choice`, `encoding object is not supported` | a body media type or form the server cannot build |
| `the unsupported keyword`, `a malformed`, `combined with`, `an enum with`, `an allOf`, `schema nesting exceeds the depth budget` | a schema the input validator cannot represent |
| `the path template has`, `placeholders do not match its path parameters`, `Path Item $ref chain` | a broken path or path item |
| `a name or value in the input schema has a control or bidirectional-override character` | text that could mislead the agent; tell the user |

A tool built with `--omit-unsupported-parameters` says
`[Parameters not available here: ...]` in its description.

Since 0.5.0 every selector ignores letter case and `*` in `operationId:`, `name:` and `tag:`
matches `/`. A pattern written for an older version can expose or exclude more than before.
Run `tools` with the old and the new version and compare the tool names.

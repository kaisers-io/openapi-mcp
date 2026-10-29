# Tool modes

How the host sees the exposed operations. Details:
[docs/tool-modes.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/tool-modes.md).

| Mode | The host lists | Use when |
|---|---|---|
| `per-operation` (default) | one tool per operation, plus `openapi_mcp_status` and `execute_code` | up to about 64 operations; each write needs its own approval |
| `discover` | `search_operations`, `describe_operation`, `call_operation`, `execute_code`, `openapi_mcp_status` | many operations; the agent searches for the one it needs |
| `auto` | `discover` above 64 exposed operations or 40,000 bytes of tool definitions, otherwise `per-operation` | the size is unknown or changes |

`per-operation` allows at most 512 tools. `discover` allows up to 4,096 operations.

## The approval trade-off

Under `discover`, the host approves `call_operation` once for every exposed operation. A user
who clicks "always allow" for it allows every exposed write. Recommend:

- read-only access: `auto`
- writes the user wants to approve one by one: `per-operation`, with the allowed operations
  narrowed until they fit
- many writes the user approves as a whole: `discover`, after saying the above

`CLI --json check` reports the mode `auto` picks and why (`toolModeReason` is `count` or
`size`). Show it to the user.

## Scripts: `execute_code`

Every mode lists `execute_code`. With it, the agent writes a short JavaScript program that
calls several read-only operations and gets back only the program's result. Details:
[docs/tool-modes.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/tool-modes.md#scripts-execute_code).

Keep it on. In every measurement, on a test API, GitHub and PokeAPI, both agents answered as
correctly with it and needed fewer tool calls, and one agent's cost fell by 20% to 80%. The
gain is largest when the agent pages through lists, follows ids from one operation or API to
another, counts or sums.

Tell the user three things:

- A program calls reads only. Writes still go through their own tool call and approval.
- Every call inside a program goes through the same filters, rate limit and redaction as a
  direct call.
- A program can make at most 50 calls and runs at most 30 s. Every call counts against
  `--rate-limit` (120 a minute by default), so propose a higher limit when the agent will read
  hundreds of items one by one.

Propose `--no-execute` only when the API changes data on `GET`, or when the user wants exactly
one tool per operation.

## Smaller tool definitions

The size `auto` measures counts tool names, descriptions and input schemas. Fewer exposed
operations lower it; nothing else does.

Output schemas are listed too, outside that measure. Under `per-operation` they can be most of
`tools/list`; `--output-schema defs` writes repeated parts once, and
`--no-output-schema-descriptions` drops their field descriptions. Both keep validation
unchanged.

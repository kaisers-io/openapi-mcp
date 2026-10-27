# Tool modes

How the host sees the exposed operations. Details:
[docs/configuration.md, Tool modes](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/configuration.md#tool-modes).

| Mode | The host lists | Use when |
|---|---|---|
| `per-operation` (default) | one tool per operation, plus `openapi_mcp_status` | up to about 64 operations; each write needs its own approval |
| `discover` | `search_operations`, `describe_operation`, `call_operation`, `openapi_mcp_status` | many operations; the agent searches for the one it needs |
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

## Smaller tool definitions

When the definitions are large and the user keeps `per-operation`:

- `--output-schema defs` writes repeated schema parts once
- `--no-output-schema-descriptions` drops field descriptions from output schemas

Both keep validation unchanged. Recommend them only when `check` shows `size` as the reason.

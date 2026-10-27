# Claude Code

Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

## Where the entry goes

| Scope | File | Applies to |
|---|---|---|
| project | `.mcp.json` in the repository root | everyone who uses the repository |
| local (default of `claude mcp add`) | `~/.claude.json`, under the project | this user, this project |
| user | `~/.claude.json`, top level | this user, every project |

The first scope that has a server of that name wins: local, then project, then user. Entries
are not merged. Recommend project scope for a team, local scope for a personal setup.

## Entry

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--header-env", "Authorization=SHOP_API_TOKEN"],
      "env": { "SHOP_API_TOKEN": "${SHOP_API_TOKEN}" }
    }
  }
}
```

- Claude Code expands `${VAR}` and `${VAR:-default}` in `command`, `args` and `env`. An unset
  variable without a default stays as the literal text `${VAR}`, and `claude mcp list` warns.
- With a start script that loads the credentials, `command` is the script's absolute path, `args`
  is empty and `env` is left out.
- To write it with the CLI: `claude mcp add-json --scope project shop '<the inner object>'`.
- Windows: `"command": "cmd"`, `"args": ["/d", "/c", "npx", ...]`.

## Status

- `claude mcp list` and `claude mcp get shop` in a terminal, `/mcp` in a session.
- Connected: it works. Failed: the server exited or timed out; `claude mcp get shop` shows the
  reason. Needs authentication: not used by `openapi-mcp` over stdio.
- Pending approval: a project server waits for the user to approve it in an interactive
  session. `claude mcp reset-project-choices` asks again after a rejection.
- Tools appear as `mcp__shop__<tool>`.

## Logs and timeouts

- `claude --debug=mcp` prints MCP connection details, including the server's stderr.
- On macOS, each server's log is under `~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-shop/`.
- `MCP_TIMEOUT` (milliseconds) raises the startup timeout, for example `MCP_TIMEOUT=60000 claude`.
- Output over 25,000 tokens is cut; `MAX_MCP_OUTPUT_TOKENS` raises the limit.

After a change to the entry, run `/mcp` and reconnect, or restart Claude Code.

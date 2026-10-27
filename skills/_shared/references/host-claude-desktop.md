# Claude Desktop

Source: [MCP quickstart for Claude Desktop](https://modelcontextprotocol.io/quickstart/user),
[MCP debugging](https://modelcontextprotocol.io/docs/tools/debugging).

## Where the entry goes

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Settings, Developer, Edit Config opens the file.

## Entry

```json
{
  "mcpServers": {
    "shop": {
      "command": "/Users/<name>/.config/openapi-mcp/shop.sh",
      "args": []
    }
  }
}
```

Claude Desktop starts from the Dock or the Start menu and does not load the shell profile, so
variables exported in `~/.zshrc` do not reach the server, and its `PATH` may not contain `node`.
Use a start script that loads the credentials, sets `PATH` and starts the CLI as `command`.
Without credentials, `command` can be the absolute path of `npx` next to `node` with the usual
`args`, plus a `PATH` that holds that directory, since `npx` starts `node` through `PATH`:

```json
"env": { "PATH": "/Users/<name>/.nvm/versions/node/v24.11.0/bin:/usr/bin:/bin" }
```

Take the directory from `dirname "$(node -p process.execPath)"`; `command -v node` can name a
version manager's shim that only works in its shell.

## Status and logs

- Quit Claude Desktop completely and open it again after every change.
- The tools appear in the tools menu of a new chat.
- macOS logs: `~/Library/Logs/Claude/mcp.log` and `mcp-server-shop.log`.
- Windows logs: `%APPDATA%\Claude\logs\`.

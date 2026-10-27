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
variables exported in `~/.zshrc` do not reach the server. Use a start script that loads the credentials and starts the CLI as `command`. Without credentials, `command` can be the absolute path of `npx` (from
`command -v npx`) with the usual `args`.

## Status and logs

- Quit Claude Desktop completely and open it again after every change.
- The tools appear in the tools menu of a new chat.
- macOS logs: `~/Library/Logs/Claude/mcp.log` and `mcp-server-shop.log`.
- Windows logs: `%APPDATA%\Claude\logs\`.

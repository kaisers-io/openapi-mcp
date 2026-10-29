# VS Code

Source: [VS Code MCP configuration](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

## Where the entry goes

- `.vscode/mcp.json` in a workspace
- the user profile's `mcp.json`: run the command "MCP: Open User Configuration"

The key is `servers`, not `mcpServers`.

## Entry

```json
{
  "inputs": [
    { "type": "promptString", "id": "shop-token", "description": "Shop API token, starting with Bearer", "password": true }
  ],
  "servers": {
    "shop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--base-url", "https://shop.example.test", "--header-env", "Authorization=SHOP_API_TOKEN"],
      "env": { "SHOP_API_TOKEN": "${input:shop-token}" }
    }
  }
}
```

- `inputs` with `"password": true` asks once and VS Code stores the value. The value never
  appears in the file. Recommend this in VS Code.
- `${env:NAME}` reads a variable of the VS Code process; `envFile` loads a file.
- Some agent modes do not start servers that need `${input:...}`. If the server does not
  start there, use `envFile` or a start script that loads the credentials and starts the CLI.
- Windows: `"command": "cmd"`, `"args": ["/d", "/c", "npx", ...]`.

## Status and logs

- "MCP: List Servers" shows each server; "Show Output" opens its log.
- After a change, restart the server from that list.

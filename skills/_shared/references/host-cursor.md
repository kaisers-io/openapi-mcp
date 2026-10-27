# Cursor

Source: [Cursor MCP docs](https://cursor.com/docs/context/mcp).

## Where the entry goes

- `.cursor/mcp.json` in a project
- `~/.cursor/mcp.json` for every project

## Entry

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--header-env", "Authorization=SHOP_API_TOKEN"],
      "env": { "SHOP_API_TOKEN": "${env:SHOP_API_TOKEN}" }
    }
  }
}
```

- Cursor expands `${env:NAME}` in `command`, `args`, `env`, `url` and `headers`.
- `"envFile": "/absolute/path/shop.env"` loads variables from a file for stdio servers. The file
  must not be in the repository.
- Cursor started from the Dock may not have the shell's variables or `PATH`. Use a start script that loads the credentials and starts the CLI as `command` then.
- Windows: `"command": "cmd"`, `"args": ["/c", "npx", ...]`.

## Status

Cursor Settings, MCP lists each server with its state and tools. After a change, turn the
server off and on there, or restart Cursor.

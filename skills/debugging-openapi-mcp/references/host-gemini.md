# Gemini CLI

Source: [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/).

## Where the entry goes

- `.gemini/settings.json` in a project
- `~/.gemini/settings.json` for every project

## Entry

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--base-url", "https://shop.example.test", "--header-env", "Authorization=SHOP_API_TOKEN"],
      "env": { "SHOP_API_TOKEN": "$SHOP_API_TOKEN" },
      "timeout": 60000
    }
  }
}
```

- Gemini CLI removes inherited variables whose names contain `TOKEN`, `KEY`, `SECRET`,
  `PASSWORD`, `AUTH` or `CREDENTIAL` before it starts a server. Name every credential variable
  in `env`, as above, or it arrives empty.
- `$VAR` and `${VAR}` are expanded in `env`; an unset variable becomes an empty string.
- `includeTools` and `excludeTools` act on the listed tools. Restrict operations with
  `--allow` and `--deny` instead.

## Status

`/mcp` in a session lists each server with its state and tools; `gemini mcp list` does the same
in a terminal. Restart Gemini CLI after a change.

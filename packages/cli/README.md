# openapi-mcp

**Turn any OpenAPI spec into a strict, locally running MCP server.**

`openapi-mcp` is a runtime wrapper — no code generation, no deployment. Point it at an
OpenAPI 3.0/3.1 spec (URL or file) and every allowed operation becomes a validated
[MCP](https://modelcontextprotocol.io) tool for hosts like Claude Code and Codex. It is
read-only by default (only `GET`/`HEAD` operations, unless you pass `--allow`), reads secrets
only from environment variables, and never applies a refreshed spec silently.

> **Trust the spec source.** This tool interprets the OpenAPI document you give it at
> runtime, and that document's text flows into the model's context. A hostile spec is an
> injection surface — only point `openapi-mcp` at a spec source you trust.

## Install

```bash
npm i -g @kaisers-io/openapi-mcp
```

Requirements: Node.js `>=24.0`, macOS or Linux.

## Quick start

Claude Code (`.mcp.json`, expands `${VAR}` — export `SPEC_TOKEN`/`API_TOKEN` first):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.2.0",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json",
        "--spec-header-env",
        "Authorization=SPEC_TOKEN",
        "--header-env",
        "Authorization=API_TOKEN",
        "--allow",
        "read*",
        "--cache-key",
        "petstore"
      ],
      "env": { "SPEC_TOKEN": "${SPEC_TOKEN}", "API_TOKEN": "${API_TOKEN}" }
    }
  }
}
```

Codex CLI (`config.toml`, no `${VAR}` expansion — export the secrets in your shell and
whitelist them with `env_vars`):

<!-- prettier-ignore -->
```toml
[mcp_servers.petstore]
command = "npx"
args = [
  "-y", "@kaisers-io/openapi-mcp@0.2.0", "serve",
  "--spec", "https://api.example.com/openapi.json",
  "--spec-header-env", "Authorization=SPEC_TOKEN",
  "--header-env", "Authorization=API_TOKEN",
  "--allow", "read*",
  "--cache-key", "petstore",
]
env_vars = ["SPEC_TOKEN", "API_TOKEN"]
```

Host config examples always pin an exact version, never `latest` — this process runs with
your API credentials on every launch.

Full documentation, security model, and configuration reference:
https://github.com/kaisers-io/openapi-mcp

## License

MIT

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
openapi-mcp --version
openapi-mcp tools --spec https://api.example.com/openapi.json   # preview the tools, no server
```

Requirements: Node.js `^22.19.0 || >=24.11.0`, macOS, Linux or Windows. Use the latest patch release of your Node line:
older patches miss its security fixes. On Windows the cache directories are private through your user profile's
access control list (owner, SYSTEM, Administrators), not through `0700`/`0600` modes. Other
platforms (e.g. FreeBSD) are refused because they are untested, not because they are known to be unsafe.

The first run per user writes Node's compile cache to `~/.kaisers-io/openapi-mcp/compile-cache/`
and is slower; `NODE_DISABLE_COMPILE_CACHE=1` turns it off.

## Quick start

Claude Code (`.mcp.json`, expands `${VAR}` — export `SPEC_TOKEN`/`API_TOKEN` first):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.4.0",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json",
        "--spec-header-env",
        "Authorization=SPEC_TOKEN",
        "--header-env",
        "Authorization=API_TOKEN",
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
  "-y", "@kaisers-io/openapi-mcp@0.4.0", "serve",
  "--spec", "https://api.example.com/openapi.json",
  "--spec-header-env", "Authorization=SPEC_TOKEN",
  "--header-env", "Authorization=API_TOKEN",
  "--cache-key", "petstore",
]
env_vars = ["SPEC_TOKEN", "API_TOKEN"]
```

Windows: `npx` is a `.cmd` script. Hosts that resolve it (Claude Desktop) take the config
above unchanged; a host that spawns commands without a shell fails with `ENOENT`/`EINVAL` or
"client closed" — use `"command": "cmd"` with `"args": ["/c", "npx", "-y", ...]` there, keep
`& | < > ^ %` out of the arguments, and double backslashes in JSON paths
(`"C:\\specs\\petstore.json"`).

Host config examples always pin an exact version, never `latest` — this process runs with
your API credentials on every launch. `--cache-key` is required when the spec fetch is
authenticated (`--spec-header-env`), unless you pass `--trust-spec-updates`.

## Defaults

- **Read-only:** with no `--allow`, only `GET`/`HEAD` operations become tools. `--allow`/`--deny`
  take operationId globs (`list*`), `METHOD /path` globs (`GET /users/**`) and `tag:<glob>`;
  `--deny` always wins, and any `--allow` replaces the read-only default.
- **Tool names** are the operationId reduced to `[A-Za-z0-9_-]` (at most 64 characters), or
  method and path when there is no usable operationId (`get_users_by_id`). Filters match the
  raw operationId, not the tool name.
- **Secrets** come only from environment variables (`--header-env Header=ENV`,
  `--spec-header-env`, `--http-token-env`, `--upstream-oauth-client-*-env`) and are redacted
  from every output.
- **Egress:** an address from the spec (its `servers` URL) or from a redirect is refused when
  private, loopback or cloud metadata; `--allow-private-network` permits the first two.
- **Spec updates** fetched at runtime wait for `openapi-mcp cache promote` (or
  `--trust-spec-updates` for specs you own).
- **Transport:** stdio. `--http` serves Streamable HTTP on `127.0.0.1:3044` and requires
  `--http-token-env` (32 random bytes, e.g. `openssl rand -base64 32`). `--http-auth oauth`
  turns it into an OAuth resource server that may bind another `--http-host`.
- **Trace propagation is on:** a W3C `traceparent` from a call's `_meta` is forwarded
  upstream; pass `--no-trace-propagation` for APIs you do not operate.

## Options worth knowing

- `--tool-mode discover` (or `auto`, above 64 operations): three tools — `search_operations`,
  `describe_operation`, `call_operation` — instead of one tool per operation, so `tools/list`
  stays under 5 KB for large APIs.
- `--request-timeout` (default `30s`), `--max-concurrency` (default `16`), `--rate-limit`
  (default `120/1m`), `--max-response-bytes` (default `10MB`).
- `--retries <n>` (default `0`): retries transient failures; `POST`/`PATCH` only with an
  `Idempotency-Key` header.
- `--log json`, `--response-projection` (`_fields`), `--tools-page-size` (only for hosts that
  follow `nextCursor`), `--strict-filters`, `--upstream-oauth-*` (client credentials).
- `openapi-mcp cache list|refresh|promote|clear|unlock` manages the spec cache;
  `openapi-mcp doctor` prints versions and the cache root.

Every flag and its default: `openapi-mcp <command> --help`.

## License

MIT

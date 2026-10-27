# The server does not start

Read the `check` output first: `environment` lists every variable, `startup` the first error.
`serve` writes the same errors to stderr, which the host log shows. Exit codes: 2 usage,
3 validation, 4 not found, 5 conflict. Details:
[docs/configuration.md, Exit codes](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/configuration.md#exit-codes).

## Host side

| Evidence | Cause | Fix |
|---|---|---|
| `Executable not found`, `ENOENT`, `command not found` | the host cannot find `npx`; GUI apps often lack the terminal's `PATH` | absolute path from `command -v npx` |
| `EINVAL` or "client closed" on Windows | `npx` is a `.cmd` file | `"command": "cmd"`, `"args": ["/c", "npx", ...]` |
| `requires Node` | Node below 22.19, or 23 | install Node 24, then point the host at it |
| timeout on the first start | `npx` downloads the package | raise the host's startup timeout (host file); start once by hand to fill the cache |
| `MCP error -32000: Connection closed` | the process exited before the handshake | run `check`; its error is the reason |
| Claude Code: Pending approval | a project server waits for approval | approve it in `/mcp` |
| Codex: variable missing, but set in the shell | not in `env_vars` | add the name to `env_vars`, restart Codex |
| Gemini CLI: variable empty | Gemini removes `*TOKEN*`, `*KEY*` and similar | name it in `env` |
| Claude Desktop: variable missing | the app does not read the shell profile | start script as `command` |

## Server side

| `check` or stderr says | Cause | Fix |
|---|---|---|
| `environment variable "X" (for header "H") is not set or empty` | the variable does not reach the server | see the host rows above |
| `cannot read spec file` | wrong path, or relative to another working directory | absolute path |
| `spec fetch failed with HTTP 401` or `403` | the spec URL needs a credential | `--spec-header-env Authorization=VAR` and a `--cache-key` |
| `spec fetch timed out` | slow or unreachable URL | check the URL in a browser; raise `--timeout` only for a slow spec |
| `is neither valid JSON ... nor valid YAML`, `failed OpenAPI ... schema validation` | the URL serves a web page or a broken spec | find the JSON or YAML document |
| `OpenAPI 2.0 (swagger) documents are not supported` | Swagger 2.0 | convert it to OpenAPI 3 first |
| `external $ref "..." is not supported` | the spec spans several files | bundle it into one file first |
| `has no absolute server URL ... pass --base-url` | no usable `servers` entry | `--base-url https://...` |
| `an authenticated spec source ... requires an explicit cache decision` | `--spec-header-env` without a cache key | `--cache-key <name>` |
| `N tools would be exposed ... exceeds the 512-tool budget` | too many operations for `per-operation` | narrow `--allow`, or `--tool-mode discover` |
| `matches no operation` under `--strict-filters` | a pattern names nothing | fix the pattern with the suggestion it prints |
| `a filter pattern needs a selector; write ...` | a pattern from before 0.5.0 | apply the replacement it names |
| `the OAuth token URL is refused` | token URL private or not allowed | check the URL with the user |
| `is not allowed by the egress policy`, private address | the API is on a private network | `--allow-private-network`, only after the user confirms the address is theirs |
| `the spec cache entry is unusable`, `is locked by another openapi-mcp process` | damaged cache, or another process holds its lock | ask the user; `openapi-mcp cache list`, then `cache unlock` or `cache clear` for that entry |

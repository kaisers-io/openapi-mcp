# Configuration reference

Every flag `openapi-mcp` accepts, grouped by command, with its meaning, default, and an
example. This is the exhaustive reference; `README.md` links here instead of repeating it.
Nothing here should ever drift from the CLI's own `--help` — if in doubt, run
`openapi-mcp --help` or `openapi-mcp <command> --help`; that output is authoritative.

There is no separate `openapi-mcp` config file. All configuration is CLI flags and
environment variables, resolved through your MCP host's own config
(`.mcp.json` for Claude Code, `config.toml` for Codex). `~/.kaisers-io/openapi-mcp/` holds
only the on-disk spec cache.

## Grammars

Two flag value shapes are used across commands:

- **Duration** (`--timeout`, `--ttl`): `<int><s|m|h|d>` — an integer immediately followed by
  one unit letter, e.g. `30s`, `5m`, `1h`, `2d`. No other units, no decimals, no spaces.
- **Size** (`--max-response-bytes`): `<int><B|KB|MB>` or a plain integer byte count, e.g.
  `10MB`, `512KB`, `2048B`, or `2048` (bytes, unit omitted).

## Global options

Apply to every command (`openapi-mcp <command> [flags]`):

| Flag | Meaning | Default |
|---|---|---|
| `-V, --version` | print the CLI version | — |
| `--json` | machine-readable JSON output envelope | off (human-readable) |
| `--verbose` | include stack traces and debug detail on stderr | off |
| `-h, --help` | display help for the command | — |

Example:

```bash
openapi-mcp --json doctor
```

## `serve`

Start an MCP server (stdio by default) exposing tools generated from an OpenAPI spec.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--spec <url\|file>` | no | OpenAPI spec source, JSON or YAML | required |
| `--allow <pattern>` | yes | whitelist pattern | `[]` (read-only default applies) |
| `--deny <pattern>` | yes | blacklist pattern, always wins | `[]` |
| `--strict-filters` | no | exit with an error instead of a warning on dead patterns | off |
| `--spec-header-env <Header=ENV>` | yes | auth header for the spec fetch, value read from env | `[]` |
| `--timeout <duration>` | no | spec fetch timeout | `30s` |
| `--ttl <duration>` | no | spec refresh interval | `1h` |
| `--cache-key <name>` | no | durable cache namespace label; required for authenticated specs (see below) | none |
| `--trust-spec-updates` | no | auto-accept refreshed specs instead of gating them | off |
| `--allow-private-network` | no | permit private/loopback redirect targets during the spec fetch (never cloud-metadata) | off |
| `--base-url <url>` | no | override the spec-derived base URL for API requests | `servers[0]` from spec |
| `--header-env <Header=ENV>` | yes | API auth header, value read from env (secret) | `[]` |
| `--header <Header:value>` | yes | static, non-secret API header | `[]` |
| `--max-response-bytes <size>` | no | cap the decompressed upstream response body **and** the outgoing request body (see below) | `10MB` |
| `--allow-insecure-http` | no | permit an operator credential (`--header-env`) over cleartext http to a non-loopback origin | off |
| `--http` | no | serve over Streamable HTTP (127.0.0.1 only) instead of stdio | off (stdio) |
| `--port <n>` | no | HTTP port | `3044` |
| `--http-token-env <ENV>` | no | env var holding the bearer token required for HTTP requests; mandatory with `--http` | none |

Notes:

- `--header` uses `Header:value` (**colon**). `--header-env` and `--spec-header-env` use
  `Header=ENV` (**equals**) — the right-hand side is an environment variable *name*, not a
  literal value.
- `--max-response-bytes` also caps every outgoing request body, measured after encoding
  (for an `application/octet-stream` upload: the decoded bytes). The base64 tool argument
  that carries an upload is about 4/3 of that size inside the JSON-RPC message.
- `--cache-key` is required for any spec fetched with `--spec-header-env` (an authenticated
  spec), unless `--trust-spec-updates` is also passed. Providing neither is a startup usage
  error.

Example:

```bash
openapi-mcp serve \
  --spec https://api.example.com/openapi.json \
  --spec-header-env Authorization=SPEC_TOKEN \
  --header-env Authorization=API_TOKEN \
  --allow "read*" --allow "tag:orders" \
  --deny "delete*" \
  --cache-key petstore-prod \
  --ttl 1h \
  --timeout 30s \
  --max-response-bytes 10MB
```

HTTP-mode example:

```bash
export TOKEN=$(openssl rand -base64 32)
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

## `tools`

Preview the operation inventory an OpenAPI spec generates, with filters applied — no server
is started. Shares the spec-loading and filtering flags with `serve`; it has none of the
API-request or transport flags (no `--base-url`, `--header*`, `--max-response-bytes`,
`--allow-insecure-http`, `--http*`), since no API requests are ever made.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--spec <url\|file>` | no | OpenAPI spec source, JSON or YAML | required |
| `--allow <pattern>` | yes | whitelist pattern | `[]` (read-only default applies) |
| `--deny <pattern>` | yes | blacklist pattern, always wins | `[]` |
| `--strict-filters` | no | exit with an error instead of a warning on dead patterns | off |
| `--spec-header-env <Header=ENV>` | yes | auth header for the spec fetch, value read from env | `[]` |
| `--timeout <duration>` | no | spec fetch timeout | `30s` |
| `--ttl <duration>` | no | spec refresh interval | `1h` |
| `--cache-key <name>` | no | durable cache namespace label; required for authenticated specs | none |
| `--trust-spec-updates` | no | auto-accept refreshed specs instead of gating them | off |
| `--allow-private-network` | no | permit private/loopback redirect targets during the spec fetch (never cloud-metadata) | off |

Example:

```bash
openapi-mcp tools --spec https://api.example.com/openapi.json --allow "read*"
```

### Query parameter styles

Query parameters support the OAS 3.1.1 §4.8.12.4 styles that the spec defines for their
shape. An operation that uses an undefined combination is listed as omitted, with the reason:

- `form` (the default), with or without `explode`.
- `deepObject` needs `explode: true` **set explicitly**. `explode` defaults to `true` only
  for `form`, so a spec that leaves it out on a `deepObject` parameter has that operation
  omitted (Stripe-style specs often do). The value must be an object of scalars. At call
  time a key containing `[` or `]` is rejected, because it would read as nesting
  (`filter[a][b]`) on the server.
- `spaceDelimited` and `pipeDelimited` need `explode: false` (the only defined form). The
  value is an array or an object of scalars. An item containing its own delimiter is
  rejected as ambiguous, and an empty array or object sends nothing, like `form`.

## `cache`

Inspect and manage the on-disk spec cache (`~/.kaisers-io/openapi-mcp/cache/`). Has no flags
of its own beyond `-h, --help`; all configuration is on its subcommands.

### `cache list`

List cache entries with their opaque entry ids. No options.

```bash
openapi-mcp cache list
```

### `cache clear`

Remove cache entries; requires an explicit target or `--all`.

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | clear the namespace for this spec source | none |
| `--id <entry-id>` | clear the namespace with this opaque entry id | none |
| `--cache-key <name>` | cache namespace label used with `--spec` | none |
| `--all` | remove every cache entry for this user | off |

Examples:

```bash
openapi-mcp cache clear --spec https://api.example.com/openapi.json --cache-key petstore-prod
openapi-mcp cache clear --id 3f1a9c2b7e4d1a90
openapi-mcp cache clear --all
```

### `cache refresh`

Force a refetch of a spec source, writing a candidate on change (does not activate it — see
[`docs/security.md`](security.md) and the README's [Caching & refresh](../README.md#caching--refresh)).

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | OpenAPI spec source, JSON or YAML | required |
| `--cache-key <name>` | cache namespace label | none |
| `--spec-header-env <Header=ENV>` | auth header for the spec fetch, value read from env (repeatable) | `[]` |
| `--timeout <duration>` | spec fetch timeout | `30s` |
| `--trust-spec-updates` | accept the refreshed spec directly instead of gating it | off |
| `--allow-private-network` | permit private/loopback redirect targets during the fetch | off |

```bash
openapi-mcp cache refresh --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

### `cache promote`

Accept the pending candidate spec as the new baseline.

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | OpenAPI spec source, JSON or YAML | required |
| `--cache-key <name>` | cache namespace label | none |
| `--hash <digest>` | pin the promotion to this candidate content hash | none |

```bash
openapi-mcp cache promote --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

### `cache unlock`

Remove a stale writer lock left behind by a process that died. Stop other `openapi-mcp`
processes on this entry first — removing a lock a live writer still holds re-admits a second
writer.

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | unlock the namespace for this spec source | none |
| `--id <entry-id>` | unlock the namespace with this opaque entry id | none |
| `--cache-key <name>` | cache namespace label used with `--spec` | none |
| `--force` | remove the lock even when it is not known to be stale | off |

```bash
openapi-mcp cache unlock --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

## `doctor`

Diagnostics: versions, cache root, effective configuration. Takes only the global options
(`--json`, `--verbose`, `-h/--help`) — **no `--spec` flag**.

```bash
openapi-mcp doctor
openapi-mcp --json doctor
```

`--json doctor` output shape:

```json
{
  "ok": true,
  "data": {
    "cliVersion": "0.3.1",
    "nodeVersion": "24.12.0",
    "appRoot": "/Users/you/.kaisers-io/openapi-mcp",
    "cacheRoot": "/Users/you/.kaisers-io/openapi-mcp/cache",
    "cacheRootExists": true
  },
  "warnings": []
}
```

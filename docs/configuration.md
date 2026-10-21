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

- **Duration** (`--timeout`, `--ttl`, `--request-timeout`): `<int><s|m|h|d>` — an integer immediately followed by
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
| `--max-response-bytes <size>` | no | cap the decompressed upstream response body | `10MB` |
| `--allow-insecure-http` | no | permit an operator credential (`--header-env`) over cleartext http to a non-loopback origin | off |
| `--request-timeout <duration>` | no | deadline for each upstream API request (independent of `--timeout`, which covers the spec fetch) | `30s` |
| `--max-concurrency <n>` | no | upstream calls in flight at once (1–256); further calls wait in a bounded FIFO queue | `16` |
| `--rate-limit <calls/duration>` | no | tool calls allowed per sliding window, e.g. `10/1s`, `600/1h` (calls 1–100000) | `120/1m` |
| `--http` | no | serve over Streamable HTTP (127.0.0.1 only) instead of stdio | off (stdio) |
| `--port <n>` | no | HTTP port | `3044` |
| `--http-token-env <ENV>` | no | env var holding the bearer token required for HTTP requests; mandatory with `--http` | none |

Notes:

- `--header` uses `Header:value` (**colon**). `--header-env` and `--spec-header-env` use
  `Header=ENV` (**equals**) — the right-hand side is an environment variable *name*, not a
  literal value.
- `--cache-key` is required for any spec fetched with `--spec-header-env` (an authenticated
  spec), unless `--trust-spec-updates` is also passed. Providing neither is a startup usage
  error.
- Concurrency and rate limits apply to the whole process (stdio and HTTP alike). A call that
  finds `--max-concurrency` calls already in flight waits for a slot, first come first served.
  At most 4 × `--max-concurrency` calls can wait, and each waits no longer than `--request-timeout`.
  A refused call returns a tool error whose text ends in `retry after <n>s`, and whose result
  `_meta` holds `"openapi-mcp/error"` and `"openapi-mcp/retryAfterMs"`. The error is
  `"overloaded"` with a fixed 1000 ms when the queue is full or the wait timed out. It is
  `"rate_limited"` when a call is over `--rate-limit`, and then `retryAfterMs` is exact: it is
  the time until the oldest call in the window expires. These details go in `_meta`, not
  `structuredContent`, because a tool's structured content must match its output schema.
  Both limits are always finite. There is no "unlimited" setting, because MCP servers must
  rate-limit tool calls.
- Upstream response headers: a fixed allowlist is forwarded into tool results. It covers
  `etag`, `last-modified`, `retry-after`, `x-total-count`, `x-ratelimit-*`, `ratelimit*`, and
  `location`. A `location` header is forwarded only when it points to the same origin as the
  base URL, and only as a path. Structured results carry these in the envelope's `headers`
  object. Text results get a trailing `headers:` block. `Set-Cookie` and authentication
  headers are never read. `Link` is not forwarded as a raw URL. A value that contains a
  configured secret is dropped. On a `429` or `503`, a valid `Retry-After` is also reported
  as `_meta["openapi-mcp/upstreamRetryAfterMs"]`.
- Pagination: a `GET` tool is paginated when it has a query parameter named `cursor`,
  `page_token`/`pageToken`, `after`, `starting_after`, `page`, `offset`, `limit`, `per_page`
  or `page_size`/`pageSize`, or when it declares a `Link` response header. For such a tool,
  each successful result carries `pagination.next`, the arguments for the next call, or
  `null` when no next page is known. A `Link: <…>; rel="next"` header is used only if it has
  the same origin and path as the request and all of its query parameters map onto the
  tool's own query parameters. Otherwise a body cursor is used: `next_cursor`/`nextCursor`
  maps to `cursor`, `next_page_token` to `page_token`, `nextPageToken` to `pageToken`, and
  Stripe-style `has_more` with the last item's `id` maps to `starting_after`. The hint never
  contains a raw URL.
- Memory: each in-flight call may buffer up to `--max-response-bytes` of decompressed body.
  While a JSON result is processed, the call briefly holds a few copies of it: the bytes, the
  decoded text, and the parsed value that the MCP SDK then serializes. Plan for roughly
  4 × `--max-response-bytes` per in-flight call, times `--max-concurrency` at worst
  (about 640 MB with the defaults of `10MB` and `16`). For a tool with an output schema, the
  text copy of a structured result is capped at 8 KB, with a `…[truncated]` marker. The full
  data is in `structuredContent`.

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

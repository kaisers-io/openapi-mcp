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
| `--request-timeout <duration>` | no | time budget for each upstream tool call, queue wait included (independent of `--timeout`, which covers the spec fetch) | `30s` |
| `--retries <n>` | no | retry a transient upstream failure up to `n` times (0–3), only for retry-safe requests (see below) | `0` |
| `--no-trace-propagation` | no | do not forward a call's W3C trace context (`_meta.traceparent`/`tracestate`) to the upstream API | forwarded |
| `--max-concurrency <n>` | no | upstream calls in flight at once (1–256); further calls wait in a bounded FIFO queue | `16` |
| `--rate-limit <calls/duration>` | no | tool calls allowed per sliding window, e.g. `10/1s`, `600/1h` (calls 1–100000) | `120/1m` |
| `--log <format>` | no | write one structured line per tool call to stderr; the only format is `json` | off |
| `--http` | no | serve over Streamable HTTP (127.0.0.1 only) instead of stdio | off (stdio) |
| `--port <n>` | no | HTTP port | `3044` |
| `--http-token-env <ENV>` | no | env var holding the bearer token required for HTTP requests; mandatory with `--http` | none |
| `--response-projection` | no | offer an optional `_fields` argument (JSON Pointers) on tools with a JSON response | off |
| `--tools-page-size <n>` | no | page `tools/list` with `n` tools per page (1–512); only for MCP hosts that follow `nextCursor` | off (all tools in one response) |

Notes:

- `--header` uses `Header:value` (**colon**). `--header-env` and `--spec-header-env` use
  `Header=ENV` (**equals**) — the right-hand side is an environment variable *name*, not a
  literal value.
- `--cache-key` is required for any spec fetched with `--spec-header-env` (an authenticated
  spec), unless `--trust-spec-updates` is also passed. Providing neither is a startup usage
  error.
- `--request-timeout` replaces `--timeout` for upstream API calls. **Upgrading:** if you raised
  `--timeout` to make slow API calls work, set `--request-timeout` instead; `--timeout` now
  covers only the spec fetch.
- `Accept` is derived from the operation's declared 2xx media types (JSON first, `*/*;q=0.1`
  last). A header parameter named `Accept` in the spec is ignored (OpenAPI says so), so an API
  that needs a vendor media type expressed only there (e.g. a GitHub preview
  `application/vnd.github.<preview>+json`) gets its default representation. Pass
  `--header Accept:<media type>` to override.
- Concurrency and rate limits apply to the whole process (stdio and HTTP alike). A call that
  finds `--max-concurrency` calls already in flight waits for a slot, first come first served.
  At most 4 × `--max-concurrency` calls can wait. The wait and the upstream request share one
  budget of `--request-timeout`: a call waits at most half of it for a slot, and its request
  gets what is left, so a tool call never takes longer than `--request-timeout` end-to-end
  (plus response processing). Keep `--request-timeout` below your MCP host's own `tools/call` timeout.
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
  `page_token`/`pageToken`, `after`, `starting_after` or `page`, or when it declares a `Link`
  response header. Size or position parameters alone (`limit`, `offset`, `per_page`,
  `page_size`) do not make it paginated. For such a tool, each successful result carries
  `pagination.next`: the arguments for the next call, including the call's other arguments.
  `null` means no next page is known: the last page, or the upstream gave no usable hint. It
  does not prove the data is exhausted (e.g. an `offset` API without a `Link` header). A
  `Link: <…>; rel="next"` header is used only if it has the same origin and the same
  (byte-identical) path as the request, and all of its query parameters map onto the tool's
  own query parameters. Values are decoded by the parameter's declared type and form style
  (booleans, numbers, comma-joined or repeated arrays). Otherwise a body cursor is used:
  `next_cursor`/`nextCursor` maps to `cursor`, `next_page_token` to `page_token`,
  `nextPageToken` to `pageToken`, and Stripe-style `has_more` with the last item's `id` maps to
  `starting_after`. A body cursor needs a structured result (an output schema), so a
  text-only result gets only the `Link` hint. A hint the tool's own input schema would reject
  becomes `null`. The hint never contains a raw URL.
- Retries (`--retries`, off by default): a failed upstream call is retried only for
  `GET`, `HEAD`, `PUT` and `DELETE` requests. A `POST` or `PATCH` is retried only when its
  operation declares an `Idempotency-Key` header. The server then sends one key, the
  caller's value or a generated UUID, on every attempt, and returns it as
  `_meta["openapi-mcp/idempotencyKey"]`: if the call still fails, repeat it with that key so
  the upstream can deduplicate. Only `429`, `502`, `503`, `504`, and connection errors that
  happen before any response arrived are retried. A `DELETE` is not retried after such a
  connection error: the upstream may already have deleted the resource, and the retry would
  then report `404`. Backoff is exponential with full jitter (250 ms base, 5 s cap), or the
  upstream's `Retry-After` on a `429` or `503`. Retries stay within `--request-timeout`, the
  call's concurrency slot and its single rate-limit charge. The slot is held during backoff,
  so under an upstream `Retry-After` storm queued calls wait (and may time out waiting for a
  slot) rather than add load.
- Trace context (**on by default**): when a `tools/call` carries a valid W3C `traceparent`
  (and optionally `tracestate`) in `_meta`, it is sent to the upstream as the same-named
  headers, on same-origin hops only. An invalid value is dropped; a higher `traceparent`
  version is read by the version-00 layout and forwarded as `00`. Tool arguments can never
  set these headers. This gives the upstream a correlation ID across calls and sessions,
  which is what you want for an API you operate. For a third-party API you do not operate,
  pass `--no-trace-propagation`.
- `tools/list` paging is off by default: every tool comes in one response (the spec budget
  caps a spec at 512 tools). Several MCP hosts call `tools/list` once and never follow
  `nextCursor`, so paging would silently hide every tool after the first page there. Set
  `--tools-page-size <n>` only when your host follows `nextCursor`. A cursor is bound to the
  served spec; a cursor from another spec version is rejected with Invalid Params.
- Call log (`--log json`, off by default): one JSON line per tool call goes to stderr,
  never stdout. Each line has `ts`, `event: "tool_call"`, `tool`, `method`, `pathTemplate`,
  `status`, `outcome`, `latencyMs`, `responseBytes`, `queuedMs`, `upstreamMs` and `attempts`.
  `outcome` is one of `ok`, `http_error`, `response_error`, `secret_withheld` (the upstream
  answered, but the result contained a configured secret and the client got an error),
  `validation_error` (bad arguments), `refused` (local policy: the cleartext credential gate
  or the outbound size budget), `rate_limited`, `overloaded`, `egress_denied`, `timeout`,
  `cancelled`, `network_error` or `internal_error`. `upstreamMs` runs from the first request
  to the final outcome, so with `--retries` it includes every attempt and the backoff or
  `Retry-After` waits between them; `attempts` says how many requests were sent. Arguments,
  header values, filled URLs and bodies are never logged, and every string is redacted.
  Whether or not `--log` is set, `openapi_mcp_status` reports process-local counters under
  `calls`: the total, counts by outcome, and p50/p95 of `upstreamMs` over the last 512 calls.
  These counters are visible to every client of the server: over `--http` with several
  clients, each one sees the aggregate counts of all of them (counts only, no content).
- Response projection (`--response-projection`, off by default): every tool with a JSON
  response then accepts an optional `_fields` argument. It takes up to 32 RFC 6901 JSON
  Pointers (at most 256 characters and 32 segments each), and `*` maps over an array, e.g.
  `["/items/*/id", "/next_cursor"]`. Only the selected values come back, under `projection`,
  keyed by pointer. A missing path yields `null`. The full response is still validated
  against the tool's output schema first, and only the selected values are checked for
  secrets. The grammar is explained once, in the server instructions; each tool's schema
  carries only a one-line description, and its output schema gains one `projection`
  branch. A truncated result of such a tool tells the model to use `_fields`; when the
  result is structured, the hint says that only the text copy is cut and
  `structuredContent` is complete. Cost: `tools/list` grows by about 30% (measured: the
  petstore fixture 910 → 1,177 bytes; 100 JSON GET operations 84,281 → 111,081 bytes),
  paid in every session, which is why it is opt-in.
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

# Configuration reference

Every flag `openapi-mcp` accepts, grouped by command, with its meaning, default, and an
example. This is the exhaustive reference; `README.md` links here instead of repeating it.
Nothing here should ever drift from the CLI's own `--help` — if in doubt, run
`openapi-mcp --help` or `openapi-mcp <command> --help`; that output is authoritative.

There is no separate `openapi-mcp` config file. All configuration is CLI flags and
environment variables, resolved through your MCP host's own config
(`.mcp.json` for Claude Code, `config.toml` for Codex). `~/.kaisers-io/openapi-mcp/`
(`%USERPROFILE%\.kaisers-io\openapi-mcp\` on Windows) holds only caches, all created private
(`0700`; on Windows through the profile's access control list, see
[security.md](security.md#windows)):

- `cache/`, the on-disk spec cache, managed by `cache list` / `cache clear` and reported by
  `doctor`;
- `compile-cache/`, Node's V8 compile cache for the CLI bundle. Every invocation uses it,
  including `--version` and `--help`, so the first run per user writes it and is slower; later
  starts are faster. `doctor` and `cache clear` neither report nor clear it. Delete the
  directory to reset it, and set `NODE_DISABLE_COMPILE_CACHE=1` to turn it off (then nothing
  is written for it).

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
| `--timeout <duration>` | no | spec fetch timeout; also each authorization-server metadata and JWKS fetch in `--http-auth oauth` mode | `30s` |
| `--ttl <duration>` | no | how long a cached spec is used before it is re-validated at startup (up to `365d`; not a timer, so not bound by the ~24.8-day limit of `--timeout`) | `1h` |
| `--cache-key <name>` | no | durable cache namespace label; required for authenticated specs (see below) | none |
| `--trust-spec-updates` | no | auto-accept refreshed specs instead of gating them | off |
| `--allow-private-network` | no | permit private/loopback addresses for spec fetch redirects and for API requests to a spec-derived origin or redirect, and the token URL with `--upstream-oauth-*`; with `--http-auth oauth` also the authorization-server metadata and JWKS fetches (never cloud-metadata) | off |
| `--default-response-is-error` | no | derive output schemas for operations that declare a `default` response, assuming it covers errors only (see below) | off |
| `--nullable-response-fields [all\|optional]` | no | admit `null` for object properties in derived output schemas, for specs that omit `nullable`: every property (`all`, also without a value) or only those not listed in `required` (`optional`) (see below) | off |
| `--base-url <url>` | no | override the spec-derived base URL for API requests | `servers[0]` from spec |
| `--header-env <Header=ENV>` | yes | API auth header, value read from env (secret) | `[]` |
| `--header <Header:value>` | yes | static, non-secret API header | `[]` |
| `--max-response-bytes <size>` | no | cap the decompressed upstream response body **and** the outgoing request body (see below) | `10MB` |
| `--allow-insecure-http` | no | permit an operator credential (`--header-env`) over cleartext http to a non-loopback origin | off |
| `--upstream-oauth-client-id-env <ENV>` | no | OAuth2 client-credentials: env var holding the client id | none |
| `--upstream-oauth-client-secret-env <ENV>` | no | OAuth2 client-credentials: env var holding the client secret (secret) | none |
| `--upstream-oauth-scheme <name>` | no | which oauth2 `securitySchemes` entry to use when several have a `clientCredentials` flow | the only one |
| `--upstream-oauth-scope <scope>` | yes | scope to request | none |
| `--upstream-oauth-token-url <url>` | no | override (or confirm a cross-origin) spec `tokenUrl` | spec `tokenUrl` |
| `--upstream-oauth-client-auth <method>` | no | `client_secret_basic` or `client_secret_post` (RFC 6749 §2.3.1) | `client_secret_basic` |
| `--request-timeout <duration>` | no | time budget for each upstream tool call, queue wait included (independent of `--timeout`, which covers the spec fetch) | `30s` |
| `--retries <n>` | no | retry a transient upstream failure up to `n` times (0–3), only for retry-safe requests (see below) | `0` |
| `--no-trace-propagation` | no | do not forward a call's W3C trace context (`_meta.traceparent`/`tracestate`) to the upstream API | forwarded |
| `--max-concurrency <n>` | no | upstream calls in flight at once (1–256); further calls wait in a bounded FIFO queue | `16` |
| `--rate-limit <calls/duration>` | no | tool calls allowed per sliding window, e.g. `10/1s`, `600/1h` (calls 1–100000) | `120/1m` |
| `--log <format>` | no | write one structured line per tool call to stderr; the only format is `json` | off |
| `--http` | no | serve over Streamable HTTP (127.0.0.1 unless `--http-host`) instead of stdio | off (stdio) |
| `--port <n>` | no | HTTP port | `3044` |
| `--http-token-env <ENV>` | no | env var holding the bearer token required for HTTP requests; mandatory with `--http` in `static` mode. Exactly 32 cryptographically secure random bytes as padded Base64 or unpadded Base64URL ([rules](security.md#http-mode-authentication-and-limits)) | none |
| `--http-auth <mode>` | no | `static` (one bearer token from `--http-token-env`) or `oauth` (OAuth resource-server mode, see [security.md](security.md#oauth-resource-server-mode-opt-in)) | `static` |
| `--http-host <addr>` | no | IP address to bind; accepted only with `--http-auth oauth` (in `static` mode the server always binds `127.0.0.1`), and a non-loopback address also requires an `https` `--oauth-audience` | `127.0.0.1` |
| `--oauth-issuer <url>` | no | authorization server issuer whose JWT access tokens are accepted; required with `--http-auth oauth` | none |
| `--oauth-audience <uri>` | no | this server's canonical resource URI (its public URL); tokens must carry it in `aud`; required with `--http-auth oauth` | none |
| `--oauth-required-scope <scope>` | yes | scope every access token must grant; advertised as `scopes_supported` | `[]` |
| `--tool-mode <mode>` | no | `per-operation`, `discover` or `auto` — see [Tool modes](#tool-modes) | `per-operation` |
| `--response-projection` | no | offer an optional `_fields` argument (JSON Pointers) on tools with a JSON response | off |
| `--output-schema <form>` | no | how output schemas are shown to the host: `inline` or `defs` (repeated subschemas once under `$defs`) — see [Output schema form](#output-schema-form) | `inline` |
| `--tools-page-size <n>` | no | page `tools/list` with `n` tools per page (1–512); only for MCP hosts that follow `nextCursor` | off (all tools in one response) |

Notes:

- `--header` uses `Header:value` (**colon**). `--header-env` and `--spec-header-env` use
  `Header=ENV` (**equals**) — the right-hand side is an environment variable *name*, not a
  literal value.
- `--max-response-bytes` also caps every outgoing request body, measured after encoding
  (for an `application/octet-stream` upload: the decoded bytes). The base64 tool argument
  that carries an upload is about 4/3 of that size inside the JSON-RPC message.
- Header values (from `--header`, `--header-env` and `--spec-header-env`, and header parameters
  a tool caller passes) are sent as bytes. Control characters and characters above U+00FF are
  refused: operator headers at startup, tool arguments per call, before any request is sent.
  Characters U+0080–U+00FF are allowed, are sent as single bytes, and the receiving server reads
  them as Latin-1 (ISO-8859-1), not UTF-8. ASCII is the safe choice.
- `--cache-key` is required for any spec fetched with `--spec-header-env` (an authenticated
  spec), unless `--trust-spec-updates` is also passed. Providing neither is a startup usage
  error.
- `servers[0].url` is expanded with its variables' defaults. If the result would exceed
  2048 UTF-8 bytes, it is ignored with a warning (nothing is built). `--base-url` still
  works with such a spec; without it, `serve` stops with the usual "no absolute server URL"
  usage error, also for a spec loaded from a URL (no fallback to the spec's own origin).
- `--request-timeout` replaces `--timeout` for upstream API calls. **Upgrading:** if you raised
  `--timeout` to make slow API calls work, set `--request-timeout` instead. `--timeout` no
  longer applies to API calls: it bounds the spec fetch and, with `--http-auth oauth`, each
  authorization-server metadata and JWKS fetch.
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
  own query parameters. Values are decoded by the parameter's declared type and style
  (booleans, numbers, comma-joined or repeated arrays, space- or pipe-delimited arrays).
  `name[key]` parameters (JSON:API `page[number]=2&page[size]=10`, `filter[status]=x`) map
  back onto a `deepObject` parameter `name`, but only keys its schema declares, one level
  deep, each once; a name that could be either a literal parameter or a `deepObject` key
  gives `null`. Without a pagination `Link` header, a JSON:API response (media type
  `application/vnd.api+json`, or a response schema that declares `links.next`) uses its
  top-level `links.next` (a URL or a link object's `href`) under the same rules;
  `links.next: null` means the last page.
  Otherwise a body cursor is used:
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
  or the outbound size budget), `token_error` (no upstream OAuth2 access token could be
  obtained, so no request was sent), `rate_limited`, `overloaded`, `egress_denied`, `timeout`,
  `cancelled`, `network_error` or `internal_error`. `upstreamMs` runs from the first request
  to the final outcome, so with `--retries` it includes every attempt and the backoff or
  `Retry-After` waits between them; `attempts` says how many requests were sent (a `401`
  token replay included). Arguments,
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
  petstore fixture 907 → 1,174 bytes; 100 JSON GET operations 83,681 → 110,481 bytes),
  paid in every session, which is why it is opt-in.
- Memory: each in-flight call may buffer up to `--max-response-bytes` of decompressed body.
  While a JSON result is processed, the call briefly holds a few copies of it: the bytes, the
  decoded text, and the parsed value that the MCP SDK then serializes. Plan for roughly
  4 × `--max-response-bytes` per in-flight call, times `--max-concurrency` at worst
  (about 640 MB with the defaults of `10MB` and `16`). For a tool with an output schema, the
  text copy of a structured result is capped at 8 KB, with a `…[truncated]` marker. The full
  data is in `structuredContent`.
- `--default-response-is-error` is opt-in. Without it, an operation that documents a
  `default` response gets no output schema, because `default` may cover an undocumented
  success status. With it, only the explicitly documented `2xx` responses form the output
  schema; a `2XX` range key still disables it. An undocumented `2xx` at runtime then
  returns a tool error naming the flag — never non-conforming structured output. `tools`
  marks the affected tools (see [`tools`](#tools)).

  **Trade-off.** The flag buys structured output at the cost of a possible false error: when
  the upstream answers with an undocumented success status (say `201` or `202` where only
  `200` is documented), the call is reported as a tool error even though the upstream
  action happened. The error text says so: the upstream reported success (status N), the
  request was likely applied, and the caller should not retry it blindly. For write-heavy
  APIs whose specs under-document success statuses, leave the flag off.
- `--nullable-response-fields` is opt-in. Some generators (springdoc, for one) leave
  `nullable` out unless a field is annotated, while the server serializes every unset field
  as `null`. OpenAPI 3.0 defaults `nullable` to `false`, so the derived output schema rejects
  such a response and the call fails with "upstream response for status N did not match the
  tool's declared output schema", even though the data is usable. With the flag, every value
  under an object's `properties` in the derived response (`data`) schema also admits `null`:
  at every depth, through `$ref`s, and in the properties of `allOf`/`anyOf`/`oneOf` members.
  That includes properties listed in `required`, because these generators use "required"
  for "the key is always serialized", not "never null".

  `--nullable-response-fields optional` admits `null` only for the properties their object
  does not list in `required`. Choose it when the spec's `required` does mean "never null":
  springdoc derives `required` from `@NotNull`, `@NotBlank` and `@Schema(requiredMode =
  REQUIRED)`, so a `null` there still fails, while unset optional fields sent as `null` pass.
  Choose `all` (the default, also given as the bare flag) when the server sends `null` for
  required keys too. A key required only in another `allOf` member counts as optional.

  Not widened: `required` itself (a required key must still be present), array items (a
  `null` element is still refused), `additionalProperties` values, the root `data` value,
  request and input schemas, and the envelope fields (`status`, `contentType`, `headers`,
  `pagination`, `projection`). A property that already admits `null` (3.0 `nullable: true`,
  3.1 `type: [T, "null"]`) is left as it is. A wrong non-null type and a missing required
  key still fail with the same status-only message. The flag only relaxes validation: the
  upstream data is returned unchanged, nulls included, and `_fields` works on it as usual.
  It applies to `--tool-mode discover` (`call_operation`) as well. `tools --json` marks each
  widened tool with `outputSchemaAdmitsNullFields: true`.

  Prefer fixing it at the source when you can: that keeps the null check strict for the
  fields that are never null. Without the flag, no output schema is widened.
  - In the spec: in springdoc, annotate the fields with `@Schema(nullable = true)`, or
    `types = {"string", "null"}` for OpenAPI 3.1.
  - In the server, if you control it: with Spring Boot, set
    `spring.jackson.default-property-inclusion=non_null`, so unset fields are left out of the
    response instead of being sent as `null`; optional properties then validate without the
    flag. This changes the response for every client of the API, and a required key sent as
    `null` still needs `nullable` in the spec, or the flag.
- Size limits: a spec may document at most 4096 operations (a hard stop before anything is
  cached, whatever the filters), and at most 512 tools may be exposed after `--allow`/`--deny`
  filtering. A larger API can be served by narrowing the exposed set with `--allow`/`--deny`;
  a spec above 4096 operations has to be split. When a refreshed spec is stored as a
  candidate that would expose more than 512 tools under the current filters, the run warns,
  since the server would refuse to start after `cache promote`.

OAuth2 client credentials (RFC 6749 §4.4): with `--upstream-oauth-client-id-env` and
`--upstream-oauth-client-secret-env` (both required together), `serve` obtains the access token itself
and sends it as `Authorization: Bearer <token>` on every API request.

- The token URL is the selected scheme's `flows.clientCredentials.tokenUrl` (relative URLs
  resolve against the API base URL), or `--upstream-oauth-token-url`. A spec token URL on a different
  origin than the API base is a startup error unless `--upstream-oauth-token-url` names it — the client
  secret is sent there. When the spec is fetched from a URL, `--base-url` or
  `--upstream-oauth-token-url` is required: otherwise the spec alone would choose both the API
  origin and where the client secret goes. The token URL must be `https` (`http` only for a
  literal loopback host: `localhost`, `127.0.0.0/8`, `::1` — not `*.localhost`), and it goes
  through the same egress policy as API requests: cloud-metadata addresses are always refused,
  private and loopback addresses need `--allow-private-network`, DNS is pinned, and a redirect
  from the token endpoint is never followed.
- Tokens are cached in memory only and refreshed 60 s (or 10 % of the lifetime, whichever is
  smaller) before `expires_in`; without `expires_in` a token is reused for at most an hour.
  Concurrent calls share one token request. A failed token request is answered from memory for
  5 s, so an authorization-server outage costs it one request per 5 s, not one per tool call.
  The token request is bounded by `--request-timeout`; when a call has to wait for a token,
  that wait counts against the call's own `--request-timeout` budget. A call that is
  cancelled or runs out of time while it waits ends at once, with `cancelled` or `timeout`,
  and sends nothing more; the token request keeps running for the other calls waiting on it.
  No request, a `401` replay included, is sent once the call's budget is spent. When the call
  ends this way after a `401`, its request was already sent, possibly more than once with
  `--retries`; for an operation with an `Idempotency-Key` header the result therefore still
  carries `_meta["openapi-mcp/idempotencyKey"]` for a repeat.
- An upstream `401` discards the token, fetches a new one and replays the request exactly
  once (a 401 means the request was not authorized, so this applies to writes too). A second
  `401` is returned as usual. Within 30 s of such a replacement, a further `401` keeps the
  current token and is returned without a replay: an upstream that rejects fresh tokens
  (wrong audience, missing permission) is not fixed by minting more of them.
  The replay is separate from `--retries`: a `401` is never retried as a transient failure,
  retries spent before the `401` do not prevent the replay, and the replay does not use up a
  retry. Both stay within the call's `--request-timeout`, and a `POST`/`PATCH` replay carries
  the same `Idempotency-Key`.
- Neither the client secret nor an access token is ever written to the call log, the
  `openapi_mcp_status` counters or a tool result: both are registered with the redactor (an
  access token as soon as it is issued). A call whose token could not be obtained is logged
  with the outcome `token_error`.
- Scopes are only what `--upstream-oauth-scope` lists; they are not inferred from `security`.
- `--upstream-oauth-*` together with `--header-env Authorization=...` is a usage error. The
  authorization-code, device-code and password flows, mTLS and `private_key_jwt` are not
  supported.

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

OAuth resource-server example (behind a TLS-terminating reverse proxy that serves
`https://mcp.example.com/mcp` and forwards the client's `Host` header):

```bash
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --header-env Authorization=API_TOKEN \
  --http --http-auth oauth --http-host 0.0.0.0 --port 3044 \
  --oauth-issuer https://auth.example.com/realms/main \
  --oauth-audience https://mcp.example.com/mcp \
  --oauth-required-scope mcp:tools
```

### Tool modes

`--tool-mode` decides how the exposed operations reach the model.

- `per-operation` (default): one MCP tool per exposed operation, each with its full input
  schema, output schema and description in `tools/list`. At most 512 operations may be
  exposed.
- `discover`: `tools/list` carries `openapi_mcp_status` plus three fixed tools, whatever the
  number of operations:
  - `search_operations` `{ query?, tags?, method?, limit? (1–25, default 10), detail?
    ("names" | "summary") }` ranks the exposed operations by keyword (operation name, path,
    tags, parameter names, summary, description). Local and deterministic: no embeddings, no
    network. The query is capped at 500 characters and 32 distinct terms.
  - `describe_operation` `{ name, include_output_schema? }` returns the operation's
    definition as `per-operation` would list it, without its `outputSchema` by default:
    output schemas are most of a definition, and calling an operation needs only its
    `inputSchema`. An omitted one is marked `outputSchemaOmitted: true`;
    `include_output_schema: true` returns it. Operations that accept `_fields`
    (`--response-projection`) return it unless `include_output_schema` is `false`, because
    their field paths come from it. The server validates every result against the output
    schema either way.
  - `call_operation` `{ name, arguments }` calls it. `arguments` is validated by that
    operation's own schema, with the same error messages, rate limit, redaction and upstream
    request as a direct call. Omit `arguments` for an operation without inputs; `null` is
    rejected (`arguments: invalid_type`).
    Up to 4096 operations may be exposed.
- `auto`: `discover` when more than 64 operations are exposed after filtering, otherwise
  `per-operation`.

`--allow`/`--deny` and the read-only default apply unchanged: an operation they exclude is
neither searchable nor callable (`call_operation` reports it as an unknown operation).

What `discover` costs: a model typically needs a search and a describe before each new
operation, so a task takes more tool calls. And because one `call_operation` tool stands for
every exposed operation, it carries the least safe annotations among them — `readOnlyHint:
true` only when every exposed operation is a `GET`/`HEAD` (the read-only default),
otherwise `destructiveHint: true` when any is. A host that asks for approval per tool, or
decides it from annotations, sees one approval surface for all operations: approving
`call_operation` once approves every exposed operation, writes included. `serve` warns at
startup when `discover` exposes any non-read-only operation; narrow the set with
`--allow`/`--deny` if that matters (see [security](security.md#discovery-tool-mode)).

Startup cost: in `per-operation` mode, `serve` compiles one output validator per exposed
operation before it answers `initialize`, so an output schema the validator cannot compile
stops `serve` at startup. Operations with identical output schemas share one validator. In
`discover` mode, which can expose thousands of operations, an operation's validator is
compiled on its first call instead, before the request is sent: an output schema that cannot
be compiled then fails that operation's calls with a tool error, and `serve` names it once on
stderr. Measured on a development machine with a warm spec cache, for the GitHub REST
description (1,241 operations exposed with `--allow '**'`): about 2 s until `initialize` answers in
`discover` mode.

Measured `tools/list` sizes (2026-10-24, whole stdio response line, tokens ≈ bytes / 4):

| Spec | Exposed | `per-operation` | `discover` |
|---|---|---|---|
| 400 generated `GET` operations | 400 | 334,616 bytes (~84k tokens) | 4,955 bytes (~1.2k tokens) |
| DigitalOcean (read-only default) | 146 | 127,186 bytes (~32k tokens) | 4,955 bytes |
| DigitalOcean (`--allow '**'`) | 265 | 355,045 bytes (~89k tokens) | 5,002 bytes |

### Output schema form

Output schemas are derived from the dereferenced spec, so a component schema used in several
places is written out in full each time, and output schemas make up most of `tools/list`.
With `--output-schema defs`, each tool's output schema lists a repeated subschema once under
its own `$defs` and refers to it with a local `$ref` elsewhere; nothing is shared between
tools, so every schema still stands alone. The envelope branches and their `status` and
`contentType` stay inline. Validation is unchanged: the two forms accept exactly the same
values, so a response passes or fails the same way whichever form the server compiles. In
`per-operation` mode the form applies to `tools/list`; in `discover` mode to the output
schemas `describe_operation` returns, computed when an operation is first described, so
startup does not pay for it.

MCP requires JSON Schema 2020-12, which includes local `$ref`/`$defs`, but a host that does
not resolve them would see an incomplete schema. That is why the default stays `inline`.

Measured for the GitHub REST description with `--allow tag:repos` (201 tools): the whole
`tools/list` stdio response shrinks from 1,977,625 to 1,541,314 bytes (−22%), its output
schemas by 28%. How much a spec gains depends on how often its schemas repeat inside one
response.

## `tools`

Preview the operation inventory an OpenAPI spec generates, with filters applied — no server
is started. Shares the spec-loading and filtering flags with `serve`; it has none of the
API-request or transport flags (no `--base-url`, `--header*`, `--max-response-bytes`,
`--allow-insecure-http`, `--http*`), since no API requests are ever made. It has no
`--tool-mode` either, so it always applies the 512-tool limit: an inventory that only
`serve --tool-mode discover` can expose fails here; narrow it with `--allow`/`--deny` to
preview it.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--spec <url\|file>` | no | OpenAPI spec source, JSON or YAML | required |
| `--allow <pattern>` | yes | whitelist pattern | `[]` (read-only default applies) |
| `--deny <pattern>` | yes | blacklist pattern, always wins | `[]` |
| `--strict-filters` | no | exit with an error instead of a warning on dead patterns | off |
| `--spec-header-env <Header=ENV>` | yes | auth header for the spec fetch, value read from env | `[]` |
| `--timeout <duration>` | no | spec fetch timeout | `30s` |
| `--ttl <duration>` | no | how long a cached spec is used before it is re-validated at startup (up to `365d`; not a timer, so not bound by the ~24.8-day limit of `--timeout`) | `1h` |
| `--cache-key <name>` | no | durable cache namespace label; required for authenticated specs | none |
| `--trust-spec-updates` | no | auto-accept refreshed specs instead of gating them | off |
| `--allow-private-network` | no | permit private/loopback redirect targets during the spec fetch (never cloud-metadata) | off |
| `--default-response-is-error` | no | derive output schemas for operations that declare a `default` response, assuming it covers errors only (see below) | off |
| `--nullable-response-fields [all\|optional]` | no | admit `null` for object properties in derived output schemas, for specs that omit `nullable`: every property (`all`, also without a value) or only those not listed in `required` (`optional`) (see below) | off |

Example (an operationId glob, so it matches only operationIds that start with `read`):

```bash
openapi-mcp tools --spec https://api.example.com/openapi.json --allow "read*"
```

Output: one line per tool. A tool whose output schema exists only because of
`--default-response-is-error` ends with `[output schema assumes default = error]`. With the
global `--json` flag each tool is an object; besides `name`, `method`, `path`, `summary` and
`deprecated` it carries `outputSchema` (`true`/`false`, JSON only) and, for the tools the text
marker flags, `outputSchemaAssumesDefaultIsError: true`. With `--nullable-response-fields`,
a tool whose output schema it widened carries `outputSchemaAdmitsNullFields: true`, under
either scope (JSON only: with the flag this is nearly every tool, so the text output does not
mark it). A tool whose output schema was
withheld because a response `pattern` has nested quantifiers (see
[security.md](security.md#response-envelope-and-redacted-errors)) carries
`outputSchemaWithheld` with the sentence its description starts with.

When the exposed operations declare `security` requirements, `tools` prints one `auth:` line
per referenced `components.securitySchemes` entry naming the credential it expects and the
flag that supplies it (e.g. `pass --header-env X-API-Key=<ENV>`), and the `--json` envelope
carries the same list as `data.security` (an entry that cannot be supplied through
`--header-env` has a `reason`). Reported as unsupported: query-string API keys, header API keys
whose name is not a valid HTTP header name, challenge/response `http` schemes (`digest`,
`negotiate`, `ntlm`, `hoba`, `mutual`, `scram-*`), mutual TLS, and malformed schemes;
interactive OAuth flows need a token obtained elsewhere. Several cookie schemes share one
`--header-env Cookie=<ENV>` value (`a=1; b=2`).

`serve` warns at startup when an exposed operation's requirement is satisfied by none of the
configured `--header` / `--header-env` headers. The warning lists the alternatives joined with
`OR`; the schemes one alternative needs together are joined with `AND`. An alternative that
needs two `Authorization`-based schemes at once cannot be met by one request and is reported
as such.

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

### `multipart/form-data` bodies

Each property of the body object becomes one part:

- A file part (`{type: string, format: binary}`, or 3.1 `contentMediaType`) is a base64
  tool argument, sent as raw bytes with `filename="<part name>"`. Its `Content-Type` is the
  declared `contentMediaType` when that names one concrete type (`image/png`), otherwise
  `application/octet-stream`. A file part with other keywords (`maxLength`, `nullable`,
  `enum`, …) omits the operation rather than being sent as text.
- Any other part must be a single non-null scalar (string, number, integer, boolean, or an
  enum/const of those). Arrays (repeated parts or several files), objects (JSON parts) and
  nullable parts omit the operation.
- RFC 2046 requires at least one part. A call to a required multipart body with every part
  absent is refused with a message naming the parts, instead of sending an empty body that
  strict servers reject.

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

The lock records the owning process id and hostname. The conflict message and `cache unlock`
report them, and for an owner on the same host whether that process is still running. A lock
younger than 60 seconds still needs `--force`, even when its owner looks dead: a process in
another PID namespace (a container sharing the cache directory) can look dead from here.

A held lock only fails commands that change what is accepted (first use, a new candidate,
`--trust-spec-updates`, `cache promote`, `cache clear`), and only after retrying: for as long as
`--timeout` allows when a spec is loaded (at least about two seconds), about two seconds for
`cache promote` and `cache clear`. A start whose spec is unchanged serves the verified baseline
with a warning instead, and `serve` reports it in the `openapi_mcp_status` tool as
`cacheLock: "held"` (another process is writing) or `cacheLock: "stale"` (the owner looks gone:
run `cache unlock`).

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
    "cliVersion": "0.4.1",
    "nodeVersion": "24.12.0",
    "appRoot": "/Users/you/.kaisers-io/openapi-mcp",
    "cacheRoot": "/Users/you/.kaisers-io/openapi-mcp/cache",
    "cacheRootExists": true
  },
  "warnings": []
}
```

## Exit codes

| Code | Meaning | Examples |
|---|---|---|
| `0` | success | |
| `1` | unexpected error; also the start-up guard for an unsupported platform or Node version | |
| `2` | usage error | unknown flag, invalid flag value, missing `--base-url`, `--http` without `--http-token-env` |
| `3` | validation error | invalid spec, `--strict-filters` with a dead pattern, malformed HTTP token, refused egress target |
| `4` | not found | unreadable spec file, missing cache entry, `cache unlock` on an entry without a lock |
| `5` | conflict | cache lock held by another process, `cache promote --hash` mismatch |

With the global `--json` flag, `tools`, `doctor` and the `cache` commands print an error as
`{"ok": false, "error": {"code": "<code>", "message": "<text>"}}`. Two exceptions print plain
text on stderr whatever the flags: `serve`, whose stdout is reserved for MCP traffic (it stays
empty on an error), and the launcher's platform and Node version checks (exit `1`), which run
before any option is parsed.

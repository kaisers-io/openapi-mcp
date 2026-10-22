# Changelog

## Unreleased

### Changed

- **Request bodies with `minProperties`/`maxProperties` are now a single `body` field (#71).**
  These operations used to be omitted. They are now generated, and the body is not flattened
  into top-level fields, so the property-count constraint can be enforced. The common case
  is a PATCH body with `minProperties: 1`: its tool takes `{ "body": { … } }` instead of
  flattened fields. The change is visible in `tools/list`.

- **Upstream connections are reused (#51).** Tool calls share a bounded pool of pinned
  keep-alive connections per origin and trust policy instead of opening a new TCP/TLS
  connection per call. DNS is still validated for every new socket; an idle connection is
  closed after 30 s and every pooled agent is re-resolved after 5 min.

- **Parallel tool calls queue instead of failing (#64).** A call past `--max-concurrency`
  (new flag, default `16`) waits in a bounded FIFO queue (4 × the limit). The queue wait
  and the upstream request share one time budget: the wait takes at most half of it. A
  refused call (`overloaded`, or over the new `--rate-limit`, default `120/1m`) is a tool
  error whose `_meta` carries `openapi-mcp/error` and `openapi-mcp/retryAfterMs`.

- **New `--request-timeout` for upstream API calls (#68).** `--timeout` now covers only the
  spec fetch. **Upgrading:** if you raised `--timeout` to make slow API calls work, set
  `--request-timeout` instead (default `30s`); it is the per-call budget, queue wait included.
- **HTTP client fixes (#68).** `Accept` is derived from the operation's declared 2xx media
  types (a spec `Accept` header parameter is ignored, per OpenAPI; `--header Accept:`
  overrides). A redirect that stays on the trusted `--base-url` origin keeps its trust. A
  303 after a write is followed as a GET without a body. An unfollowed 3xx is a tool error,
  not a success.

- **Large structured results are scanned once and their text copy is capped (#62).** For a
  tool with an output schema, `content[0].text` is now an 8 KB serialization with a
  `…[truncated]` marker; `structuredContent` still carries the complete data. A host that
  forwards only `content[]` to the model sees the first 8 KB, as it already did for
  unstructured results.

- **Selected upstream response headers reach the tool result (#73).** `Location` (same-origin,
  as a path), `ETag`, `Last-Modified`, `Retry-After`, `X-Total-Count` and rate-limit headers
  appear under an optional `headers` property of the structured result, or as a trailing
  `headers:` block of a text result. A header whose name or value contains a registered
  secret is dropped. On a 429/503, `Retry-After` is reported as
  `_meta["openapi-mcp/upstreamRetryAfterMs"]`.

- **Next-page hints for paginated tools (#61).** A `GET` with a page or cursor parameter
  (`cursor`, `page_token`, `after`, `starting_after`, `page`) or a declared `Link` header
  returns `pagination.next`: the arguments for the next call (never a URL), decoded to the
  tool's own parameter types, or `null` when no next page is known (not proof that the data
  is exhausted). Its output schema gains an optional `pagination` property.

- **Opt-in retries for retry-safe requests (#82).** `--retries <n>` (0–3, default `0`)
  retries 429/502/503/504 and connection errors before any response for GET, HEAD, PUT and
  DELETE (DELETE not after a connection error), and for POST/PATCH only when the operation
  declares an `Idempotency-Key` header. The key used is returned as
  `_meta["openapi-mcp/idempotencyKey"]`. Retries stay within `--request-timeout`.

- **MCP protocol polish (#77).** Tools carry a `title` from the operation summary, and
  `tools/list` is sorted by name after the status tool (the order changes once for specs
  not already alphabetical). A call with `_meta.progressToken` gets progress notifications.
  `tools/list` is not paged unless `--tools-page-size <n>` is set; set it only for hosts that
  follow `nextCursor`.
- **Trace propagation is on by default (#77).** A valid W3C `traceparent`/`tracestate` from a
  `tools/call`'s `_meta` (also through `call_operation`) is sent to the upstream on
  same-origin hops. For third-party APIs you do not operate, pass `--no-trace-propagation`.

- **Opt-in call log and call counters (#78).** `--log json` writes one JSON line per tool call
  to stderr (never arguments, header values or bodies). `openapi_mcp_status` reports
  process-local counters under `calls` (visible to every client of the server). Outcomes
  include `secret_withheld` and `refused`.
- **A result withheld for containing a registered secret now says what happened (#78).** When
  the upstream call succeeded, the message says so and warns not to retry blindly, instead of
  "tool execution result could not be returned safely".
- **`openapi_mcp_status` returns `cacheLock`** when start-up could not record the spec
  revalidation (#65); it was declared in the output schema but missing from the result.

- **Opt-in response projection (#44).** With `serve --response-projection`, tools with a JSON
  response accept an optional `_fields` argument (up to 32 JSON Pointers, `*` maps over an
  array; also through `call_operation`) and return only the selected values under
  `projection`. Off by default because it grows `tools/list` by about 30%.

- **JWT access-token verifier in core (#70).** `verifyJwt` and `parseJwks` check an RFC 9068
  access token against a kid-indexed JWKS: asymmetric algorithms only (RS/PS/ES/EdDSA), `kid`
  required, canonical base64url, exact `iss`, `aud` bound to the resource URI, `exp` required,
  60 s clock skew. Library only; the HTTP resource-server wiring follows.

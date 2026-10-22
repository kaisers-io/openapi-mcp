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

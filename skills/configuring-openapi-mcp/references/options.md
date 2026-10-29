# Options

Every option of `serve` and `check` in the version `metadata.version` names, generated from
`openapi-mcp --json help`. `tools` takes the spec and filter options among them. Run
`CLI --json help` for the version in use. "With --api": `prefix` takes `<api>=` before the
value, `prefix-or-all` applies to every API without one, `enable` is set with
`--enable <api>=<switch>`.

## Contents

- [serve and check](#serve-and-check)

## serve and check

| Flag | Default | Values | Repeatable | With --api | Meaning |
|---|---|---|---|---|---|
| `--spec <url\|file>` |  |  |  |  | OpenAPI spec source, JSON or YAML (or several APIs with --api) |
| `--allow <pattern>` |  |  | yes | prefix | expose what this selector matches: method:, path:, route:, operationId:, name: or tag: (repeatable) |
| `--deny <pattern>` |  |  | yes | prefix-or-all | exclude what this selector matches, always wins (repeatable) |
| `--strict-filters` |  |  |  |  | exit with an error instead of a warning on dead patterns, case collisions and tools whose path overlaps an excluded one |
| `--spec-header-env <Header=ENV>` |  |  | yes | prefix | auth header for the spec fetch, value read from env (repeatable) |
| `--timeout <duration>` | `"30s"` |  |  |  | spec fetch timeout (<int><s\|m\|h\|d>) |
| `--ttl <duration>` | `"1h"` |  |  | prefix | how long a cached spec is used before it is re-validated at startup (<int><s\|m\|h\|d>, up to 365d) |
| `--cache-key <name>` |  |  |  | prefix | durable cache namespace label; required for authenticated specs |
| `--trust-spec-updates` |  |  |  | enable | auto-accept refreshed specs instead of gating them |
| `--allow-private-network` |  |  |  | enable | permit private/loopback addresses for spec fetch redirects, for API requests to a spec-derived origin or redirect, and for the --upstream-oauth-* token URL (never cloud-metadata) |
| `--default-response-is-error` |  |  |  | enable | derive output schemas for operations with a "default" response, assuming it covers errors only (an undocumented 2xx then fails) |
| `--nullable-response-fields [scope]` |  (alone: `all`) | all, optional |  | prefix | admit null for object properties in derived output schemas (for specs, e.g. springdoc, that omit "nullable"): every property (all, the default) or only those not listed in "required" (optional) |
| `--omit-output-schema <pattern>` |  |  | yes | prefix | declare no output schema for matching tools, whose responses do not match the spec: results are returned as text without response-schema validation (repeatable, --allow selectors) |
| `--omit-unsupported-parameters <pattern>` |  |  | yes | prefix | build matching operations without the optional parameters this server cannot send (e.g. a deepObject array), instead of omitting them; the agent then cannot set those parameters (repeatable, --allow selectors) |
| `--base-url <url>` |  |  |  | prefix | override the spec-derived base URL for API requests |
| `--header-env <Header=ENV>` |  |  | yes | prefix | API auth header, value read from env (repeatable, secret) |
| `--header <Header:value>` |  |  | yes | prefix | static, non-secret API header (repeatable) |
| `--max-response-bytes <size>` | `"10MB"` |  |  |  | cap the decompressed upstream response body and the outgoing request body (<int><B\|KB\|MB> or a plain byte count) |
| `--allow-insecure-http` |  |  |  | enable | permit an operator credential (--header-env) over cleartext http to a non-loopback origin |
| `--max-concurrency <n>` | `"16"` |  |  |  | upstream calls in flight at once; further calls wait in a bounded queue |
| `--rate-limit <calls/duration>` | `"120/1m"` |  |  |  | tool calls allowed per sliding window |
| `--request-timeout <duration>` | `"30s"` |  |  |  | deadline for each upstream API request (<int><s\|m\|h\|d>); --timeout covers the spec fetch |
| `--retries <n>` | `"0"` |  |  |  | retry a transient upstream failure (429/502/503/504, connection error) up to n times (0-3) for GET/HEAD/QUERY/PUT/DELETE, and for POST/PATCH only with an Idempotency-Key header |
| `--no-trace-propagation` | `true` |  |  |  | do not forward a call's W3C trace context (traceparent/tracestate) to the upstream API |
| `--upstream-oauth-client-id-env <ENV>` |  |  |  | prefix | OAuth2 client-credentials: env var holding the client id |
| `--upstream-oauth-client-secret-env <ENV>` |  |  |  | prefix | OAuth2 client-credentials: env var holding the client secret (secret) |
| `--upstream-oauth-scheme <name>` |  |  |  | prefix | which oauth2 securitySchemes entry to use when the spec declares several |
| `--upstream-oauth-scope <scope>` |  |  | yes | prefix | scope to request (repeatable; none by default) |
| `--upstream-oauth-token-url <url>` |  |  |  | prefix | override the spec's clientCredentials tokenUrl |
| `--upstream-oauth-client-auth <method>` | `"client_secret_basic"` | client_secret_basic, client_secret_post |  | prefix | client authentication: client_secret_basic or client_secret_post |
| `--api <name=source>` |  |  | yes |  | serve several APIs: one spec per name (repeatable); every per-API option then starts with <name>= |
| `--enable <name=switch>` |  |  | yes |  | with --api: turn a per-API switch on for one API, e.g. shop=allow-private-network (repeatable) |
| `--http` |  |  |  |  | serve over Streamable HTTP (127.0.0.1 unless --http-host) instead of stdio |
| `--port <n>` | `"3044"` |  |  |  | HTTP port |
| `--http-token-env <ENV>` |  |  |  |  | env var holding the bearer token required for HTTP requests |
| `--http-auth <mode>` | `"static"` | static, oauth |  |  | HTTP authentication: "static" (--http-token-env) or "oauth" (resource-server mode) |
| `--http-host <addr>` |  |  |  |  | IP address to bind; only with --http-auth oauth (static mode always binds 127.0.0.1) |
| `--oauth-issuer <url>` |  |  |  |  | authorization server issuer whose JWT access tokens are accepted |
| `--oauth-audience <uri>` |  |  |  |  | this server's canonical resource URI; tokens must carry it in aud |
| `--oauth-required-scope <scope>` |  |  | yes |  | scope every access token must grant (repeatable) |
| `--log <format>` |  | json |  |  | write one structured line per tool call to stderr (only "json"; never arguments, header values or bodies) |
| `--response-projection` |  |  |  |  | offer an optional _fields argument (JSON Pointers) on JSON tools, so a call returns only the selected fields; adds about a third to tools/list |
| `--allow-offsite-redirects` |  |  |  | enable | follow a redirect that leaves the API base URL (another host, or outside the base path); egress checks still apply |
| `--tools-page-size <n>` |  |  |  |  | page tools/list with n tools per page (only for MCP hosts that follow nextCursor); default: all tools in one response |
| `--tool-mode <mode>` | `"per-operation"` | per-operation, discover, auto |  |  | per-operation (one tool per operation), discover (search_operations/describe_operation/call_operation), or auto (discover above 64 operations or 40 KB of tool definitions) |
| `--no-execute` | `true` |  |  |  | do not offer execute_code, which runs a short JavaScript program in a sandbox that calls read-only operations and returns only its result |
| `--image-responses <mode>` | `"off"` | off, inline, file |  |  | an upstream PNG, JPEG, GIF or WebP image: off (an unsupported media type, the default), inline (returned as an MCP image) or file (saved under ~/.kaisers-io/openapi-mcp/images/, and its path returned) |
| `--uploads` |  |  |  |  | let binary request fields take {"file": "<name>"} for a file read from ~/.kaisers-io/openapi-mcp/uploads/<api>/ instead of base64; files there older than 24 hours are removed at startup |
| `--image-dir-max-bytes <size>` | `"100MB"` |  |  |  | with --image-responses file: the most the image folder of this API may hold; the oldest saved images go first |
| `--output-schema <form>` | `"inline"` | inline, defs |  |  | how output schemas are shown to the host: inline (every subschema written out) or defs (repeated subschemas once under "$defs", referenced with "$ref"); validation is the same either way |
| `--no-output-schema-descriptions` | `true` |  |  |  | show output schemas without their field descriptions, which are most of their size; validation is the same either way |

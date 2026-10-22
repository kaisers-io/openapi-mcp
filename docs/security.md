# Security model

This document describes what `openapi-mcp` defends against by default, what it lets you
opt into deliberately, and what remains the operator's responsibility no matter what.

## The load-bearing assumption: trust the spec source

`openapi-mcp` interprets the OpenAPI document at `--spec` at runtime — it is not compiled or
reviewed ahead of time. Operation names, summaries, descriptions, parameter documentation,
and examples all flow into the tool definitions an MCP host puts in front of a model.

**The configured spec source must be trusted.** This tool hardens against malformed input
(control characters, oversized text, resource-exhaustion payloads — see below) but it cannot
semantically filter hostile natural-language prose out of a spec you chose to point it at.
A spec is not a passive data file here; treat it the same way you'd treat a dependency you
`npm install` — pin it, review changes to it, and don't point `openapi-mcp` at a spec source
you don't control or trust.

Everything below is a defense *in addition to* that requirement, not a replacement for it.

## Untrusted spec text

- The MCP server's static `instructions` are package-authored and never derived from spec
  text; `info.title` is used only as a sanitized, length-capped display name.
- Every piece of spec-derived text that reaches a tool definition or description (operation
  `summary`/`description`, parameter/property `description`, `enum`, `format`, `example`) is
  sanitized — control and bidirectional-override characters are stripped — and length-capped
  before it is attached.
- Spec parsing enforces resource budgets before anything is trusted or cached: a bounded spec
  fetch timeout and size, bounded YAML alias/anchor counts, bounded parse and `$ref`
  expansion depth, a bounded total schema-node count after dereferencing, a capped generated
  tool count, and a capped single-description length (truncated with a marker past the cap).
  Violating any budget is a hard failure before the spec is written to cache. External
  (cross-document) `$ref`s are rejected outright as a spec-level hard failure.
- A refreshed spec fetched at runtime never silently changes what a model can do: the cache
  keeps a durable accepted baseline plus at most one pending candidate. The only change
  applied automatically is a **removal** (fail-safe direction). New tools, changed
  descriptions, changed input schemas, method/path/base-URL changes, and auth-scheme changes
  all wait behind an explicit `openapi-mcp cache promote` (or the operator's own
  `--trust-spec-updates` opt-out for a spec they own). Restart is not treated as approval —
  hosts start and stop stdio servers routinely as part of normal session lifecycle, so
  restart-as-approval would be trivially bypassable.

## The egress trust boundary (SSRF)

The same hardened fetch path and validation rules apply to both the spec fetch and every
generated API request:

- Only `http:`/`https:` URLs are accepted; URLs containing userinfo (`https://user:pass@host`)
  are rejected for both `--spec` and `--base-url`.
- The API origin is **pinned at startup**: from `--base-url` if given (operator intent — you
  may point this anywhere, including a private range, since it's an explicit decision you
  made) or, absent that, from the spec's `servers[0]` (untrusted, since it comes from the spec
  document itself).
- Spec-derived origins are validated against a deny-by-default policy: loopback, link-local,
  RFC1918/CGNAT private ranges, and cloud-metadata endpoints are rejected. Pass
  `--allow-private-network` to opt into private/loopback ranges (the common case when
  developing against a local API) — cloud-metadata endpoints are never permitted by this flag.
- Redirects are bounded (max 5 hops) and every hop is re-validated against the same egress
  policy; authentication headers are not forwarded across an origin change on redirect.
- DNS resolution is pinned per connection rather than trusted at face value: the outbound
  fetch layer resolves once, validates every returned address (covering IPv4-mapped IPv6,
  CNAME chains, and alternate numeric IP encodings), and connects to a validated address —
  closing the time-of-check/time-of-use gap where a second lookup at connect time could
  return a different, disallowed address.
- A base-URL or path change arriving via a spec refresh is a gated change, not an applied
  one — reported to the operator, never silently activated (see above).
- `--allow-insecure-http` is required to send an operator credential (`--header-env`) over
  cleartext HTTP to a non-loopback origin; without it, sending a secret header over plain
  `http://` to a remote host is refused.

## Credential hygiene

- Secrets are read **exclusively** from environment variables named by `--spec-header-env`,
  `--header-env`, and `--http-token-env`. They are never accepted as literal flag values,
  never written to argv (visible via `ps` on a shared machine), never written to the on-disk
  cache, and never included in logs, tool schemas, or tool results.
- A referenced env var that is missing or empty at startup is a hard, immediate error naming
  the variable — never a silent fallback.
- `--header` (static, non-secret headers) enforces a deny-list of sensitive header names:
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, plus any header name
  containing (case-insensitively) `auth`, `token`, `secret`, `key`, `session`, `credential`,
  `cookie`, or `signature`. Those names must go through `--header-env` instead. This is an
  enforced deny-list, not a mechanical guarantee — an API using an unusual secret header name
  outside these patterns could still be misconfigured via `--header`; prefer `--header-env`
  for anything sensitive regardless of name.
- Header names are case-insensitively unique across all header flags; duplicates are a usage
  error. Control characters (CR/LF) in header names or values are a hard error.
- Cache entries never contain credentials, headers, or raw URLs with query strings — cache
  metadata stores a redacted display source (origin + path only).
- Every secret value registered at startup is passed through a central redactor applied
  recursively to every output channel: tool errors, logs, `doctor`, the status tool, and both
  text and structured tool results. Redaction covers the raw value and, for secrets of 8+
  characters, common encoded variants (standard Base64, URL-safe Base64, percent-encoded with
  upper- or lowercase hex, form-encoded, JSON-string-escaped including `\/`) — shorter values
  are excluded from variant redaction to avoid common-substring false positives. For a value
  shaped like an `Authorization` credential (`<scheme> <credential>`, e.g. `Bearer …`), the
  bare credential is redacted too, and for `Basic` also the decoded `user:password` and the
  password alone (each only when 8+ characters; the user name alone is not treated as
  secret). Empty secrets are rejected at startup rather than silently redacting nothing.
- There is no "show env/config/debug request" tool — nothing exposes the resolved secret
  values back through MCP.
- For safe terminal testing, see the README's [Secrets](../README.md#secrets) section
  (`HIST_IGNORE_SPACE`, `read -s`, secret-manager CLIs).

## Response envelope and redacted errors

- Successful responses are validated against the operation's declared output envelope before
  being returned as `structuredContent`; a mismatch (unexpected status, shape, or media type)
  returns a tool error with a redacted summary rather than nonconforming structured output.
- Oversized responses (over `--max-response-bytes`, default `10MB`) return a tool error — never
  a truncated, silently-invalid partial payload.
- Binary and unknown media types return a tool error describing the media type; this tool does
  not transport binary responses.
- HTTP 4xx/5xx upstream responses return `isError: true` with the status and a truncated,
  redacted body excerpt (passed through the same central redactor as everything else). `401`
  and `403` responses have their body fully redacted and instead carry an actionable message
  naming the environment variable to check.
- On stdio, stdout carries exclusively JSON-RPC traffic; all diagnostics go to stderr, so a
  host parsing stdout as the protocol stream is never polluted by log output.

## HTTP-mode authentication and limits

`--http` starts a Streamable HTTP server. Binding to `127.0.0.1` alone does not authenticate
callers — any other local process could otherwise reach tools that carry your API
credentials — so:

- `--http-token-env <ENV>` is **mandatory** with `--http`; startup fails closed without it.
  The token must be at least 32 ASCII characters from the Base64/Base64URL alphabet (the
  README's example generates one with `openssl rand -base64 32`); shorter, non-ASCII, or
  header-hostile values are rejected at startup.
- Clients authenticate with `Authorization: Bearer <token>`, compared using a constant-time
  digest comparison (both sides hashed, length-safe, no early exit on a length mismatch) to
  avoid timing side channels.
- The server binds `127.0.0.1` only; `Origin`/`Host` are validated to guard against
  DNS-rebinding.
- The transport speaks MCP revision `2026-07-28` and is **stateless**: every request is served
  end to end on its own, with no `initialize` handshake and no session state — the modern era
  carries its context in a per-request `_meta` envelope instead. The SDK's built-in era support
  answers older (2025-era) clients the same stateless way. There is no `Mcp-Session-Id`
  concept: the server never issues one, never expects one, and ignores it if a client sends one
  anyway.
- The endpoint is **POST-only**: `GET` and `DELETE` — meaningful only under the old
  session-based transport — return `405` with an `Allow: POST` header. Cancellation is the
  client closing the request stream; there is no separate cancel call.
- Requests are rejected before any MCP processing occurs: unauthenticated requests and request
  bodies over 4 MB. A process-global rate limiter and a process-global upstream-call
  concurrency cap bound tool-call throughput; neither is scoped per session, since there is no
  session.
- No CORS allowance — there is no browser use case, so cross-origin browser access is not
  enabled.
- Graceful shutdown on `SIGINT`/`SIGTERM` stops accepting new requests and aborts in-flight
  ones; there is no session state to close.

## What `openapi-mcp` defends, and what you still must do

`openapi-mcp` defends: credential exposure (env-only, redacted everywhere), unbounded/hostile
spec parsing (budgets, sanitization), silent privilege or behavior expansion from a mutable
remote spec (gated refresh), SSRF via the spec-derived origin or redirects (deny-by-default
egress, DNS pinning), and unauthenticated local access to your API credentials in HTTP mode
(mandatory bearer token, constant-time comparison).

You still must: **only point `--spec` at a source you trust** — this tool cannot tell a
legitimate operation description from a prompt-injection payload written in valid English;
choose `--allow` patterns deliberately rather than exposing write operations by default;
review a spec's diff before running `cache promote`; and treat any `--base-url` you set as an
explicit, trusted operator decision, since it bypasses the private-range deny-by-default
check that applies to spec-derived origins.

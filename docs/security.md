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
  expansion depth, every `$ref` resolvable and document-internal, a capped operation
  count (4096), and a capped single-description length (truncated with a marker past the cap).
  Violating any of these is a hard failure before the spec is written to cache. The number of
  tools actually exposed after `--allow`/`--deny` filtering is capped separately (512, or
  4096 under `--tool-mode discover`/`auto`, whose `tools/list` does not grow with the
  operation count) and checked on every run, since it depends on the filters rather than on
  the cached document; a narrow `--allow` can therefore serve a few tools from an API that
  documents more. Only the exposed operations are dereferenced, each shared `$ref` target
  once, under two node budgets checked on every run: unique allocated nodes (500,000) and the
  size of the result read as a tree (10,000,000), so neither shared models nor a "billion
  laughs" `$ref` graph can make dereferencing or tool generation unbounded. External
  (cross-document) `$ref`s are rejected outright as a spec-level hard failure.
- A refreshed spec fetched at runtime never silently changes what a model can do: the cache
  keeps a durable accepted baseline plus at most one pending candidate. The only change
  applied automatically is a **removal** (fail-safe direction): while a candidate waits, an
  accepted operation it no longer has (matched by method and path) is withheld and reported,
  and operations present in both keep their accepted definition. A candidate object that
  cannot be verified fails closed like any other damaged cache entry. Specs are only
  re-validated at startup (once the TTL has expired); a running server never changes its tool
  list. New tools, changed
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
  policy; authentication headers are not forwarded across an origin change on redirect. A
  redirect is also authorized like the request itself (see
  [Request authorization](#request-authorization)).
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
  `--header-env`, `--upstream-oauth-client-id-env`/`--upstream-oauth-client-secret-env`, and `--http-token-env`. They are never accepted as literal flag values,
  never written to argv (visible via `ps` on a shared machine), never written to the on-disk
  cache, and never included in logs, tool schemas, or tool results.
- A referenced env var that is missing or empty at startup is a hard, immediate error naming
  the variable — never a silent fallback.
- `--header` (static, non-secret headers) enforces a deny-list of sensitive header names:
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, plus any header name
  containing (case-insensitively) `auth`, `token`, `secret`, `key`, `session`, `credential`,
  `signature`, `password`, `bearer`, or `jwt`. Those names must go through `--header-env` instead. This is an
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
- OAuth2 access tokens obtained at runtime (`--upstream-oauth-*`) are registered with the same
  redactor before their first use, so they are scrubbed exactly like startup secrets. A token
  stays registered until it has expired. The registry holds at most 256 unexpired tokens; when
  it is full, the oldest token that has been *replaced* (never sent again) makes room, and the
  token in use is never dropped. A token that cannot be registered is never used. At most one
  401-driven replacement token is minted per 30 s, so an upstream that keeps answering `401`
  cannot churn the authorization server or the registry. Token-endpoint error bodies are never
  echoed — only the HTTP status and, if it is one of RFC 6749's registered codes, the `error`
  code.
- There is no "show env/config/debug request" tool — nothing exposes the resolved secret
  values back through MCP.
- Trace propagation is on by default: a client's W3C `traceparent`/`tracestate` from a
  `tools/call`'s `_meta` is forwarded to the upstream (same-origin hops only, strictly
  validated). It carries no credentials, but it lets the upstream correlate calls across
  sessions. For third-party APIs you do not operate, pass `--no-trace-propagation`.
- For safe terminal testing, see the README's [Secrets](../README.md#secrets) section
  (`HIST_IGNORE_SPACE`, `read -s`, secret-manager CLIs).

## Response envelope and redacted errors

- Successful responses are validated against the operation's declared output envelope before
  being returned as `structuredContent`; a mismatch (unexpected status, shape, or media type)
  returns a tool error with a redacted summary rather than nonconforming structured output.
- Regular expressions (`pattern`) and response validation. Response validation runs
  synchronously after the upstream call has finished, so the request timeout no longer
  applies to it. To keep its CPU cost bounded, a response schema with a `pattern` that has
  **nested quantifiers** gets no output schema. The tool still works and returns its result
  as text, and its description starts with a sentence that says so. Supported pattern
  contract:
  - Response schemas: a pattern is enforced unless it nests quantifiers. "Nested" means a
    group repeated more than once (`*`, `+`, `{n,}`, `{n,m}` with m > 1) that contains an
    unbounded quantifier (`(a+)+`, `(\w+\s?)*`, `(a*){2}`), or an unbounded repetition of a
    group that contains any variable quantifier (`(a?)+`, `(\d{1,3})*`). Small bounded
    nestings stay supported: `(\d{1,3}\.){3}` (IPv4) and `(-[0-9a-f]{4}){3}` (UUID).
  - This is a star-height heuristic in the style of safe-regex. It is conservative: some
    unambiguous patterns, such as `^[a-z]+(-[a-z]+)*$`, are refused too. It does not detect
    overlapping alternation under a single quantifier (`(a|a)+`) or backreferences.
  - Request schemas (tool inputs): `pattern` and `format` are advertised to the model in the
    input schema but never executed by this server, so they carry no CPU risk here.
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

- `--http-token-env <ENV>` is **mandatory** with `--http` in the default `static` mode; startup
  fails closed without it. (The opt-in OAuth mode below replaces it.)
  The token must encode exactly 32 bytes (256 bits), in one of two forms:
  - 44 characters of padded standard Base64 — alphabet `A-Z a-z 0-9 + /`, ending in exactly
    one `=` (the output of `openssl rand -base64 32`), or
  - 43 characters of unpadded Base64URL — alphabet `A-Z a-z 0-9 - _`, no `=`.

  Everything else is rejected at startup: other lengths, hex strings (`openssl rand -hex 32`),
  missing or extra padding, mixing the two alphabets, and surrounding whitespace or newlines.
  The format check cannot tell a random token from a guessable one, so generate it with a
  cryptographically secure random source — never a password, a hand-typed string, or a
  derivation of other data:

  ```bash
  export TOKEN=$(openssl rand -base64 32)
  # or, without openssl:
  export TOKEN=$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")
  ```

- Clients authenticate with `Authorization: Bearer <token>`, compared using a constant-time
  digest comparison (both sides hashed, length-safe, no early exit on a length mismatch) to
  avoid timing side channels.
- In this default `static` mode the server binds `127.0.0.1` only; `Origin`/`Host` are validated to guard against
  DNS-rebinding. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (the port
  must match). Any other value, including `[::1]:<port>`, gets 403. A rebinding page always
  sends its own hostname in `Host`, so it is still rejected.
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

## OAuth resource-server mode (opt-in)

`--http-auth oauth` turns the HTTP transport into an OAuth 2.1 resource server as the MCP
authorization specification (revision `2026-07-28`) describes. It is the only mode that may bind
a non-loopback address (`--http-host`); the static token stays the default and stays
loopback-only.

- **Discovery.** `/.well-known/oauth-protected-resource[/<path>]` serves RFC 9728 Protected
  Resource Metadata (`resource` = `--oauth-audience`, `authorization_servers` =
  `--oauth-issuer`, `scopes_supported` = `--oauth-required-scope`, `bearer_methods_supported`
  = `header`). A request without a token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`; an invalid token gets `401`
  `invalid_token`, a valid token without a required scope `403` `insufficient_scope`.
- **Local JWT validation (RFC 9068).** Tokens are verified against the issuer's JWKS. Only
  asymmetric algorithms are accepted (`RS*`, `PS*`, `ES256/384/512`, `EdDSA`); `none` and every
  `HS*` algorithm are rejected, so a token signed with the public key as an HMAC secret never
  verifies. The token must name its key (`kid`), the key must fit the algorithm (and its own
  `alg`/`use`/`key_ops`, if published), RSA keys must be at least 2048 bits, and a `crit` header
  is rejected. `iss` must equal `--oauth-issuer` exactly, `aud` must name `--oauth-audience`
  (RFC 8707 audience binding, compared as normalized URLs: a trailing slash, the case of scheme
  and host, a default port and dot segments do not matter; path case does),
  `exp` is required, and `exp`/`nbf`/`iat` are checked with 60 s of clock skew. `typ` may be
  `at+jwt`, `application/at+jwt`, `JWT` or absent; any other `typ` is rejected. `sub`,
  `client_id`, `iat` and `jti` are optional (RFC 9068 §2.2 requires them; widely deployed
  authorization servers omit some). Token segments must be canonical base64url.
- **Opaque tokens are not supported**: there is no token introspection (RFC 7662) in this
  version.
- **Key discovery goes through the egress policy.** At startup the server fetches the
  authorization server metadata (RFC 8414 path insertion, then OpenID Connect discovery — the
  order MCP clients use) and requires its `issuer` to equal `--oauth-issuer`. Metadata and JWKS
  are fetched through the same DNS-pinned transport as API calls: cloud-metadata addresses are
  always denied, private addresses only on the issuer's own origin (operator intent) or with
  `--allow-private-network`, documents are capped at 64 KiB, and each fetch is bounded by
  `--timeout`. Issuer, audience and `jwks_uri` must use `https` (plain `http` only for a
  loopback host), and so must every redirect hop of a metadata or JWKS fetch. `jwks_uri` may
  carry a query string (e.g. Entra ID's `?appid=`) and is fetched exactly as published; issuer
  and audience may not. An unreachable or inconsistent authorization server, or one without a
  usable signing key, fails startup.
- **JWKS keys.** Entries that can never verify a token (encryption keys, `key_ops` without
  `verify`, unsupported key types, RSA under 2048 bits) are ignored, so they cannot shadow a
  signing key; a key listed twice verbatim counts once; a `kid` naming two different signing keys
  is dropped (ordering must not decide which signature is accepted). At most 100 entries are read
  and 32 signing keys kept.
- **JWKS cache and refresh policy.**
  - The key set is fresh for 5 minutes. After that, requests are still verified against it
    immediately while one refresh runs in the background (stale-while-revalidate); no request
    waits on the authorization server while a usable key set is at hand.
  - A token with an unknown `kid` (key rotation) waits for an early refresh.
  - Whatever triggers it, at most one JWKS fetch starts per 30 s. A token that is malformed or
    has a forbidden header is rejected before the key cache is consulted, so junk bearer tokens
    never cause a fetch.
  - A failed refresh (network error, non-200, not a JWKS, no usable signing key) keeps the last
    good key set and logs a warning; that set is used for at most one hour after it was fetched,
    then requests fail closed with `503`.
  - A valid but **empty** key set (`{"keys": []}`) is the authorization server's authoritative
    answer that every key is revoked: it is honoured (every token is rejected with `401`) and
    logged as a warning until a signing key is published again.
- **No token passthrough.** The client's access token is read from the `Authorization` header
  only and is never forwarded upstream or written to any output; upstream credentials are still
  only the operator's (`--header-env`, or a token from `--upstream-oauth-*`). Rejection causes are logged to stderr (rate-bounded) without the token.
- **One upstream identity for everyone.** OAuth here decides who may use *this server*; it does
  not give per-user authorization at the upstream API. Every authenticated caller acts with the
  operator's single upstream identity (`--header-env` or `--upstream-oauth-*`), so `--oauth-required-scope` is the only per-user
  control. Without it, any token the issuer mints for `--oauth-audience` grants access to every
  tool; on a non-loopback `--http-host` the server says so in a startup warning.
- **No sessions to hijack.** The transport is stateless: no `Mcp-Session-Id` is issued and no
  state is kept between requests, so one caller cannot ride on another caller's session; every
  request is authenticated on its own.
- **Metadata caching.** The Protected Resource Metadata response carries
  `cache-control: max-age=3600`: after changing `--oauth-issuer` or `--oauth-required-scope`,
  clients may use the old document for up to an hour.
- **Deployment.** TLS is not terminated by `openapi-mcp`: run it behind a reverse proxy that
  serves the `--oauth-audience` URL over `https` and forwards the client's `Host` header — the
  `Host` check accepts exactly the audience's authority, so a request addressed to any other host
  is refused with `403` before authentication. Browser `Origin`s are still refused. The request
  body is read only after the token validated. The tool-call rate limit and the upstream
  concurrency cap remain process-wide, not per user: every authenticated caller shares them.

## Request authorization

`--allow`, `--deny` and the read-only default decide which operations become tools. The
request a tool sends is checked against the same decision, so an excluded operation is never
reached through a tool's arguments or through a redirect (issue #40):

- Before every hop, the request's method and path (relative to the API base URL) are resolved
  against every operation of the spec: exposed ones, filtered-out ones, operations omitted as
  unsupported and operations a pending candidate withholds. The path is read as an upstream
  would read it: percent-decoded, one trailing slash ignored.
- A concrete path matches before a template, as OpenAPI defines. Templates are not ranked
  against each other: when two templates match and one of them is not exposed, the request
  is refused. Matching regardless of letter case can only add a refusal, never allow one.
  The same holds for the readings common servers give a path before routing: every
  percent-encoding decoded byte by byte (also twice, and past bytes that are not valid
  UTF-8), `\` taken as a separator, repeated slashes merged, `;parameters` cut from a segment
  or kept (`..;/`), and dot segments resolved before or after repeated slashes are merged, so
  `x%2F..%2F%2Fdenied` counts as `/denied`. The base path is matched in the same readings,
  in the request and in the configured base URL. An id such as `group%2Fproject` still
  reaches its own operation, but no reading may reach an operation that is not exposed, and
  a reading that climbs out of the base path counts as leaving the API.
- Hop 0 must resolve to the tool's own operation. `getItem` with `id: "export"` resolves to
  `GET /items/export`; when that is another operation, the call fails and nothing is sent.
  When it resolves to the tool's own operation and also to one that is not exposed (two
  templates that share the URL), the call fails too, and the error says so instead of
  blaming the arguments.
- Startup names each exposed tool whose path can match the same URL as an operation that is
  not exposed (issue #41): `tool listOrderItems (GET /orders/{orderId}/items): a request that
  also matches GET /orders/{orderId}/{section}, which is not exposed, is refused`. It is found
  on the templates themselves, letter case and the readings below included, not by trying
  sample values. Under `--strict-filters` it is an error, as is a check that ran out of its
  work budget (a hostile spec), since that cannot show there is none. An excluded concrete path inside an
  exposed template (`/items/export` under `/items/{id}`) is not reported: that one URL is the
  other operation. `tools --json` lists every such pair under `overlaps`.
- A `HEAD` request also counts as `GET`, since a server may answer it through its GET
  handler: an excluded GET operation for the path refuses it.
- A redirect must resolve to an exposed operation with the method the hop is sent with (a
  `303` turns it into `GET`). A redirect to an excluded operation, or to a path on the API
  that matches no operation, is not followed. The tool error says that the original request
  reached the upstream and may have been applied.
- A redirect off the API (another origin, or outside the base path) is not followed unless
  `serve` runs with `--allow-offsite-redirects`. The egress policy applies either way, and a
  later hop back onto the API is authorized again.
- A spec path with a control character in a static segment is omitted: URL parsing removes
  tab and newline, which would turn `.<TAB>.` into `..` and route the request elsewhere.

An excluded operation's own path counts in those readings too, so `/denied//export` also
refuses a request for `/denied/export`. The matching work per hop is bounded: a hop that would
need more (a hostile spec with many long templates against a long path) is refused instead
of holding up other calls; a hop on a 290-operation API uses under half a percent of it.

The checks err on the side of refusing: matching regardless of case, the `HEAD` rule and the
work budget can refuse a request that a particular upstream would have routed to an exposed
operation. Such a call fails with a tool error and sends nothing (hop 0) or follows no
further redirect.

None of these refusals is retried. Limits: the check knows only what the spec documents and
the readings above. An upstream that serves an excluded operation under another,
undocumented path, that applies a rewrite of its own (IIS `%u` escapes, a trailing dot,
suffix patterns such as `.json`, Unicode normalization), or that honours a method-override
header, cannot be detected from the spec. For a guarantee that does not depend on paths,
exclude by method: `--deny "method:delete"`.

## Discovery tool mode

`--tool-mode discover` replaces the per-operation tools with `search_operations`,
`describe_operation` and `call_operation`. It adds no second policy path: the three tools
only ever see the exposed (post-filter) operations, and `call_operation` runs the target
through the same rate limit, strict input validation, executor and dispatch-boundary
redaction as a direct call — an operation `--allow`/`--deny` or the read-only default
excluded is an unknown operation, and no upstream request is made. Search input is bounded
(query length and term count, tag list, result count) and every spec-derived string in a
search result is sanitized and capped like any other tool text. The trade-off is approval
granularity: `call_operation` carries the least safe annotations among the exposed
operations (see [Tool modes](configuration.md#tool-modes)), so a host gating approval per
tool sees one tool for all of them. **One approval covers every exposed operation**: in a
host that offers "always allow this tool", allowing `call_operation` once allows every
operation the filters expose, writes included when `--allow` widens the set beyond the
read-only default. Use `discover` with the read-only default (or an `--allow` set you would
approve as a whole), or `--tool-mode per-operation` where each write needs its own approval.
`serve` prints a startup warning naming the non-read-only operations whenever `discover` (or
`auto` resolving to it) exposes any. `call_operation` also rejects `arguments: null` (the
advertised schema says object; omit `arguments` for an operation without inputs), so the
wire contract and the runtime agree. A code-execution mode (model-written code calling the
API) is deliberately not offered: it would bypass per-call validation, filtering, rate
limiting and redaction.
With `--http-auth oauth`, every MCP request, `call_operation` included, is authenticated at the
HTTP transport before it reaches a tool, and `--oauth-required-scope` applies to the whole
server, not per operation: a scope cannot grant some operations behind `call_operation` and
not others.

## Windows

The spec cache is a trust store: its accepted baseline decides which tools a model gets. On
Linux and macOS it is private through POSIX modes — every directory `0700`, every file `0600`,
set explicitly regardless of umask. Windows does not enforce POSIX modes (`chmod` there only
toggles the read-only attribute; `stat` reports `666` after `chmod 0600`, measured on
`windows-latest`), so the same calls run but protect nothing. On Windows the cache is private
through the **access control list it inherits** instead:

- The cache lives under `%USERPROFILE%\.kaisers-io\openapi-mcp\` (`os.homedir()`, which reads
  `USERPROFILE`). A standard profile directory grants access only to its owner, `SYSTEM` and
  the `Administrators` group, and new directories inherit that. Another standard user cannot
  read or plant cache entries there. The Windows CI job checks the inherited ACL of a freshly
  created cache directory: no `Everyone`, `Users` or `Authenticated Users` entry.
- `openapi-mcp` does not set an ACL itself. If `USERPROFILE` points somewhere else — a
  redirected or shared profile, a network drive, a directory whose ACL was widened — keeping
  `.kaisers-io\openapi-mcp\` private is the operator's responsibility, exactly as it is for a
  `HOME` on a shared mount on POSIX. Check it with `icacls "%USERPROFILE%\.kaisers-io"`.
- Administrators and `SYSTEM` can read and change the cache, as root can on POSIX.

Two filesystem differences are handled in code, so the cache keeps its guarantees:

- **No directory fsync.** Windows refuses `fsync` on a directory (`EPERM`; Node implements it as
  `FlushFileBuffers`, which needs a writable handle a directory cannot have). Each file is still
  flushed before it is renamed into place, and NTFS journals the rename, so after a crash a
  cache file is the old or the new version, never a torn one. Only on Windows is `EPERM` read
  as "no directory barrier"; elsewhere it still fails the write.
- **No rename over an open file.** Replacing `meta.json` fails with `EPERM` while any process
  (another `openapi-mcp` reading it, a virus scanner) has it open. The rename is retried with a
  short backoff for at most 2 seconds, then the write fails closed as before. Linux and macOS
  make exactly one attempt.

The writer lock (an exclusive hard link) and the stale-lock check (`process.kill(pid, 0)`)
behave the same on Windows as on POSIX (measured).

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

## Dependency audit (maintainers)

`pnpm audit --audit-level=high` checks the whole lockfile against the live advisory database. It
covers dev dependencies too, because the CLI bundles its runtime dependencies from them. The check
runs in `.github/workflows/audit.yml`:

- weekly on `main` (Mondays, 06:17 UTC),
- on demand (Actions → audit → Run workflow),
- on pull requests that change `pnpm-lock.yaml`, `pnpm-workspace.yaml` or a `package.json`.

It is not part of `ci.yml` and must not be a required status check. A new advisory against an
unrelated transitive package would otherwise turn every open PR red without any change in the PR.

When a run fails:

1. **Read the advisory.** Check whether the vulnerable code path is reachable here: is it in the
   shipped bundle (`packages/cli/dist`), or only in dev tooling?
2. **Fix by upgrading.** This is the normal case. Bump the direct dependency that pulls the
   vulnerable package in. If that is not possible yet, run `pnpm audit --fix update` (re-resolves
   the lockfile) or `pnpm audit --fix override` (pins a fixed version through `overrides` in
   `pnpm-workspace.yaml`). Open a PR. The audit runs on it because it changes the lockfile.
3. **Accept only with a record.** Accept an advisory only when no fixed version exists and the
   code path is not reachable. Add `--ignore GHSA-xxxx-xxxx-xxxx` to the audit step in
   `audit.yml` with a comment giving the reason and a review-by date. Remove the ignore once a
   fix ships, or when the date passes.
4. **Shipped code affected.** If the vulnerable code is in the shipped bundle and reachable,
   treat it as a release blocker: fix it, then cut a patch release.

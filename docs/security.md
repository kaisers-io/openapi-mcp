# Security model

This page describes what `openapi-mcp` defends against by default, what you can turn on
deliberately, and what stays your responsibility whatever you configure. Read it before you
expose write operations, serve over HTTP, or point the server at a spec you do not maintain.
Setup steps live in the guides; this page states the guarantees and their limits.

<a id="the-load-bearing-assumption-trust-the-spec-source"></a>

## Trust the spec source

`openapi-mcp` reads the OpenAPI document at `--spec` at runtime. Nobody compiles or reviews it
ahead of time. Operation names, summaries, descriptions, parameter documentation and examples
all end up in the tool definitions that an MCP host shows to a model.

**You must trust the spec source you configure.** The server hardens itself against malformed
input, such as control characters, oversized text and payloads built to exhaust resources (see
below). It cannot tell hostile natural-language prose from an honest description in a spec you
chose. Treat a spec like a dependency you `npm install`: pin it, review its changes, and do not
point `openapi-mcp` at a spec source you do not control or trust.

Every defense below comes on top of this requirement. None of them replaces it.

## Untrusted spec text

- The MCP server's static `instructions` are written by this package and never built from spec
  text. The server uses `info.title` only as a display name, sanitized and capped in length.
- The server sanitizes every piece of spec text that reaches a tool definition or description
  before it attaches it: operation `summary` and `description`, parameter and property
  `description`, `enum`, `format` and `example`. It strips control characters and
  bidirectional-override characters and caps the length.
- Parsing enforces resource budgets before the server trusts or caches anything:

  | Budget | Limit |
  |---|---|
  | Spec fetch time | `--timeout`, 30 seconds by default |
  | Spec size | 20 MiB |
  | YAML alias expansion | an expansion budget of 1,000 per alias (`maxAliasCount`), not a cap on the number of aliases |
  | Parse depth | 128 levels |
  | `$ref` expansion depth | 64 levels |
  | Operations in the document | 4,096 |
  | One summary or description | 4,096 characters, then truncated with a marker |

  Every `$ref` must resolve and stay inside the document. A `$ref` to another document is a
  hard failure for the whole spec. A spec that breaks any of these budgets fails before the
  server writes it to the cache. The text limit is the exception: a longer summary or
  description is truncated, not refused.
- The number of tools exposed after `--allow` and `--deny` has its own cap: 512 tools in
  `--tool-mode per-operation`, and 4,096 under `discover` and `auto`, whose `tools/list` does
  not grow with the operation count. With several APIs in one server the cap applies to all of
  them together. Because the count depends on the filters, not on the cached document, the
  server checks it on every run. A narrow `--allow` can therefore serve a few tools from an API
  that documents more. [Large APIs and tool modes](tool-modes.md) explains the modes.
- The server dereferences only the exposed operations, and each shared `$ref` target only once.
  Two node budgets apply on every run: 500,000 unique allocated nodes, and 10,000,000 nodes for
  the result counted as a tree. Neither large shared models nor a "billion laughs" `$ref` graph
  can make dereferencing or tool generation run without bound.
- A spec that is fetched again at runtime never silently changes what a model can do. The cache
  keeps a durable accepted baseline and at most one pending candidate. The server applies only
  one kind of change on its own, a removal, because removing is the safe direction. While a
  candidate waits, the server withholds and reports every accepted operation that the
  candidate no longer has (matched by method and path). Operations present in both keep their
  accepted definition. A candidate that cannot be verified fails closed, like any other damaged
  cache entry.
- The server checks a spec for updates only at startup, and only once the `--ttl` has expired.
  A running server never changes its tool list. New tools, changed descriptions, changed input
  schemas, a changed method, path or base URL, and a changed auth scheme all wait until you run
  `openapi-mcp cache promote`, or until you opt out with `--trust-spec-updates` for a spec you
  own. A restart does not count as approval: hosts start and stop stdio servers all the time,
  so approval by restart would be easy to bypass. [Spec updates and the cache](spec-updates.md)
  shows the workflow.

<a id="the-egress-trust-boundary-ssrf"></a>

## Outbound requests (SSRF)

The spec fetch and every API request go through the same hardened fetch code and the same
checks:

- The server accepts only `http:` and `https:` URLs. It rejects a URL with user information
  (`https://user:pass@host`) for both `--spec` and `--base-url`.
- The server fixes the API origin at startup. It takes `--base-url` if you pass one. That is
  your decision, so it may point anywhere, a private address included. Without `--base-url` the
  server takes the spec's `servers[0]`, which is untrusted because it comes from the spec.
- An origin taken from the spec must pass a deny-by-default policy. The server rejects
  loopback, link-local, the RFC 1918 and CGNAT private ranges, and cloud-metadata endpoints.
  `--allow-private-network` admits private and loopback addresses, which you usually need when
  you develop against a local API. It never admits a cloud-metadata endpoint.
- The server follows at most 5 redirects and checks every hop against the same policy. It does
  not forward authentication headers when a redirect changes the origin. It also authorizes a
  redirect like the request itself (see [Request authorization](#request-authorization)).
- The server does not trust DNS at face value. For each connection it resolves the name once,
  checks every returned address (including IPv4-mapped IPv6, CNAME chains and other numeric
  encodings of an IP address), and connects to an address it checked. A second lookup at
  connect time therefore cannot return a different, forbidden address.
- A base URL or path that changes in an updated spec waits for approval like any other change
  (see above). The server reports it and never applies it on its own.
- The server refuses to send an operator credential (`--header-env`) over plain `http://` to a
  host that is not loopback. `--allow-insecure-http` allows it.

## Credential hygiene

- The server reads secrets only from environment variables, named by `--spec-header-env`,
  `--header-env`, `--upstream-oauth-client-id-env`, `--upstream-oauth-client-secret-env` and
  `--http-token-env`. It never accepts a secret as a literal flag value. A secret therefore
  never appears in the process arguments, which other users of a shared machine can read with
  `ps`. The server never writes a secret to the on-disk cache, and never puts one in logs, tool
  schemas or tool results.
- A referenced variable that is missing or empty at startup stops the server with an error that
  names the variable. There is no silent fallback.
- `--header` is for static headers that are not secret. It refuses sensitive header names:
  `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`, plus any name that
  contains `auth`, `token`, `secret`, `key`, `session`, `credential`, `signature`, `password`,
  `bearer` or `jwt`, in any letter case. Those names must go through `--header-env`. This list
  catches common names but guarantees nothing: an API with an unusual name for its secret
  header could still be misconfigured with `--header`. Use `--header-env` for anything
  sensitive, whatever its name.
- Header names must be unique, ignoring letter case, within the spec-fetch headers
  (`--spec-header-env`) and within the API headers (`--header` and `--header-env`). The two sets
  are separate, so both may set `Authorization`. A duplicate is a usage error. A control
  character (CR or LF) in a header name or value is an error too.
- Cache entries never contain credentials, headers, or URLs with query strings. The cache
  metadata stores a redacted display source: origin and path only.
- The server registers every secret at startup with one central redactor. The redactor runs
  over every output, recursively: tool errors, logs, `doctor`, the status tool, and both text
  and structured tool results.
  - It removes the raw value. For a secret of 8 or more characters it also removes common
    encodings: standard Base64, URL-safe Base64, percent-encoding with upper- or lowercase hex,
    form encoding, and JSON string escaping including `\/`.
  - It skips those encodings for shorter secrets, because a short value matches common
    substrings by accident. One exception remains: a short secret with `"`, `\` or a control
    character also has its JSON-escaped form removed, since that form can appear in a text or
    HTML error body. That form contains an escape the raw value lacks, so it may also match the
    escape in a body without the secret. That redacts more, never less.
  - For a value shaped like an `Authorization` credential (`<scheme> <credential>`, for example
    `Bearer <token>`), it also removes the bare credential. For `Basic` it also removes the
    decoded `user:password` and the password alone, each only when it has 8 or more characters.
    The user name alone does not count as secret.
  - The server rejects an empty secret at startup, so the redactor never silently redacts
    nothing. A secret over 8,192 characters is rejected too.
- The server registers OAuth2 access tokens it obtains at runtime (`--upstream-oauth-*`) with
  the same redactor before their first use, so they are removed like startup secrets.
  - A token stays registered until 60 seconds after it expires. A token response without
    `expires_in` keeps its token registered for a day.
  - The registry holds at most 256 tokens. When it is full, the oldest token that has been
    replaced, and so will never be sent again, makes room. The token in use is never dropped.
    The server never uses a token it could not register.
  - The server fetches at most one replacement token per 30 seconds after a `401`, so an
    upstream that keeps answering `401` cannot flood the authorization server or the registry.
  - The server never repeats a token endpoint's error body. It reports only the HTTP status
    and, if it is one of the codes RFC 6749 registers, the `error` code.
- No tool shows the environment, the configuration or a debug view of a request. Nothing
  returns the resolved secret values over MCP.
- Trace propagation is on by default. The server forwards a client's W3C `traceparent` and
  `tracestate` from a `tools/call`'s `_meta` to the upstream, after strict validation and only
  on hops to the same origin. These headers carry no credentials, but they let the upstream
  link calls across sessions. For a third-party API you do not operate, pass
  `--no-trace-propagation`.
- [Credentials](credentials.md) shows how to set secrets in a terminal without leaving them in
  the shell history (`HIST_IGNORE_SPACE`, `read -s`, secret-manager CLIs).

## Response envelope and redacted errors

- The server checks a successful response against the operation's declared output envelope
  before it returns the response as `structuredContent`. A mismatch in status, shape or media
  type becomes a tool error with a redacted summary. The server never returns structured
  output that does not match the declared schema.
- Response validation and regular expressions (`pattern`). The server validates a response
  synchronously after the upstream call has finished, so the request timeout no longer covers
  that work. To keep its CPU cost bounded, a tool whose response schema has a `pattern` with
  **nested quantifiers** gets no output schema. The tool still works and returns its result as
  text, and its description starts with a sentence that says so. The rules:
  - In response schemas the server enforces a pattern unless it nests quantifiers. A pattern
    nests quantifiers when a group repeated more than once (`*`, `+`, `{n,}`, or `{n,m}` with m
    over 1) contains an unbounded quantifier (`(a+)+`, `(\w+\s?)*`, `(a*){2}`), or when an
    unbounded repetition of a group contains any variable quantifier (`(a?)+`, `(\d{1,3})*`).
    Small bounded nestings stay supported: `(\d{1,3}\.){3}` (IPv4) and `(-[0-9a-f]{4}){3}`
    (UUID).
  - This check counts nesting depth, in the style of the safe-regex library. It errs on the
    side of refusing: some unambiguous patterns, such as `^[a-z]+(-[a-z]+)*$`, are refused too.
    It does not detect overlapping alternatives under a single quantifier (`(a|a)+`) or
    backreferences.
  - In request schemas (tool inputs) the server shows `pattern` and `format` to the model in
    the input schema but never runs them, so they cost no CPU here.
- A response over `--max-response-bytes` (default `10MB`) is a tool error. The server never
  returns a truncated payload that would be silently invalid.
- A binary or unknown media type is a tool error that names the media type. The one exception
  is `--image-responses` (off by default), which returns PNG, JPEG, GIF and WebP images; see
  [Image responses](#image-responses).
- An upstream `4xx` or `5xx` response returns `isError: true` with the status and a short body
  excerpt, which goes through the same central redactor as everything else. A JSON body keeps
  up to the display budget, any other body 1 KB. An HTML page contributes its title and visible
  text, without `<head>`, `<style>` or `<script>`. If decoding its entities rebuilds a
  registered secret, the excerpt is dropped. For `401` and `403` the server drops the body
  entirely and returns a message that names the environment variable to check.
- On stdio, stdout carries only JSON-RPC messages, and every diagnostic goes to stderr. A host
  that reads stdout as the protocol stream never sees log output there.

[Requests and responses](requests-and-responses.md) describes the validation flags and the
error `_meta` in full.

### Image responses

`--image-responses inline` or `file` returns upstream images. Text redaction cannot cover an
image, so these rules apply:

- If a registered secret appears verbatim in the image bytes, as ASCII or UTF-8, the server
  withholds the whole result. It cannot redact an image without breaking it. Metadata in other
  encodings, such as compressed PNG text chunks or EXIF, can still carry data the scan does not
  find. An upstream that controls the image controls what the model sees in it.
- The server recognises formats by their first bytes. It never returns SVG, which can carry
  scripts.
- In `file` mode, the image folder is owner-only: `0700`, or on Windows the ACL inherited from
  the user profile. The server refuses the folder if it is a link or a junction, or if another
  user owns it. If an earlier run left it open to other users, the server sets it back to
  `0700`. It checks the folder again before each write.
- The server picks the file names. It writes each image to a new temporary file, created
  exclusively so that an existing name or link is never written through, and then renames it.
- The image folder is separate from every upload folder, so a saved image cannot be sent
  upstream again through this server.

### Uploads

`--uploads` (off by default) lets a tool argument name a local file that the server reads and
sends upstream. That is a way for data to leave the machine: an agent misled by injected
instructions could try to name a file it should not send. The upload folder is the boundary.

File names must be plain names in one flat folder. The server refuses paths, `..`, drive
letters, `:` (Windows alternate data streams), spaces, non-ASCII characters and Windows device
names, and checks these rules before it opens anything.

To read a file the server:

1. checks that the folder is the same directory as at startup (device and inode),
2. calls `lstat` on the name, which must be a regular file and not a link,
3. opens the file read-only, with `O_NOFOLLOW` where the platform has it,
4. checks that the open handle is the same file (device and inode, compared as 64-bit values)
   and has exactly one link,
5. checks the folder again and reads the bytes through the handle, up to the body limit.

On Windows, Node cannot open a file without following a reparse point. There the device and
inode comparison is what catches a junction, a symlink or a swapped file. The link count
refuses a hard link to a file elsewhere.

A field declared as an image only takes a file whose bytes are that image type.

Whoever can put files in the folder decides what can be sent, because the server may send
anything in it:

- The folder is always `~/.kaisers-io/openapi-mcp/uploads/<api>/`, one per API. `<api>` is the
  same short hash of the spec source (and `--cache-key`) that names the API's cache folder.
- It is owner-only: `0700` on POSIX, and on Windows the private ACL it inherits from the user
  profile (checked in CI).
- The server removes files older than 24 hours from it at startup.
- No option chooses another folder. A folder elsewhere could let other users add files, and on
  Windows Node cannot check its ACL.

The server does not scan uploaded bytes for registered secrets. Keep only files meant to be
sent in the folder.

The server refuses `--uploads` together with a non-loopback `--http-host`, so a remote client
cannot make it send this machine's files.

### Failed writes and retries

An agent that retries a write after an unclear failure can apply it twice. Every tool error of
an API call therefore states what is known about its effect, in
`_meta["openapi-mcp/effect"]` (see [Requests and responses](requests-and-responses.md)).

- `not_sent` means the server refused the call before anything left it. That includes a first
  hop that failed before its request was written.
- `outcome_unknown` covers a failure that may have come after sending. It also covers every
  call that sent more than one attempt, since an earlier attempt may have been applied. A first
  request rejected with `401` and sent again with a fresh OAuth2 token does not count as an
  attempt, because the upstream did not authorize it.

For a write, such an error, and an error for a `2xx` result the server could not return, ends
with a fixed warning not to retry blindly. The server adds this warning itself, whatever the
upstream's error text says, so an upstream cannot suppress it.

## HTTP-mode authentication and limits

`--http` starts a Streamable HTTP server. Binding to `127.0.0.1` alone does not authenticate
callers: any other local process could reach tools that carry your API credentials. So these
rules apply. [Serving over HTTP](http.md) shows the setup.

`--http-token-env <ENV>` is required with `--http` in the default `static` mode. Without it,
startup fails. The opt-in OAuth mode below replaces it.

The token must encode exactly 32 bytes (256 bits), in one of two forms:

- 44 characters of padded standard Base64: the alphabet `A-Z a-z 0-9 + /`, ending in exactly
  one `=`. This is what `openssl rand -base64 32` prints.
- 43 characters of unpadded Base64URL: the alphabet `A-Z a-z 0-9 - _`, with no `=`.

Startup rejects everything else: other lengths, hex strings (`openssl rand -hex 32`), missing or
extra padding, a mix of the two alphabets, and surrounding whitespace or newlines. The format
check cannot tell a random token from a guessable one, so generate the token from a
cryptographically secure random source. Never use a password, a hand-typed string, or a value
derived from other data:

```bash
export TOKEN=$(openssl rand -base64 32)
# or, without openssl:
export TOKEN=$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")
```

The other rules of HTTP mode:

- Clients send `Authorization: Bearer <token>`. The server compares it in constant time: it
  hashes both sides, so a length mismatch does not end the comparison early. This avoids
  timing side channels.
- In the default `static` mode the server binds `127.0.0.1` only. It checks `Origin` and
  `Host` against DNS rebinding. `Host` must be exactly `127.0.0.1:<port>` or
  `localhost:<port>`, with the matching port. Any other value, `[::1]:<port>` included, gets
  `403`. A rebinding page always sends its own host name in `Host`, so the server rejects it.
- The transport speaks MCP revision `2026-07-28` and is stateless. The server handles every
  request on its own, with no `initialize` handshake and no session state; current clients send
  their context in a `_meta` envelope with each request. The SDK answers older (2025) clients in
  the same stateless way. There is no `Mcp-Session-Id`: the server never issues one, never
  expects one, and ignores one a client sends.
- The endpoint accepts only `POST`. `GET` and `DELETE`, which only the old session-based
  transport used, return `405` with an `Allow: POST` header. A client cancels a call by closing
  the request stream; there is no separate cancel call.
- The server rejects a request without valid authentication, and a request body over 4 MiB,
  before any MCP processing. A rate limiter and a cap on concurrent upstream calls bound
  tool-call throughput. Both apply to the whole process, not per session, since there are no
  sessions.
- The server sends no CORS headers. There is no browser use case, so cross-origin browser
  access stays disabled.
- On `SIGINT` or `SIGTERM` the server stops accepting requests and aborts the ones in flight.
  There is no session state to close.

## OAuth resource-server mode (opt-in)

`--http-auth oauth` turns the HTTP transport into an OAuth 2.1 resource server, as the MCP
authorization specification (revision `2026-07-28`) describes. It is the only mode that may
bind an address that is not loopback (`--http-host`). The static token stays the default and
stays loopback-only. [Serving over HTTP](http.md) has a configuration example.

### Discovery

`/.well-known/oauth-protected-resource[/<path>]` serves RFC 9728 Protected Resource Metadata:

| Field | Value |
|---|---|
| `resource` | `--oauth-audience` |
| `authorization_servers` | `--oauth-issuer` |
| `scopes_supported` | `--oauth-required-scope` |
| `bearer_methods_supported` | `header` |

A request without a token gets `401` with
`WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. An invalid token gets `401`
`invalid_token`. A valid token without a required scope gets `403` `insufficient_scope`.

The metadata response carries `cache-control: max-age=3600`. After you change `--oauth-issuer`
or `--oauth-required-scope`, clients may keep using the old document for up to an hour.

### Token validation

The server validates JWT access tokens locally (RFC 9068) against the issuer's JWKS:

- It accepts only asymmetric algorithms: `RS*`, `PS*`, `ES256`, `ES384`, `ES512` and `EdDSA`.
  It rejects `none` and every `HS*` algorithm, so a token signed with the public key used as an
  HMAC secret never verifies.
- The token must name its key (`kid`). The key must fit the algorithm, and its own `alg`, `use`
  and `key_ops` if it publishes them. RSA keys need at least 2048 bits. A token with a `crit`
  header is rejected.
- `iss` must equal `--oauth-issuer` exactly. `aud` must name `--oauth-audience` (RFC 8707
  audience binding). The server compares audiences as normalized URLs: a trailing slash, the
  letter case of scheme and host, a default port and dot segments do not matter, but the letter
  case of the path does.
- `exp` is required. The server checks `exp`, `nbf` and `iat` with 60 seconds of clock skew.
- `typ` may be `at+jwt`, `application/at+jwt`, `JWT` or absent. Any other `typ` is rejected.
- `sub`, `client_id`, `iat` and `jti` are optional. RFC 9068 §2.2 requires them, but widely
  used authorization servers leave some out.
- Each token segment must be canonical base64url.

The server does not support opaque tokens. This version has no token introspection
(RFC 7662).

### Key discovery

At startup the server fetches the authorization server metadata, first by RFC 8414 path
insertion and then by OpenID Connect discovery, the order MCP clients use. The metadata's
`issuer` must equal `--oauth-issuer`.

Metadata and JWKS go through the same DNS-pinned transport as API calls:

- Cloud-metadata addresses are always denied. Private addresses are allowed only on the
  issuer's own origin, which is your decision, or with `--allow-private-network`.
- Each document may be at most 64 KiB, and `--timeout` bounds each fetch.
- Issuer, audience and `jwks_uri` must use `https`. Plain `http` is allowed only for a loopback
  host. Every redirect hop of a metadata or JWKS fetch must meet the same rule.
- `jwks_uri` may carry a query string (for example Entra ID's `?appid=`), and the server fetches
  it exactly as published. Issuer and audience may not carry one.

An authorization server that is unreachable, inconsistent, or has no usable signing key stops
the startup.

### JWKS keys

- The server ignores entries that can never verify a token, so they cannot shadow a signing
  key: encryption keys, `key_ops` without `verify`, unsupported key types, and RSA keys under
  2048 bits.
- A key listed twice, byte for byte, counts once.
- A `kid` that names two different signing keys is dropped, so the order of the entries never
  decides which signature is accepted.
- The server reads at most 100 entries and keeps at most 32 signing keys.

### JWKS cache and refresh

- A fetched key set is fresh for 5 minutes. After that, the server keeps verifying requests
  against it immediately while one refresh runs in the background (stale-while-revalidate).
  No request waits for the authorization server while a usable key set exists.
- A token with an unknown `kid`, which happens during key rotation, waits for an early
  refresh.
- Whatever triggers it, at most one JWKS fetch starts per 30 seconds. The server rejects a
  malformed token, or one with a forbidden header, before it looks at the key cache, so junk
  bearer tokens never cause a fetch.
- A failed refresh (a network error, a status other than 200, a document that is not a JWKS,
  or no usable signing key) keeps the last good key set and logs a warning. The server uses
  that set for at most one hour after it was fetched. After that, requests fail closed with
  `503`.
- A valid but empty key set (`{"keys": []}`) is the authorization server's answer that every
  key is revoked. The server follows it, rejects every token with `401`, and logs a warning
  until a signing key is published again.

### What OAuth mode does not change

- **No token passthrough.** The server reads the client's access token from the
  `Authorization` header only. It never forwards that token upstream and never writes it to
  any output. Upstream credentials are still only yours (`--header-env`, or a token from
  `--upstream-oauth-*`). The server logs rejection causes to stderr, at a limited rate, without
  the token.
- **One upstream identity for everyone.** OAuth here decides who may use this server. It does
  not give each user their own authorization at the upstream API. Every authenticated caller
  acts with your single upstream identity (`--header-env` or `--upstream-oauth-*`), so
  `--oauth-required-scope` is the only per-user control. Without it, any token the issuer
  mints for `--oauth-audience` grants access to every tool. On a non-loopback `--http-host`
  the server says so in a startup warning.
- **No sessions to take over.** The transport is stateless. The server issues no
  `Mcp-Session-Id` and keeps no state between requests, so one caller cannot use another
  caller's session. The server authenticates every request on its own.
- **TLS and the proxy.** `openapi-mcp` does not terminate TLS. Run it behind a reverse proxy
  that serves the `--oauth-audience` URL over `https` and forwards the client's `Host` header.
  The `Host` check accepts exactly the audience's authority, so the server refuses a request
  addressed to any other host with `403` before authentication. It still refuses browser
  `Origin`s. It reads the request body only after the token is valid.
- **Shared limits.** The tool-call rate limit and the cap on concurrent upstream calls apply
  to the whole process, not per user. Every authenticated caller shares them.

## Request authorization

`--allow`, `--deny` and the read-only default decide which operations become tools
([Filtering](filtering.md) explains them). The server checks every request a tool sends against
the same decision, so a tool's arguments or a redirect never reach an excluded operation
(issue #40).

### How a request is matched

Before every hop the server resolves the request's method and path, relative to the API base
URL, against every operation of the spec. That includes exposed operations, filtered-out
operations, operations omitted as unsupported, and operations a pending candidate withholds.
The server reads the path as an upstream would: percent-decoded, with one trailing slash
ignored.

A concrete path matches before a template, as OpenAPI defines. Templates are not ranked against
each other: when two templates match and one of them is not exposed, the server refuses the
request. Matching that ignores letter case can only add a refusal, never allow a request.

The same holds for the ways common servers rewrite a path before routing. The server tries each
of these readings:

- every percent-encoding decoded byte by byte, also twice, and also past bytes that are not
  valid UTF-8,
- `\` taken as a path separator,
- repeated slashes merged,
- `;parameters` cut from a segment or kept (`..;/`),
- dot segments resolved before or after repeated slashes are merged.

So `x%2F..%2F%2Fdenied` counts as `/denied`. The server matches the base path in the same
readings, both in the request and in the configured base URL. An id such as
`group%2Fproject` still reaches its own operation. But no reading may reach an operation that
is not exposed, and a reading that climbs out of the base path counts as leaving the API.

An excluded operation's own path counts in these readings too, so a spec path
`/denied//export` also refuses a request for `/denied/export`.

A spec path with a control character in a static segment is omitted. URL parsing removes tab
and newline, which would turn `.<TAB>.` into `..` and send the request elsewhere.

### The first hop

Hop 0 must resolve to the tool's own operation. `getItem` with `id: "export"` resolves to
`GET /items/export`. When that is another operation, the call fails and the server sends
nothing. When the URL resolves to the tool's own operation and also to one that is not exposed
(two templates that share the URL), the call fails too, and the error says so instead of
blaming the arguments.

A `HEAD` request also counts as a `GET`, because a server may answer it with its GET handler.
An excluded GET operation for the path therefore refuses it.

### Overlapping templates

Startup names each exposed tool whose path can match the same URL as an operation that is not
exposed (issue #41), for example:

```
tool listOrderItems (GET /orders/{orderId}/items): a request that also matches GET /orders/{orderId}/{section}, which is not exposed, is refused; review --allow, --deny and the spec
```

The server finds these overlaps on the templates themselves, with letter case and the readings
above included, not by trying sample values. Under `--strict-filters` an overlap stops the
start. So does an overlap check that ran out of its work budget (a hostile spec), since then
the server cannot show that there is none. An excluded concrete path inside an exposed template
(`/items/export` under `/items/{id}`) is not reported, because that one URL is the other
operation. `openapi-mcp --json tools` lists every pair under `overlaps`.
[Filtering](filtering.md#overlapping-paths) shows what to do about an overlap.

### Redirects

A redirect must resolve to an exposed operation with the method the hop is sent with (a `303`
turns it into a `GET`). The server does not follow a redirect to an excluded operation, or to a
path on the API that matches no operation. The tool error then says that the original request
reached the upstream and may have been applied.

The server does not follow a redirect off the API (another origin, or outside the base path)
unless `serve` runs with `--allow-offsite-redirects`. The egress policy applies either way, and
the server authorizes a later hop back onto the API again.

### Cost and limits

The matching work per hop is bounded. A hop that would need more, such as a hostile spec with
many long templates against a long path, is refused instead of holding up other calls. A hop on
an API with 290 operations uses less than half a percent of the budget.

The checks err on the side of refusing. Matching that ignores letter case, the `HEAD` rule and
the work budget can refuse a request that a particular upstream would have routed to an exposed
operation. Such a call fails with a tool error, and either sends nothing (hop 0) or follows no
further redirect. The server retries none of these refusals.

The check knows only what the spec documents and the readings above. It cannot detect an
upstream that serves an excluded operation under another, undocumented path, that applies a
rewrite of its own (IIS `%u` escapes, a trailing dot, suffix patterns such as `.json`, Unicode
normalization), or that honours a method-override header. For a guarantee that does not depend
on paths, exclude by method: `--deny "method:delete"`.

## Discovery tool mode

`--tool-mode discover` replaces the per-operation tools with `search_operations`,
`describe_operation` and `call_operation` ([Large APIs and tool modes](tool-modes.md) explains
the mode). Its calls go through the same checks as a direct call:

- The discovery tools only ever see the exposed operations, after filtering.
- `call_operation` runs the target through the same rate limit, strict input validation,
  executor and redaction as a direct call. An operation that `--allow`, `--deny` or the
  read-only default excluded is an unknown operation, and the server sends no upstream request.
- Search input is bounded: query length, number of terms, tag list and number of results. The
  server sanitizes and caps every spec string in a search result like any other tool text.
- `call_operation` rejects `arguments: null`. The advertised schema says object, so omit
  `arguments` for an operation without inputs. That keeps the advertised schema and the runtime
  in agreement.

The cost is coarser approval. `call_operation` carries the least safe annotations among
the exposed operations, so a host that asks for approval per tool sees one tool for all of them.
**One approval covers every exposed operation.** In a host that offers "always allow this
tool", allowing `call_operation` once allows every operation the filters expose, writes included
when `--allow` widens the set beyond the read-only default. Use `discover` with the read-only
default, or with an `--allow` set you would approve as a whole. Use
`--tool-mode per-operation` where each write needs its own approval. `serve` prints a startup
warning that names the operations that are not read-only whenever `discover`, or `auto` resolving
to it, exposes any.

With `--http-auth oauth`, the HTTP transport authenticates every MCP request, `call_operation`
included, before it reaches a tool. `--oauth-required-scope` applies to the whole server, not
per operation: a scope cannot grant some operations behind `call_operation` and not others.

### Scripts: `execute_code`

`execute_code` runs a JavaScript program the model writes.
[tool-modes.md](tool-modes.md#scripts-execute_code) explains the tool. Every tool mode lists
it, and `--no-execute` leaves it out. The server treats the program as untrusted code. It runs
the program in a sandbox, and the program reaches the API only through the same checks as a
direct call.

- **The engine.** The program runs in QuickJS, a JavaScript engine compiled to WebAssembly.
  The server starts a new worker thread for each program. The program sees `api.call`,
  `console.log` and the standard JavaScript built-ins. It has no `require`, `import`,
  `process` or `fetch`, no timers, and no access to files, the environment or credentials.
  Values pass between the program and the server as JSON text only.
- **Every call is a whole tool call.** The dispatcher handles each `api.call()` as a
  `call_operation` call under `discover`, or as a call of the operation's own tool under
  `per-operation`. The program reaches only exposed operations. The server validates the
  arguments with the operation's schema and charges each call to `--rate-limit`. The executor
  applies the egress, redirect and size rules, and the dispatcher redacts each result before
  the program sees it. A structured result that holds a registered secret reaches the program
  as an error, so the program never gets the secret to change it past the scan. A text result
  reaches it with the secret replaced, as for a direct call. The server scans the program's own
  result again before it returns it.
- **Reads only.** A program can call only operations whose method is `GET`, `HEAD` or `QUERY`.
  The server refuses any other operation before it sends anything. This check rests on the
  HTTP method, so it does not protect an API whose `GET` changes data. Use `--no-execute` for
  such an API. `execute_code` carries `readOnlyHint: true`.
- **Limits.** The server terminates the program's worker after 30 s, whatever the program is
  doing. It aborts the calls still in flight and never starts the calls still waiting. The
  WebAssembly memory has a fixed maximum, and the engine's heap limit sits below it. In a test,
  the engine's own limit alone let a program grow the process by more than a gigabyte. The
  server also caps the number of calls, the calls in flight, the size of arguments, results
  and log output, and runs at most four programs at once.
  [tool-modes.md](tool-modes.md#limits) lists the values.

With [several APIs](several-apis.md), a program can read from one API and pass what it read
as arguments to another. A model can do the same with two `call_operation` calls, and a
program does it in one step. Each call still uses only its own API's credentials and filters.

A host that asks for approval per tool sees one `execute_code` tool for every read the filters
expose.

## Windows

The spec cache is a trust store: its accepted baseline decides which tools a model gets. On
Linux and macOS POSIX modes keep it private. The server sets every directory to `0700` and
every file to `0600` explicitly, whatever the umask. Windows does not enforce POSIX modes:
`chmod` there only toggles the read-only attribute, and `stat` reports `666` after
`chmod 0600` (measured on `windows-latest`). The same calls run but protect nothing. On
Windows the cache is private through the **access control list (ACL) it inherits** instead:

- The cache lives under `%USERPROFILE%\.kaisers-io\openapi-mcp\` (`os.homedir()`, which reads
  `USERPROFILE`). A standard profile directory grants access only to its owner, `SYSTEM` and
  the `Administrators` group, and new directories inherit that. Another standard user cannot
  read or plant cache entries there. The Windows CI job checks the inherited ACL of a newly
  created cache directory: it must have no `Everyone`, `Users` or `Authenticated Users` entry.
- `openapi-mcp` does not set an ACL itself. If `USERPROFILE` points somewhere else, such as a
  redirected or shared profile, a network drive, or a directory whose ACL was widened, you must
  keep `.kaisers-io\openapi-mcp\` private yourself. The same holds for a `HOME` on a shared
  mount on POSIX. Check it with `icacls "%USERPROFILE%\.kaisers-io"`.
- Administrators and `SYSTEM` can read and change the cache, as root can on POSIX.

The code handles two filesystem differences, so the cache keeps its guarantees:

- **No directory fsync.** Windows refuses `fsync` on a directory with `EPERM`. Node implements
  it as `FlushFileBuffers`, which needs a writable handle that a directory cannot have. The
  server still flushes each file before it renames the file into place, and NTFS journals the
  rename, so after a crash a cache file is the old or the new version, never a torn one. Only
  on Windows does the server read `EPERM` as "no directory barrier". Elsewhere it still fails
  the write.
- **No rename over an open file.** Replacing `meta.json` fails with `EPERM`, and sometimes with
  `EACCES` or `EBUSY`, while any process has it open, such as another `openapi-mcp` reading it
  or a virus scanner. The server retries the rename with a short backoff for at most 2 seconds.
  After that the write fails closed. Linux and macOS make exactly one attempt.

The writer lock (an exclusive hard link) and the stale-lock check (`process.kill(pid, 0)`)
behave the same on Windows as on POSIX (measured).

## What `openapi-mcp` defends, and what you still must do

`openapi-mcp` defends against:

- credential exposure: secrets come only from environment variables and are redacted
  everywhere,
- unbounded or hostile spec parsing: budgets and sanitization,
- silent growth of privileges or behavior from a remote spec that changes: updates wait for
  approval,
- SSRF through the spec's origin or through redirects: deny-by-default egress and DNS pinning,
- unauthenticated local access to your API credentials in HTTP mode: a required bearer token,
  compared in constant time.
- with `execute_code`, a model-written program that tries to reach more than the reads the filters
  expose, or to run without bounds: a sandbox without ambient authority, every call through the
  same checks as a direct call, and fixed limits.

You still must:

- **point `--spec` only at a source you trust**. The server cannot tell a real operation
  description from a prompt-injection payload written in valid English.
- choose `--allow` patterns deliberately instead of exposing write operations by default.
- review a spec's diff before you run `cache promote`.
- use `--no-execute` for an API whose `GET` operations change data: a program can make up to
  50 reads in one tool call.
- treat any `--base-url` you set as an explicit, trusted decision. It skips the private-range
  check that applies to origins taken from the spec.

## Dependency audit (maintainers)

The dependency audit and what to do when it fails are in
[CONTRIBUTING.md](../CONTRIBUTING.md#dependency-audit).

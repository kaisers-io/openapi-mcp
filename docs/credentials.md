# Credentials

This page explains how `openapi-mcp` gets the secrets it needs: a token to download a private
OpenAPI description, a key or token for the API itself, and OAuth2 client credentials. Read it
when you set up a server for an API that needs authentication. The full threat model is in
[security.md](security.md#credential-hygiene).

## Spec credentials and API credentials

The server can need two separate credentials, and you configure them separately.

| Credential | Used for | Flag |
|---|---|---|
| Spec credential | downloading the OpenAPI description from a URL | `--spec-header-env Header=ENV` |
| API credential | every request a tool call sends to the API | `--header-env Header=ENV`, or `--upstream-oauth-*` for OAuth2 client credentials |

The server never sends a spec credential to the API, and it never sends an API credential when it
fetches the spec. If one token works for both, pass it twice, once with each flag. A
`--spec-header-env` only applies to a spec loaded from a URL. With a local file, `serve` stops
with `--spec-header-env only applies to URL spec sources`.

An authenticated spec also needs `--cache-key` or `--trust-spec-updates`. See
[Spec updates and the cache](spec-updates.md#the-cache-key-rule).

## Secrets come from environment variables only

The server reads secrets only from environment variables. You name the variable on the command
line, and the server reads its value at startup. A secret is never accepted as a literal flag
value, so it never appears in the process list (`ps`) or in a committed host config. The server
also never writes a secret to the cache, a log line, a tool schema or a tool result.

| Flag | Environment variable holds |
|---|---|
| `--spec-header-env Header=ENV` | the header value for the spec fetch |
| `--header-env Header=ENV` | the header value for API requests |
| `--upstream-oauth-client-id-env ENV` | the OAuth2 client id |
| `--upstream-oauth-client-secret-env ENV` | the OAuth2 client secret |
| `--http-token-env ENV` | the bearer token clients must send to the HTTP transport (see [http.md](http.md)) |

If a named variable is missing or empty at startup, the server stops at once with a usage error
(exit code 2) that names the variable, for example
`environment variable "API_TOKEN" (for header "Authorization") is not set or empty`. It never
falls back to sending the request without the credential.

How the variable reaches the server depends on your host. Claude Code expands `${VAR}` in
`.mcp.json`. Codex forwards the variables you list by name in `env_vars`. See
[hosts.md](hosts.md).

## Header flag syntax

The two header flags use different separators on purpose.

- `--header-env` and `--spec-header-env` take `Header=ENV`, with an **equals** sign. The part
  after `=` is the *name* of an environment variable, not a value.
- `--header` takes `Header:value`, with a **colon**. The part after `:` is the literal value.
  Spaces around the value are trimmed.

```bash
openapi-mcp serve \
  --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --spec-header-env Authorization=SPEC_TOKEN \
  --header-env Authorization=API_TOKEN \
  --header "Accept-Language:en" \
  --cache-key example-api
```

### The variable holds the complete header value

The server sends the variable's value as the header value, exactly as it is. It does not add a
scheme. For an API that expects `Authorization: Bearer <token>`, the variable must contain the
word `Bearer`, a space and the token:

```bash
read -rs RAW_TOKEN            # type the token; nothing is echoed
export API_TOKEN="Bearer $RAW_TOKEN"
unset RAW_TOKEN
```

For an API key in a header such as `X-API-Key`, the value is the bare key and the flag is
`--header-env X-API-Key=API_KEY`.

### HTTP Basic authentication

`--basic-auth-env API_USER:API_PASSWORD` reads the user name from `API_USER` and the password
from `API_PASSWORD`, and the server sends `Authorization: Basic <base64 of user:password>`. A
secret manager that stores the two as separate fields can fill both variables, for example
`op run` of the 1Password CLI with an env file of `op://` references. For an API that takes a
key as the user name and no password, name only the user variable: `--basic-auth-env API_KEY`.

The user name cannot contain `:`, because HTTP Basic auth separates the two at the first one.
The server treats the header like a `--header-env` credential: it is never sent over cleartext
`http` without `--allow-insecure-http`, it cannot be combined with another `Authorization`
header or `--upstream-oauth-*`, and the redaction covers the header, the user name and the
password. `--header-env Authorization=VAR` with a variable that holds the finished
`Basic <base64 of user:password>` value works as well.

To see what an API expects, run `openapi-mcp tools --spec <url|file>`. It prints one `auth:` line
per security scheme of the spec with the flag to use, for example:

```text
auth: security scheme "apiKeyHeader" (apiKey in header "X-API-Key") — pass --header-env X-API-Key=<ENV>
auth: security scheme "bearer" (http bearer) — pass --header-env Authorization=<ENV> holding "Bearer <token>"
```

An API key in the query string is not supported, because a secret in a URL ends up in logs. The
`auth:` line for such a scheme says so.

## Static headers and sensitive names

`--header` is for static values that are not secret, such as `Accept-Language` or an API
version header. It refuses a header name that looks like a credential, and tells you to use
`--header-env` instead:

```text
openapi-mcp: header "X-Api-Key" looks like a credential — use --header-env instead
```

These names are refused: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, and any
name that contains (in any letter case) `auth`, `token`, `secret`, `key`, `session`,
`credential`, `signature`, `password`, `bearer` or `jwt`. This list catches common names. It
cannot know every API's naming, so use `--header-env` for anything sensitive, whatever its name.
As a second line of defense, the server still redacts every `--header` value of 8 or more
characters from its output.

`--header` also refuses headers the transport manages itself: `Host`, `Content-Length`,
`Content-Type`, `Connection`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Keep-Alive`,
`Proxy-Connection` and `Expect`. It refuses an empty value too.

## Rules for every header

These rules apply to `--header`, `--header-env` and `--spec-header-env`. A violation is a usage
error at startup, before any request is sent.

- A header name must be a valid HTTP token (RFC 9110).
- Header names are unique without regard to letter case. The same name twice in
  `--spec-header-env`, or twice across `--header` and `--header-env`, is an error.
- For API requests, the server accepts at most 32 headers in total, names up to 256 characters,
  values up to 8192 characters, and 65,536 bytes for all names and values together.
- A header value travels as bytes. The server refuses control characters (such as CR and LF)
  and any character above U+00FF. It does so for operator headers at startup and for header
  parameters a tool caller passes on each call, before that call sends anything. Characters
  from U+0080 to U+00FF are allowed and sent as single bytes, which the receiving server reads
  as Latin-1 (ISO-8859-1), not UTF-8. ASCII is the safe choice.

The error messages never print a secret value. They name the environment variable instead.

## Where credentials are sent

The server only sends a credential where you pointed it.

- A spec URL must not carry credentials. A URL with a user name or password in it
  (`https://user:pass@...`) is refused, and so is a query parameter whose name contains `auth`,
  `token`, `secret`, `key`, `session`, `credential`, `cookie` or `signature`. Use
  `--spec-header-env` instead.
- If a spec fetch is redirected to another origin, the server drops the spec credential for that
  hop and every later hop.
- If an API request is redirected to another origin, the server sends only `Accept` and
  `Content-Type` there, never a `--header`, `--header-env` or OAuth2 credential.
- When the spec is fetched from a URL, `--header-env` and `--basic-auth-env` need `--base-url`.
  Otherwise the spec alone would choose where the credential is sent. The server stops at
  startup with exit code 2. A spec file needs no `--base-url` for this.
- When one server serves several APIs (`--api`), each API's credentials go only to that API's
  own base URL. See [several-apis.md](several-apis.md).
- The server refuses to send a `--header-env` value, a `--spec-header-env` value or an OAuth2
  access token over plain `http` to a host that is not loopback (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `::1`). The call or the spec fetch fails without sending anything.
  `--allow-insecure-http` permits it, for an API or a spec you can only reach that way.

Outbound requests also follow an egress policy. An address that comes from the spec (its
`servers` URL) or from a redirect is refused when it is private, loopback or a cloud-metadata
endpoint. `--allow-private-network` permits private and loopback addresses, never cloud
metadata. A `--spec` or `--base-url` you pass yourself may be private or loopback without that
flag. Cloud-metadata addresses are refused everywhere. [security.md](security.md) explains the
full policy.

## Keeping secrets out of shell history

When you test the server in a terminal, keep secrets out of your shell history:

- Start the command with a space. Zsh skips it when `HIST_IGNORE_SPACE` is set, bash when
  `HISTCONTROL=ignorespace` (or `ignoreboth`) is set.
- Use `read -s` to type the value without echo, as in the example above.
- Read the value from a secret-manager CLI, for example 1Password's `op`:

```bash
API_TOKEN="Bearer $(op read op://vault/item/token)" \
  openapi-mcp serve --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --header-env Authorization=API_TOKEN --cache-key example-api
```

## Storing secrets on your computer

A host config should hold variable names, not values. The value still has to live somewhere. The
`configuring-openapi-mcp` agent skill (see [../README.md](../README.md)) proposes a storage
method for your operating system and writes the host config for you. It uses the macOS Keychain,
the Secret Service keyring on Linux, and Credential Manager, DPAPI or VS Code's secret storage on
Windows, with 1Password as an alternative. You type the secret into a prompt in your own
terminal, never into the chat. The steps are in
[`skills/configuring-openapi-mcp/references/`](../skills/configuring-openapi-mcp/references/).

## OAuth2 client credentials

Some APIs do not hand out a long-lived token. Instead you get a client id and a client secret,
and you exchange them for a short-lived access token (the OAuth2 client-credentials grant,
RFC 6749 §4.4). The server can do that exchange for you. Pass both
`--upstream-oauth-client-id-env` and `--upstream-oauth-client-secret-env`; one without the other
is a usage error. The server then gets the access token itself and sends it as
`Authorization: Bearer <token>` on every API request.

This is about the server as an OAuth2 *client* of the upstream API. Protecting the server's own
HTTP endpoint with OAuth is a different feature, `--http-auth oauth`, described in
[http.md](http.md).

```bash
openapi-mcp serve \
  --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com/v1 \
  --upstream-oauth-client-id-env CLIENT_ID \
  --upstream-oauth-client-secret-env CLIENT_SECRET \
  --upstream-oauth-scope orders.read \
  --cache-key example-api
```

### The token URL

The server sends the client secret to the token URL, so it is strict about which URL that is.

- By default the token URL is the `flows.clientCredentials.tokenUrl` of the spec's oauth2
  scheme. A relative URL resolves against the API base URL. If the spec declares several such
  schemes, pick one with `--upstream-oauth-scheme <name>`.
- `--upstream-oauth-token-url <url>` overrides the spec's value.
- A spec token URL on a different origin than the API base URL is a startup error unless
  `--upstream-oauth-token-url` names it. This way you confirm where the secret goes.
- When the spec is fetched from a URL, you must pass `--base-url` or `--upstream-oauth-token-url`.
  Otherwise the spec alone would choose both the API origin and the place the secret is sent.
- The token URL must use `https`. Plain `http` is accepted only for a literal loopback host:
  `localhost`, `127.0.0.0/8` or `::1`, not `*.localhost`. It must not contain a user name,
  password or fragment.
- The token request goes through the same egress policy as API requests. Cloud-metadata
  addresses are always refused, private and loopback addresses need `--allow-private-network`,
  and DNS answers are pinned. The server never follows a redirect from the token endpoint.

### Client authentication and scopes

`--upstream-oauth-client-auth` chooses how the client authenticates to the token endpoint:
`client_secret_basic` (the default, an HTTP Basic header) or `client_secret_post` (the id and
secret in the form body).

The server requests only the scopes you list with `--upstream-oauth-scope` (repeatable, at most
64). It does not infer scopes from the spec's `security` section. With no scope flag, the token
request has no `scope` parameter.

### Token lifetime and caching

- The server keeps tokens in memory only, never on disk.
- It refreshes a token shortly before `expires_in` runs out: 60 seconds before, or 10 % of the
  lifetime before, whichever is smaller. Without `expires_in`, it reuses a token for at most one
  hour.
- Concurrent tool calls share one token request.
- After a failed token request, the server answers from memory with the same failure for
  5 seconds. An authorization-server outage then costs one token request per 5 seconds, not one
  per tool call.

### Timeouts and cancellation

`--request-timeout` bounds the token request. When a call has to wait for a token, the wait
counts against that call's own `--request-timeout` budget. A call that is cancelled or runs out
of time while it waits ends at once with `cancelled` or `timeout` and sends nothing more. The
token request keeps running for the other calls that wait on it.

No request, a `401` replay included, is sent once a call's budget is spent. If the call ends this
way after a `401`, its request was already sent, possibly more than once with `--retries`. For
an operation with an `Idempotency-Key` header, the result therefore still carries
`_meta["openapi-mcp/idempotencyKey"]`, so you can repeat the call with the same key.

### What happens on a 401

When the API answers `401`, the server discards the token, fetches a new one and replays the
request exactly once. A `401` means the request was not authorized, so the replay applies to
writes too. There is one exception: a `401` that comes after a redirect answers the redirected
request, not the original one, which may already have taken effect. The server then replays a
read but never a write.

A second `401` comes back to the caller as usual. Within 30 seconds of such a replacement, a
further `401` keeps the current token and is returned without a replay. An API that rejects
fresh tokens (wrong audience, missing permission) is not fixed by minting more of them.

The replay is separate from `--retries`. The server never retries a `401` as a transient
failure. Retries spent before the `401` do not prevent the replay, and the replay does not use
up a retry. Both stay within the call's `--request-timeout`, and a `POST` or `PATCH` replay
carries the same `Idempotency-Key`.

### Secrets in output

The server never writes the client secret or an access token to the call log, the
`openapi_mcp_status` counters or a tool result. It registers both with its redactor, an access
token as soon as it is issued, before its first use. A token that cannot be registered is never
used. Error messages from the token endpoint are not echoed. A failure shows only the HTTP
status and, if the response carries one of RFC 6749's registered error codes, that code. A call
whose token could not be obtained appears in the call log with the outcome `token_error`.

### Limits

- `--upstream-oauth-*` together with `--header-env Authorization=...` is a usage error, because
  the access token goes into the `Authorization` header.
- The server does not support the authorization-code, device-code and password flows, mTLS, or
  `private_key_jwt`. For an API that needs one of those, get a token elsewhere and pass it with
  `--header-env Authorization=API_TOKEN`, the variable holding `Bearer <token>`.

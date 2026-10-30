# Credentials

Map the `security` of the allowed operations to flags. Every credential reaches the server as
an environment variable that a flag names. Details:
[docs/credentials.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/credentials.md) and
[docs/security.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/security.md#credential-hygiene).

## Contents

- [Reading the spec](#reading-the-spec)
- [Scheme to flag](#scheme-to-flag)
- [Rules for every header](#rules-for-every-header)
- [Upstream OAuth (client credentials)](#upstream-oauth-client-credentials)
- [A spec behind authentication](#a-spec-behind-authentication)
- [Naming variables](#naming-variables)
- [Serving over HTTP](#serving-over-http)

## Reading the spec

`CLI --json tools` gives each operation a `security` list. Any one entry of the list is enough;
the schemes inside one entry are needed together. `[]` needs no credentials, and an entry `{}`
makes them optional. `securitySchemes` names the type of each scheme, and `security` (the
top-level list in the output) gives the flag for each scheme an exposed operation uses, or
`not supported:` with the reason. When no flag covers an exposed operation's `security`,
`check` warns `credentials no configured header satisfies` and names the flag to add. With
`(cannot be met: N schemes each need the one Authorization header)` the spec asks for two
`Authorization` values at once, which no configuration can send.

## Scheme to flag

| Scheme | Flag | The variable holds |
|---|---|---|
| `http` `bearer` | `--header-env Authorization=VAR` | `Bearer <token>` |
| `http` `basic` | `--basic-auth-env USER_VAR:PASSWORD_VAR` | the user name and the password, in two variables |
| `apiKey` in header `X-Key` | `--header-env X-Key=VAR` | the key |
| `apiKey` in cookie `sid` | `--header-env Cookie=VAR` | `sid=<value>`; several cookies joined with `; ` |
| `oauth2` with `clientCredentials` | `--upstream-oauth-client-id-env ID_VAR --upstream-oauth-client-secret-env SECRET_VAR` | client ID, client secret |
| `oauth2` other flows, `openIdConnect` | `--header-env Authorization=VAR` | `Bearer <token>` the user gets elsewhere |

`--header-env` sends the value exactly as stored. For a bearer token the variable must contain
the word `Bearer`, a space and the token. Tell the user this when they store it.

A spec loaded from a URL needs `--base-url` with `--header-env` or `--basic-auth-env`, so that
the spec alone does not decide where the credential goes. Take the URL from the spec's
`servers` and ask the user to confirm it.

Not supported: API keys in the query string, client certificates (`mutualTLS`), and
challenge schemes such as `digest` or `ntlm`. Say so and stop if the allowed operations need
only those.

## Rules for every header

The start fails with a text that names the header when a rule is broken:

| Rule | Reason | Text |
|---|---|---|
| a secret goes in `--header-env`, never `--header` | a secret belongs in a variable, not in the config file | `looks like a credential` for `Authorization`, `Cookie` or a name with `token`, `key`, `secret`, `session`, `password` and similar |
| no `Host`, `Content-Type`, `Content-Length` or other hop-by-hop header | the server sets them per request | `is a hop-by-hop or client-managed header` |
| one source per header, never empty | two values would be ambiguous | `duplicate header`, `is configured via both --header and --header-env`, `has an empty value` |
| at most 32 headers, 64 KiB together, 256 characters per name, 8,192 per value | bounded request size | `too many API headers configured`, `-byte aggregate budget` |
| values in ASCII or Latin-1, without line breaks | HTTP headers cannot carry more | `contains control characters`, `contains a character above U+00FF` |
| a secret longer than `[redacted]` and not part of it, at most 64 secrets per server | the server must find and redact each secret in output | `too trivial to redact safely`, `too many secrets to redact` |

`--basic-auth-env` cannot go with `--header-env Authorization=...` or `--upstream-oauth-*`,
since all three set the one `Authorization` header. Its user name must not contain `:`.

A credential is never sent over `http://` to a host that is not loopback. A call then fails
with `refusing to send a secret header in cleartext`. `--allow-insecure-http` permits it; add it
only if the API has no `https` address and the user accepts that the credential travels in
clear text.

## Upstream OAuth (client credentials)

- Add `--upstream-oauth-scope` once per scope the operations need. The server requests no
  scope by default.
- A spec loaded from a URL needs `--base-url`, or `--upstream-oauth-token-url`, so that the
  spec alone does not decide where the client secret goes.
- A token URL on another origin than the API needs `--upstream-oauth-token-url`. Ask the user
  to confirm that URL.
- With several `clientCredentials` schemes, pick one with `--upstream-oauth-scheme`.
- Do not combine it with `--header-env Authorization=...`.
- Every `--upstream-oauth-*` flag needs both `--upstream-oauth-client-id-env` and
  `--upstream-oauth-client-secret-env`.
- The token URL must use `https` (loopback may use `http`), without user, password or
  fragment. Each scope is one word without spaces or quotes; at most 64 scopes.
- The client authenticates with `client_secret_basic` by default; set
  `--upstream-oauth-client-auth client_secret_post` only if the provider asks for it.

## A spec behind authentication

When the spec URL itself needs a credential, add `--spec-header-env Authorization=VAR` and a
`--cache-key <name>` (1 to 64 letters, digits, `.`, `_`, `-`), unique per account.
`--header-env` does not authenticate the spec fetch. Without a cache key the start fails with
`requires an explicit cache decision`: the cache must not share one entry between accounts.
`--trust-spec-updates` instead of a key accepts every changed spec without review and keeps no
cache; propose it only if the user wants that. `--spec-header-env` works with URL specs only.

The spec URL must not carry a credential itself: user and password in the URL, or a query
parameter such as `token=` or `api_key=`, are refused. Use `--spec-header-env` for them.

The spec URL must use `https`, unless its host is loopback. Over plain `http` the start fails
with `refusing to send a --spec-header-env credential in cleartext`. `--allow-insecure-http`
permits it on `serve`, `check`, `tools` and `cache refresh`. Add it only if the spec has no
`https` address and the user agrees.

## Naming variables

Name each variable after the service and its purpose: `SHOP_API_TOKEN`, `SHOP_CLIENT_SECRET`.
Use letters, digits and `_`, starting with a letter. Never reuse one variable for two services.

## Serving over HTTP

With `--http` the MCP endpoint itself needs a credential. Static mode needs
`--http-token-env VAR`, whose value decodes to exactly 32 bytes (`openssl rand -base64 32`), and
binds `127.0.0.1` only. Every other HTTP flag needs `--http`. A shared, non-loopback server needs
`--http-auth oauth` with `--oauth-issuer`, an `https` `--oauth-audience` and an IP address in
`--http-host`. Without `--oauth-required-scope`, every token the issuer grants for that audience
reaches every tool, and the start warns. `--uploads` and `--image-responses file` are refused
on a non-loopback host. Details:
[docs/http.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/http.md).

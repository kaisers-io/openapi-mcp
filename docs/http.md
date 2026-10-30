# Serving over HTTP

By default `openapi-mcp serve` talks to one host over stdio. This page shows how to run it as a
Streamable HTTP server instead, how to secure it with a static token or as an OAuth resource
server, and how the HTTP endpoint behaves. You need it when a host connects to a URL rather
than starting the server itself, or when several people share one server.

The exact token rules and the full authentication model are in
[security.md](security.md#http-mode-authentication-and-limits). How to point Claude Code or
Codex at the server is in [hosts.md](hosts.md#connecting-over-http).

## Start the server with a static token

`--http` starts a Streamable HTTP server bound to `127.0.0.1` instead of stdio. In the default
`static` mode you must also pass `--http-token-env <ENV>`, the name of an environment variable
that holds the bearer token. Without it the CLI refuses to start with exit code `2`, because
binding to loopback alone does not stop other local processes from calling tools that carry
your API credentials.

```bash
export TOKEN=$(openssl rand -base64 32)
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

Clients send the token as `Authorization: Bearer <token>`. `--port` defaults to `3044`.

## The token

The token must be exactly 32 bytes from a cryptographically secure random source. The server
accepts two encodings of those bytes: padded standard Base64 (what `openssl rand -base64 32`
prints) or unpadded Base64URL. It rejects every other shape at startup, hex included, with
exit code `3`. An unset or empty variable is also exit code `3`. If you have no `openssl`,
Node can generate the token:

```bash
export TOKEN=$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")
```

The format check cannot tell a random token from a guessable one, so never use a password or
a hand-typed string. [security.md](security.md#http-mode-authentication-and-limits) lists the
exact character rules.

## HTTP flags

| Flag | Default | What it does |
|---|---|---|
| `--http` | off (stdio) | Serve over Streamable HTTP instead of stdio. |
| `--port <n>` | `3044` | The port to listen on. |
| `--http-token-env <ENV>` | none | The environment variable that holds the bearer token. Required in `static` mode, refused in `oauth` mode. |
| `--http-auth <mode>` | `static` | `static` (one bearer token from `--http-token-env`) or `oauth` (OAuth resource-server mode). |
| `--http-host <addr>` | `127.0.0.1` | The IP address to bind. Accepted only with `--http-auth oauth`. |
| `--oauth-issuer <url>` | none | The authorization server whose JWT access tokens the server accepts. Required with `oauth`. |
| `--oauth-audience <uri>` | none | This server's public URL. Tokens must carry it in `aud`. Required with `oauth`. |
| `--oauth-required-scope <scope>` | none | A scope every access token must grant. Repeatable. |

The CLI checks these combinations before it loads the spec. Each failure is a usage error
with exit code `2`:

- Any of these flags without `--http`, including an explicit `--port 3044`.
- `--http-host` or an `--oauth-*` flag in `static` mode.
- `--http-token-env` together with `--http-auth oauth`.
- `--http-auth oauth` without both `--oauth-issuer` and `--oauth-audience`.
- An `--oauth-required-scope` value that is not a single OAuth scope token, for example one
  with a space.
- An `--http-host` that is not an IP address. A name such as `localhost` is refused.
- A non-loopback `--http-host` with an `--oauth-audience` that does not start with `https`.

The complete flag reference is in [configuration.md](configuration.md#serve).

## Shared deployments: OAuth resource-server mode

For a server that several people use, `--http-auth oauth` makes it an OAuth resource server.
The server then publishes Protected Resource Metadata and validates JWT access tokens that
`--oauth-issuer` issues for `--oauth-audience`. This is the only mode that may bind a
non-loopback address with `--http-host`, and such an address also needs an `https`
`--oauth-audience`.

The server does not terminate TLS. In this example it runs behind a reverse proxy that serves
`https://mcp.example.com/mcp` over TLS and forwards the client's `Host` header:

```bash
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --header-env Authorization=API_TOKEN \
  --http --http-auth oauth --http-host 0.0.0.0 --port 3044 \
  --oauth-issuer https://auth.example.com/realms/main \
  --oauth-audience https://mcp.example.com/mcp \
  --oauth-required-scope mcp:tools
```

Every caller uses the operator's single upstream credential, here `API_TOKEN`. OAuth decides
who may use this server, not what each person may do at the upstream API. Without
`--oauth-required-scope`, any token the issuer mints for the audience grants every tool, and
the server prints a startup warning about it. `--uploads` and `--image-responses file` cannot
be combined with a non-loopback `--http-host`.

[security.md](security.md#oauth-resource-server-mode-opt-in) describes token validation, key
discovery, the JWKS cache and the deployment rules in full.

## How the endpoint behaves

The server speaks MCP revision `2026-07-28` and is stateless. It serves each request on its
own, with no `initialize` handshake and no session state, so it never issues an
`Mcp-Session-Id` and ignores one a client sends. It answers older, 2025-era clients the same
stateless way.

The endpoint accepts only `POST`. Any other method, such as `GET` or `DELETE`, gets `405`
with an `Allow: POST` header.
A client cancels a call by closing the request stream. There is no separate cancel call. The
server does not check the request path, and the examples use `/mcp`.

The server rejects some requests before any MCP processing:

| Request | Answer |
|---|---|
| No token or a wrong token | `401` |
| In `oauth` mode, a valid token without a required scope | `403` |
| In `static` mode, a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, `[::1]:<port>` included | `403` |
| Any `Origin` header, since there is no browser use case | `403` |
| A body over 4 MB | `400` |

The `Host` check guards against DNS rebinding. In `oauth` mode the server accepts only the
authority of `--oauth-audience` as `Host`.

The tool-call rate limit (`--rate-limit`) and the upstream concurrency cap
(`--max-concurrency`) apply to the whole process, so every client of one HTTP server shares
them. [requests-and-responses.md](requests-and-responses.md) explains how a refused call looks.
On `SIGINT` or `SIGTERM` the server stops accepting requests and aborts the calls in flight.

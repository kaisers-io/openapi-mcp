# Serving several APIs

One `serve` process can serve several APIs, each from its own spec. This page explains how to
declare them, which options apply to one API or to all of them, how the server names their
tools, and how it keeps their credentials apart. You can also run one server per API instead;
separate processes give you separate rate limits, concurrency limits and memory, and
[connecting a host](hosts.md) shows that setup.

## Declaring the APIs

Declare each API with `--api <name>=<source>` instead of `--spec`. A name is 1 to 32
lower-case letters, digits or `-`, and starts with a letter. At most 32 APIs can be declared.

Every per-API option then starts with the API's name and `=`. The server reads exactly that
one prefix, and the rest is the value, the same as for a single API. Turn a per-API switch on
with `--enable <name>=<switch>`.

```json
"args": ["serve",
  "--api", "github=https://raw.githubusercontent.com/github/rest-api-description/<commit>/descriptions/api.github.com/api.github.com.json",
  "--base-url", "github=https://api.github.com",
  "--header-env", "github=Authorization=GITHUB_TOKEN",
  "--allow", "github=tag:repos",
  "--api", "shop=https://shop.example.test/openapi.yaml",
  "--base-url", "shop=https://shop.example.test",
  "--header-env", "shop=Authorization=SHOP_TOKEN",
  "--allow", "shop=path:/orders/**",
  "--enable", "shop=trust-spec-updates",
  "--deny", "method:delete",
  "--tool-mode", "discover"]
```

Here, `github` exposes its `repos` tag and `shop` exposes its order paths. The unnamed
`--deny "method:delete"` applies to both APIs.

## Which options apply where

### Per API

These options take the `<name>=` prefix and apply to that API only:

- `--allow`, `--deny`, `--spec-header-env`, `--cache-key`, `--ttl`
- `--nullable-response-fields`, for example `shop=all`
- `--omit-output-schema`, `--base-url`, `--header-env`, `--basic-auth-env`, `--header`
- every `--upstream-oauth-*` option

These switches are turned on per API with `--enable <name>=<switch>`:

- `allow-private-network`
- `allow-insecure-http`
- `allow-offsite-redirects`
- `trust-spec-updates`
- `default-response-is-error`

### For every API

A `--deny` without a name applies to every API. It can only narrow what each API exposes.

The CLI rejects these as usage errors:

- any other per-API option without a name, such as `--allow "tag:repos"`
- a per-API switch given as a bare flag, such as `--allow-private-network`
- a name that no `--api` declares
- the same single-value per-API option twice for one API, such as two `--base-url github=...`
  (the repeatable ones, such as `--allow` and `--header-env`, may repeat)
- `--spec` together with `--api`
- a reserved API name (see [tool names](#tool-names))

### Once per server

These options are global and take no name: `--tool-mode`, `--rate-limit`,
`--max-concurrency`, `--max-response-bytes`, `--request-timeout`, `--retries`, `--timeout`,
`--strict-filters`, `--log`, `--response-projection`, the output schema options, the image
and upload options, `--tools-page-size` and the HTTP options. All APIs share one
`--max-concurrency` limit and one `--rate-limit` window.

## Tool names

Each tool is named `<api>_<name>`, for example `github_repos_get`. `name:` selectors use the
API's own names, so you write `--allow github=name:repos_get`.

A qualified name stays within 64 characters. A longer one keeps its start and ends with a hash
of the full name. The server decides the names over every operation of the spec, so a name
keeps naming the same operation however the spec is ordered and whatever the filters expose.
A name that fits wins over a shortened one that would land on the same text.

The API names `openapi`, `search`, `describe`, `call` and `execute` are reserved, because they
could form one of this server's own tool names (`openapi_mcp_status`, `search_operations`,
`describe_operation`, `call_operation`, `execute_code`).

The server joins the parts with `_` because the common hosts rewrite `.` in tool names to `_`,
and one of them drops a tool whose rewritten name collides with another. Hosts also add their
own prefix and accept 64 characters, and Cursor accepts 60 for server and tool name together.
In `per-operation` mode, `serve` therefore warns when a qualified name is longer than 50
characters. Shorter API names or `--tool-mode discover` avoid the warning.

In `discover` mode, the names are arguments of `call_operation`, not tool names, and
`search_operations` takes an `api` argument to search one API. See
[tool modes](tool-modes.md).

## Isolation between APIs

Each API keeps its own base URL, headers, OAuth token source, egress policy, filters and
routes. The server sends an API's credentials only to URLs under that API's own base URL,
also when two APIs share an origin. The server refuses a redirect into another API's base path
unless the API enables `allow-offsite-redirects`, and even then it sends the redirected
request without the API's credentials.

The server refuses to start in these cases:

- Two base URLs overlap, meaning one lies within the other.
- Two APIs load the same spec with the same cache key. Give one of them its own
  `--cache-key`.

The server checks shared caches and overlapping `--base-url` values before it touches any
spec or cache. It checks a base URL that comes from a spec once that spec is loaded.

One redactor holds the secrets of every API, so all APIs together may configure at most 64
secret values. The count includes `--header-env` values, `--header` values of 8 characters or
more, `--spec-header-env` values, the HTTP bearer token, and two values for each API that uses
`--upstream-oauth-*` (the client secret and its Basic encoding).

One `execute_code` program can call operations of every API, for example list the orders in
one API and look up their customers in another. Each call in the program uses only its own
API's credentials and filters, and a program can only read. See
[tool-modes.md](tool-modes.md#scripts-execute_code).

## Startup

If any spec fails to load, `serve` does not start.

The tool budget counts the tools of all APIs together. It allows 512 tools in `per-operation`
mode and 4096 with `discover` or `auto`. Each API is also held to the budget on its own; for
that check the server counts the operations its filters expose, including ones it later
leaves out because it cannot build a tool for them. `--tool-mode auto` decides on the total
number of tools.

`check` takes the same `--api` options as `serve` and lists, for each API, its base URL and
the tools it exposes. The `tools` command does not take `--api`, so run it with `--spec` for
one API at a time.

## Status

`openapi_mcp_status` reports the sums over all APIs. Under `apis`, it also reports for each
API its name, title, version, source, tool count, omission count, accepted spec hash, dead
pattern count and the counts of operations that are not exposed.

## Not shared

Inbound OAuth (`--http-auth oauth`) does not follow any API's `allow-private-network`. The
server trusts the issuer's own origin, so a private issuer works, but a `jwks_uri` on another
origin must be public. See [serving over HTTP](http.md).

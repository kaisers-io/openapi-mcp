# Configuration reference

This page lists every command and flag of `openapi-mcp`, with its meaning, default and limits.
Use it to look up a flag. The guides it links to explain how the features behave. The CLI's own
help is the final word: if this page and `openapi-mcp <command> --help` ever disagree, trust the
help, and `openapi-mcp --json help` prints the same options as data.

## Where configuration and files live

`openapi-mcp` has no configuration file of its own. You configure it with command-line flags and
environment variables, which your MCP host passes when it starts the server (`.mcp.json` for
Claude Code, `config.toml` for Codex; see [hosts.md](hosts.md)).

The CLI keeps its files in `~/.kaisers-io/openapi-mcp/` (`%USERPROFILE%\.kaisers-io\openapi-mcp\`
on Windows). It creates every folder there private to you: mode `0700` on macOS and Linux, and on
Windows through the access control list of your user profile (see
[security.md](security.md#windows)).

| Folder | What it holds | Managed by |
|---|---|---|
| `cache/` | the on-disk spec cache | `cache list`, `cache clear` and the other [`cache`](#cache) commands; `doctor` reports it |
| `compile-cache/` | Node's V8 compile cache for the CLI bundle | you (see below) |
| `images/<api>/` | images saved by `--image-responses file` | the server, which deletes its own oldest images above `--image-dir-max-bytes` |
| `uploads/<api>/` | files you put there for `--uploads` | the server, which removes files older than 24 hours at startup |

Every invocation uses `compile-cache/`, including `--version` and `--help`. The first run per user
writes it and is slower, and later starts are faster. `doctor` does not report it and
`cache clear` does not clear it. To reset it, delete the folder. To turn it off, set
`NODE_DISABLE_COMPILE_CACHE=1`, and the CLI then writes nothing there.

`<api>` in the image and upload folders is the name the spec cache uses for the spec source and
`--cache-key`. The server creates those two folders only when you turn the feature on.

## Grammars

Two value formats appear in several flags.

A duration (`--timeout`, `--ttl`, `--request-timeout`, and the window of `--rate-limit`) is a
positive integer followed directly by one unit letter: `s`, `m`, `h` or `d`. Examples are `30s`,
`5m`, `1h` and `2d`. No other units, no zero, no leading zero, no decimals and no spaces are
accepted. A duration may be at most about 24.8 days, which is Node's timer limit. `--ttl` is the
exception: it is never used as a timer, so it may be up to `365d`.

A size (`--max-response-bytes`, `--image-dir-max-bytes`) is a positive integer followed by `B`,
`KB` or `MB`, or a plain integer that counts bytes. Examples are `10MB`, `512KB`, `2048B` and
`2048`. The units are binary: `1KB` is 1,024 bytes and `1MB` is 1,048,576 bytes.

## Global options

These options apply to every command. Put them before the command name, as in
`openapi-mcp --json doctor`.

| Flag | Meaning | Default |
|---|---|---|
| `-V, --version` | print the CLI version | |
| `--json` | print a machine-readable JSON envelope instead of text | off |
| `--verbose` | include stack traces and debug detail on stderr | off |
| `-h, --help` | print the help for the command | |

```bash
openapi-mcp --json doctor
```

## `serve`

`serve` starts an MCP server that offers tools generated from an OpenAPI spec. It talks over
stdio unless you pass `--http`. The flags are grouped below by topic. A flag marked repeatable
can be given several times, and each value adds to the list.

### Spec, cache and filter flags

The spec and cache flags are explained in [spec-updates.md](spec-updates.md), the filters in
[filtering.md](filtering.md).

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--spec <url\|file>` | no | the OpenAPI spec source, JSON or YAML; required unless you use `--api` | |
| `--allow <pattern>` | yes | expose the operations this selector matches, for example `tag:Orders`; see [filtering.md](filtering.md#selectors) | `[]` (the read-only default applies) |
| `--deny <pattern>` | yes | exclude the operations this selector matches, for example `method:delete`; a deny always wins | `[]` |
| `--strict-filters` | no | exit with an error instead of a warning on a dead pattern, on patterns that match values differing only by case, and on a tool whose path overlaps one that is not exposed | off |
| `--spec-header-env <Header=ENV>` | yes | a header for the spec fetch, its value read from the environment variable `ENV`; see [credentials.md](credentials.md) | `[]` |
| `--timeout <duration>` | no | the time limit for the spec fetch, and with `--http-auth oauth` for each fetch of authorization-server metadata and JWKS | `30s` |
| `--ttl <duration>` | no | how long the server uses a cached spec before it checks it again at startup; up to `365d` | `1h` |
| `--cache-key <name>` | no | a name for the cache entry; required for a spec fetched with `--spec-header-env` unless you also pass `--trust-spec-updates`; see [spec-updates.md](spec-updates.md) | none |
| `--trust-spec-updates` | no | accept a changed spec automatically instead of holding it back as a candidate | off |
| `--allow-private-network` | no | allow private and loopback addresses for spec fetch redirects, for API requests to a spec-derived origin or redirect, for the `--upstream-oauth-*` token URL, and with `--http-auth oauth` for the authorization-server metadata and JWKS fetches; cloud metadata and link-local addresses stay refused | off |

### API request and credential flags

How headers and secrets work is in [credentials.md](credentials.md). How requests are built is in
[requests-and-responses.md](requests-and-responses.md).

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--base-url <url>` | no | the base URL for API requests, instead of the one the spec names; an absolute `http` or `https` URL; required with a spec URL and `--header-env` or `--basic-auth-env` | `servers[0]` from the spec |
| `--header-env <Header=ENV>` | yes | an API header whose value is read from the environment variable `ENV`; treated as a secret | `[]` |
| `--basic-auth-env <USER_ENV:PASSWORD_ENV>` | no | HTTP Basic auth: the server builds the `Authorization` header from the user name and the password in these variables; without `:PASSWORD_ENV` the password is empty; see [credentials.md](credentials.md#http-basic-authentication) | none |
| `--header <Header:value>` | yes | a static API header that is not a secret; a name that looks like a credential is refused | `[]` |
| `--allow-insecure-http` | no | allow a `--header-env` or `--spec-header-env` credential over cleartext `http` to an origin that is not loopback | off |
| `--allow-offsite-redirects` | no | follow a redirect that leaves the API base URL (another host, or outside the base path); egress checks still apply, and a later hop back onto the API is checked again; see [security.md](security.md#request-authorization) | off |
| `--no-trace-propagation` | no | do not forward a call's W3C trace context (`_meta.traceparent` and `tracestate`) to the upstream API | forwarded |
| `--upstream-oauth-client-id-env <ENV>` | no | OAuth2 client credentials: the environment variable that holds the client ID; needs `--upstream-oauth-client-secret-env` | none |
| `--upstream-oauth-client-secret-env <ENV>` | no | OAuth2 client credentials: the environment variable that holds the client secret; needs `--upstream-oauth-client-id-env` | none |
| `--upstream-oauth-scheme <name>` | no | the oauth2 `securitySchemes` entry to use when several have a `clientCredentials` flow | the only one |
| `--upstream-oauth-scope <scope>` | yes | a scope to request | none |
| `--upstream-oauth-token-url <url>` | no | a token URL that replaces the spec's `tokenUrl`, or confirms one on another origin; an absolute `https` URL, or `http` for a loopback host ([credentials](credentials.md)) | the spec's `tokenUrl` |
| `--upstream-oauth-client-auth <method>` | no | `client_secret_basic` or `client_secret_post` (RFC 6749 §2.3.1) | `client_secret_basic` |

### Limits, retries and logging flags

What these limits do at runtime is in [requests-and-responses.md](requests-and-responses.md).

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--max-response-bytes <size>` | no | the most bytes of a decompressed upstream response body, and of an outgoing request body; at most `100MB` | `10MB` |
| `--request-timeout <duration>` | no | the time budget for each upstream tool call, time waiting in the queue included; `--timeout` covers the spec fetch instead | `30s` |
| `--retries <n>` | no | retry a transient upstream failure up to `n` times, from 0 to 3, only for requests that are safe to repeat | `0` |
| `--max-concurrency <n>` | no | the upstream calls in flight at once, from 1 to 256; further calls wait in a bounded first-in, first-out queue | `16` |
| `--rate-limit <calls/duration>` | no | the tool calls allowed per sliding window, for example `10/1s` or `600/1h`; `calls` is from 1 to 100,000 | `120/1m` |
| `--log <format>` | no | write one structured line per tool call to stderr; the only format is `json` | off |

### Tool and output schema flags

[tool-modes.md](tool-modes.md) explains the tool modes and the output schema form. The response
flags are explained in [requests-and-responses.md](requests-and-responses.md).

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--tool-mode <mode>` | no | `per-operation`, `discover` or `auto`; see [Tool modes](#tool-modes) | `per-operation` |
| `--no-execute` | no | do not offer `execute_code`, which runs a JavaScript program that calls read-only operations and returns only its result; see [tool-modes.md](tool-modes.md#scripts-execute_code) | offered |
| `--tools-page-size <n>` | no | split `tools/list` into pages of `n` tools, from 1 to 512; only for MCP hosts that follow `nextCursor` | off (all tools in one response) |
| `--output-schema <form>` | no | how output schemas are shown to the host: `inline`, or `defs` (a repeated subschema once under `$defs`); see [Output schema form](#output-schema-form) | `inline` |
| `--no-output-schema-descriptions` | no | show output schemas without their field descriptions | descriptions shown |
| `--response-projection` | no | offer an optional `_fields` argument (JSON Pointers) on tools with a JSON response, so a call returns only the selected fields | off |
| `--default-response-is-error` | no | derive an output schema for an operation that declares a `default` response, assuming that response covers only errors | off |
| `--nullable-response-fields [all\|optional]` | no | let object properties in derived output schemas be `null`, for specs that leave out `nullable`: every property (`all`, also the value of the bare flag) or only those not listed in `required` (`optional`) | off |
| `--omit-output-schema <pattern>` | yes | declare no output schema for the exposed tools this selector matches, for an API whose responses do not match its spec; their results come back as text without response-schema validation | `[]` |
| `--omit-unsupported-parameters <pattern>` | yes | build the exposed operations this selector matches without the optional parameters the server cannot send, instead of omitting them; the agent cannot set those parameters; see [filtering.md](filtering.md#operations-omitted-for-an-optional-parameter) | `[]` |

### Image and upload flags

Both features are explained in [requests-and-responses.md](requests-and-responses.md).

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--image-responses <mode>` | no | what happens to a PNG, JPEG, GIF or WebP image from the upstream: `off` (a tool error), `inline` (an MCP image) or `file` (saved under `images/<api>/` and its path returned); `file` cannot be combined with an `--http-host` that is not loopback; see [Image responses](#image-responses) | `off` |
| `--image-dir-max-bytes <size>` | no | with `--image-responses file`: the most the image folder of one API may hold; the server deletes its own oldest images first; at least `5MB`, the largest size of one image | `100MB` |
| `--uploads` | no | let binary request fields also take `{"file": "<name>"}` for a file read from `uploads/<api>/` instead of base64; cannot be combined with an `--http-host` that is not loopback; see [Binary bodies and uploads](#binary-bodies-and-uploads) | off |

### Several-API flags

[several-apis.md](several-apis.md) explains how one server serves several APIs.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--api <name=source>` | yes | serve one more API: a name and its spec source; replaces `--spec`; at most 32 APIs | none |
| `--enable <name=switch>` | yes | with `--api`: turn a switch on for one API, for example `shop=allow-private-network` | none |

With `--api`, each of these flags starts its value with the API's name and `=`, for example
`--allow github=tag:repos`: `--allow`, `--spec-header-env`, `--ttl`, `--cache-key`,
`--nullable-response-fields`, `--omit-output-schema`, `--omit-unsupported-parameters`,
`--base-url`, `--header-env`, `--basic-auth-env`, `--header`
and every `--upstream-oauth-*` flag. `--deny` may also be given without a name, and then applies
to every API. These switches are set per API with `--enable`: `trust-spec-updates`,
`allow-private-network`, `default-response-is-error`, `allow-insecure-http` and
`allow-offsite-redirects`. Every other flag applies once to the whole server.

### HTTP transport flags

[http.md](http.md) explains how to serve over HTTP, and
[security.md](security.md#http-mode-authentication-and-limits) describes the authentication
model. Every flag in this table except `--http` itself needs `--http`.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--http` | no | serve over Streamable HTTP instead of stdio | off (stdio) |
| `--port <n>` | no | the HTTP port, from 1 to 65535 | `3044` |
| `--http-auth <mode>` | no | `static` (one bearer token from `--http-token-env`) or `oauth` (OAuth resource-server mode, see [security.md](security.md#oauth-resource-server-mode-opt-in)) | `static` |
| `--http-token-env <ENV>` | no | the environment variable that holds the bearer token for HTTP requests; required in `static` mode and refused in `oauth` mode. The token is exactly 32 cryptographically secure random bytes, as padded Base64 or unpadded Base64URL ([rules](security.md#http-mode-authentication-and-limits)) | none |
| `--http-host <addr>` | no | the IP address to bind; accepted only with `--http-auth oauth`, because `static` mode always binds `127.0.0.1`; an address that is not loopback also needs an `https` `--oauth-audience` | `127.0.0.1` |
| `--oauth-issuer <url>` | no | the authorization server whose JWT access tokens the server accepts; required with `--http-auth oauth` | none |
| `--oauth-audience <uri>` | no | this server's canonical resource URI (its public URL), which tokens must carry in `aud`; required with `--http-auth oauth` | none |
| `--oauth-required-scope <scope>` | yes | a scope every access token must grant; also advertised as `scopes_supported` | `[]` |

### Examples

A server with an authenticated spec, an API token and filters:

```bash
openapi-mcp serve \
  --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --spec-header-env Authorization=SPEC_TOKEN \
  --header-env Authorization=API_TOKEN \
  --allow "method:get" --allow "tag:Orders" \
  --deny "method:delete" \
  --cache-key petstore-prod \
  --ttl 1h \
  --timeout 30s \
  --max-response-bytes 10MB
```

The same API over HTTP, with a token of 32 cryptographically secure random bytes. More HTTP
examples, including OAuth resource-server mode, are in [http.md](http.md).

```bash
export TOKEN=$(openssl rand -base64 32)
openapi-mcp serve --spec https://api.example.com/openapi.json --http --http-token-env TOKEN
```

### Tool modes

The tool modes (`per-operation`, `discover` and `auto`), their limits and their costs are
explained in [tool-modes.md](tool-modes.md), and so is `execute_code`.

### Output schema form

`--output-schema` and `--no-output-schema-descriptions`, with their measured savings, are
explained in [tool-modes.md](tool-modes.md).

### Several APIs

Serving several APIs from one server with `--api` is explained in
[several-apis.md](several-apis.md).

### Image responses

`--image-responses` and `--image-dir-max-bytes` are explained in
[requests-and-responses.md](requests-and-responses.md).

### Binary bodies and uploads

Binary request bodies and `--uploads` are explained in
[requests-and-responses.md](requests-and-responses.md).

### Query parameter styles

The supported query parameter styles are listed in
[requests-and-responses.md](requests-and-responses.md).

### `multipart/form-data` bodies

How `multipart/form-data` request bodies become tool arguments is explained in
[requests-and-responses.md](requests-and-responses.md).

## `check`

`check` takes the same flags as `serve`, runs the startup checks of `serve` and reports the
result without serving. To test a host entry, copy its launch command, replace `serve` with
`check`, and run it in the same environment and working directory. The host configuration
itself keeps `serve`.

```bash
openapi-mcp --json check --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --header-env Authorization=EXAMPLE_TOKEN --tool-mode auto
```

`check` runs in two stages.

1. The environment stage lists every environment variable the flags name (`--header-env`,
   `--spec-header-env`, `--upstream-oauth-client-id-env`, `--upstream-oauth-client-secret-env`,
   and `--http-token-env` with `--http`), each as set or missing, never with its value. It lists
   all of them, not only the first missing one. When one is missing, `check` skips the next
   stage and exits with code `2`.
2. The startup stage does what `serve` does before it accepts a connection. It loads the spec,
   applies the filters, resolves and checks the base URL and the OAuth token URL, chooses the
   tool mode and compiles the output schemas. Unlike `serve`, `check` compiles every output
   schema under `discover` too, so it reports now a schema that would fail on its first call.
   With `--http-auth oauth` it also fetches the authorization server's metadata and keys, as
   `serve` does. A failure reports its `code` and `message`, and a [`reason`](#error-reasons)
   when it has one. `check` exits with the exit code of that error.

`check` calls no operation and requests no OAuth token. Like `serve`, it may fetch the spec and
look up the addresses of the base URL and the token URL, and it follows the same spec cache
rules as `tools`. It opens no port, and it neither creates nor cleans the `--uploads` folder.

This report comes from a spec with 70 `GET` operations; `exposed` is cut to three names here.

```json
{
  "ok": true,
  "data": {
    "environment": {
      "status": "ok",
      "variables": [{ "name": "EXAMPLE_TOKEN", "flag": "--header-env", "set": true }]
    },
    "startup": { "status": "ok" },
    "toolMode": "discover",
    "toolModeReason": "count",
    "apis": [{ "baseUrl": "https://api.example.com/", "exposed": ["listItems1", "listItems2", "listItems3"] }],
    "listedTools": ["openapi_mcp_status", "search_operations", "describe_operation", "call_operation"]
  },
  "warnings": ["--tool-mode auto: discover, since 70 operations are exposed (more than 64)"]
}
```

`toolModeReason` is `count` or `size`, and it is present only when `auto` chose the mode. `apis` has
one entry per API, with `name` when `--api` names it. `exposed` lists the tool names of the exposed
operations. `listedTools` lists the tools a host sees, which under `discover` are the five tools
above, or four with `--no-execute`. With `--api`, each variable also carries the `api` it belongs
to. `warnings` holds every warning `serve` prints at startup.

When a stage fails, the `--json` report has `"ok": false`, `environment.status` is `failed` or
`startup.status` is `failed` with an `error` object, and a skipped stage has the status
`skipped`. A failed environment stage has the reason `env_missing`. An error found while the
flags are parsed, such as an unknown flag, uses the general error envelope instead (see
[Exit codes](#exit-codes)). Without `--json`, `check` prints the report as lines and the
warnings go to stderr.

## `call`

`call <tool> --dry-run` shows the request one tool call would send, without sending it. It takes
the same flags as `serve`, plus the call's arguments as a JSON object in `--args-json`
(default `{}`). `<tool>` is the name the host lists, with the API name in front when there are
several APIs. In `discover` mode it is the operation name that `call_operation` takes.

```bash
openapi-mcp --json call createPet --dry-run --args-json '{"name": "Rex"}' \
  --spec https://api.example.com/openapi.json --allow "method:post" \
  --base-url https://api.example.com \
  --header-env Authorization=EXAMPLE_TOKEN
```

`call` checks the arguments as `serve` would, so an invalid argument gets the error text a host
would get, with the code `tool_error` and exit code `3`. A response schema that cannot be
compiled is refused the same way, since `serve` would not send the call either. It then builds the request with the
same steps as `serve` and reports, instead of sending it:

- `method`, `origin` and `path`, and the names of the query parameters (`query`), never their
  values.
- `headers`: every header name. A credential from `--header-env` shows `"credential": "set"`,
  and the OAuth `authorization` header `"credential": "not evaluated"`. No value is printed,
  and a configured secret in an argument is redacted, as in every other output.
- `body`: its media type and size in bytes, or `"none"`. `uploads` names each file read with
  `--uploads`, with its size.
- `checks`: `route` (the operation the path resolves to), `egress` (the address the host
  resolves to, under the same rules as a call) and `budgets` (the size of the URL and the
  headers). Each is `allowed`, `refused` with a `reason`, or `not evaluated` with a `reason`,
  for example when the host does not resolve.
- `notEvaluated`: what only sending can show. That is redirects, the DNS answer at the time of
  sending, the response, the queue and the rate limit of a running server, and with
  `--upstream-oauth-*` the access token and its size.

No request reaches the operation's URL or the OAuth token endpoint. `call` may fetch the spec
and resolve the API host, and it prepares the `--uploads` folder as `serve` does. `call`
without `--dry-run` is refused: it never sends a request. The exit code is `0` when every check
is allowed and `3` when one is refused; the `--json` report then has `"ok": false`.

## `tools`

`tools` previews the tools a spec produces, with the filters applied, and starts no server. It
takes only the spec, cache, filter and output schema flags in the table below, because it never
sends an API request. It has no `--tool-mode` either, so it always applies the 512-tool limit.
An inventory that only `serve --tool-mode discover` can expose fails here; narrow it with
`--allow` and `--deny` to preview it.

| Flag | Repeatable | Meaning | Default |
|---|---|---|---|
| `--spec <url\|file>` | no | the OpenAPI spec source, JSON or YAML | required |
| `--allow <pattern>` | yes | expose the operations this selector matches, for example `tag:Orders`; see [filtering.md](filtering.md#selectors) | `[]` (the read-only default applies) |
| `--deny <pattern>` | yes | exclude the operations this selector matches, for example `method:delete`; a deny always wins | `[]` |
| `--strict-filters` | no | exit with an error instead of a warning on a dead pattern, on patterns that match values differing only by case, and on a tool whose path overlaps one that is not exposed | off |
| `--spec-header-env <Header=ENV>` | yes | a header for the spec fetch, its value read from the environment variable `ENV` | `[]` |
| `--timeout <duration>` | no | the time limit for the spec fetch | `30s` |
| `--ttl <duration>` | no | how long a cached spec is used before it is checked again; up to `365d` | `1h` |
| `--cache-key <name>` | no | a name for the cache entry; required for an authenticated spec | none |
| `--trust-spec-updates` | no | accept a changed spec automatically instead of holding it back | off |
| `--allow-private-network` | no | allow private and loopback redirect targets during the spec fetch; cloud metadata and link-local addresses stay refused | off |
| `--allow-insecure-http` | no | allow a `--spec-header-env` credential over cleartext `http` to an origin that is not loopback | off |
| `--default-response-is-error` | no | derive an output schema for an operation that declares a `default` response, assuming that response covers only errors; see [requests-and-responses.md](requests-and-responses.md) | off |
| `--nullable-response-fields [all\|optional]` | no | let object properties in derived output schemas be `null`: every property (`all`, also the value of the bare flag) or only those not listed in `required` (`optional`) | off |
| `--omit-output-schema <pattern>` | yes | declare no output schema for the exposed tools this selector matches | `[]` |
| `--omit-unsupported-parameters <pattern>` | yes | build the exposed operations this selector matches without the optional parameters the server cannot send | `[]` |

This example uses an operationId glob, which ignores case, so it matches every operationId that
starts with `read`:

```bash
openapi-mcp tools --spec https://api.example.com/openapi.json --allow "operationId:read*"
```

### Tool lines and JSON fields

`tools` prints one line per tool. Some lines end in a marker:

| Marker | Meaning | JSON field |
|---|---|---|
| `[output schema assumes default = error]` | the output schema exists only because of `--default-response-is-error` | `outputSchemaAssumesDefaultIsError: true` |
| `[output schema omitted]` | `--omit-output-schema` removed the output schema | `outputSchemaOptedOut: true` |
| `[N optional parameters left out]` | `--omit-unsupported-parameters` built the tool without parameters the server cannot send | `leftOutParameters`: each with `name`, `in` and `reason` |

With the global `--json` flag each tool is an object. Besides `name`, `method`, `path`,
`summary` and `deprecated`, it carries `outputSchema` (`true` or `false`). With
`--nullable-response-fields`, a tool whose output schema the flag widened carries
`outputSchemaAdmitsNullFields: true`, under either scope. The text output does not mark it,
because with the flag that is nearly every tool. A tool whose output schema was withheld because
a response `pattern` has nested quantifiers (see
[security.md](security.md#response-envelope-and-redacted-errors)), or because a name or value in
a response schema holds a control or bidirectional-override character (see
[security.md](security.md#untrusted-spec-text)), carries `outputSchemaWithheld` with the sentence
its description starts with.

### Operations that are not exposed

Every operation of the spec is either a tool or reported. Both `tools` and `serve` print one
summary line, for example `operations not exposed: 1 excluded by --deny, 1 matched by no --allow,
2 omitted as not supported`. The `--json` envelope lists each one under `data.notExposed`, with
`method`, `path`, `operationId` and `toolName` when it has them, `tags`, a `decision` and a
`reason`:

| `decision` | When |
|---|---|
| `denied` | a `--deny` pattern matches it; `pattern` names the first one |
| `not-allowed` | `--allow` is given and no pattern matches it, for example an operation without an `operationId` under `--allow 'operationId:*'` |
| `read-only-default` | no `--allow` is given and it is not a read (`GET`, `HEAD`, `QUERY`) |
| `omitted` | it is not supported; the reason says why (it is also listed under `data.omitted`, unchanged). `omittableParameters` names the optional parameters `--omit-unsupported-parameters` would leave out, when only those keep it from being a tool |
| `withheld` | a pending candidate spec removed it, until `openapi-mcp cache promote` |
| `head-without-get` | it is a `HEAD`, and every URL it can send also matches a `GET` that is not exposed, so every call would be refused (see [filtering.md](filtering.md#how-a-decision-is-made)) |

`data.overlaps` lists each exposed operation whose path can match the same URL as one that is not
exposed. Request authorization refuses those URLs (see
[security.md](security.md#request-authorization)). `data.overlapCheckComplete` is `false` when
the check ran out of its work budget. That is a warning, and an error under `--strict-filters`.
The `openapi_mcp_status` tool reports the same counts under `notExposedCounts`.

A dead `--allow` or `--deny` pattern that names only an operation omitted as not supported, by
its operationId, tags, or method and path, says so instead of suggesting another operation. A
pattern can name a method that only such an operation declares, for example an OpenAPI 3.2
`SEARCH` with a `servers` override. The 512-tool limit counts the tools that are served: after
the server withholds the operations a pending candidate removed, and without the operations
omitted as not supported and the `HEAD` operations left out as `head-without-get`.

### Credentials the spec asks for

When the exposed operations declare `security` requirements, `tools` prints one `auth:` line per
referenced `components.securitySchemes` entry. The line names the credential the scheme expects
and the flag that supplies it, for example `pass --header-env X-API-Key=<ENV>`. The `--json`
envelope carries the same list as `data.security`, and an entry that cannot be supplied through
`--header-env` has a `reason`. These schemes are reported as unsupported: API keys in the query
string, header API keys whose name is not a valid HTTP header name, challenge and response `http`
schemes (`digest`, `negotiate`, `ntlm`, `hoba`, `mutual`, `scram-*`), mutual TLS, and malformed
schemes. Interactive OAuth flows need a token that you obtain elsewhere. Several cookie schemes
share one `--header-env Cookie=<ENV>` value (`a=1; b=2`). [credentials.md](credentials.md)
explains how to pass each kind.

`serve` warns at startup when none of the configured `--header` and `--header-env` headers
satisfies an exposed operation's requirement. The warning joins the alternatives with `OR` and
the schemes one alternative needs together with `AND`. It reports an alternative that needs two
`Authorization`-based schemes at once as one that a single request cannot meet.

### What each operation does

The `--json` envelope also tells you what each operation does and which credentials it accepts,
so you can choose filters without opening the spec. Every row of `data.tools` and
`data.notExposed` carries these fields where the spec defines them:

| Field | Meaning |
|---|---|
| `operationId`, `tags`, `summary` | from the operation |
| `description` | the operation's description, sanitized and cut at 1,024 characters |
| `security` | the operation's `security`, or the root one. It lists alternatives, any one of which is enough, and each names the schemes it needs together with their scopes, for example `[{"token": []}, {"key": [], "oauth": ["tickets:write"]}]`. `[]` needs no credentials, and a `{}` alternative makes them optional. The field is absent when neither the operation nor the root declares it |

An operation omitted while the spec is read, for example for a cookie parameter, has no
operation to take these fields from and keeps only its identifiers. `data.securitySchemes` lists
each declared scheme with `name`, `type`, `deprecated`, and how many `exposed` and `notExposed`
operations accept it. The CLI reads the first 64 schemes, and `data.securitySchemesDropped`
counts the rest. `data.counts` adds up: `operations` is `exposed` plus every entry of
`notExposed`, which is counted per `decision`.

## `cache`

The `cache` commands inspect and manage the on-disk spec cache in
`~/.kaisers-io/openapi-mcp/cache/`. `cache` itself has no flags besides `-h, --help`. How the
cache and spec updates work is explained in [spec-updates.md](spec-updates.md).

### `cache list`

`cache list` lists the cache entries with their opaque entry IDs. It has no flags.

```bash
openapi-mcp cache list
```

### `cache clear`

`cache clear` removes cache entries. It needs a target or `--all`.

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | clear the entry for this spec source | none |
| `--id <entry-id>` | clear the entry with this opaque entry ID | none |
| `--cache-key <name>` | the cache key to use with `--spec` | none |
| `--all` | remove every cache entry of this user | off |

```bash
openapi-mcp cache clear --spec https://api.example.com/openapi.json --cache-key petstore-prod
openapi-mcp cache clear --id 3f1a9c2b7e4d1a90
openapi-mcp cache clear --all
```

### `cache refresh`

`cache refresh` fetches a spec source again. When the spec changed, it stores the new version as
a candidate, but does not activate it. See [spec-updates.md](spec-updates.md) and
[security.md](security.md).

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | the OpenAPI spec source, JSON or YAML | required |
| `--cache-key <name>` | the cache key | none |
| `--spec-header-env <Header=ENV>` | a header for the spec fetch, its value read from the environment (repeatable) | `[]` |
| `--timeout <duration>` | the time limit for the spec fetch | `30s` |
| `--trust-spec-updates` | accept the changed spec directly instead of storing it as a candidate | off |
| `--allow-private-network` | allow private and loopback redirect targets during the fetch | off |
| `--allow-insecure-http` | allow a `--spec-header-env` credential over cleartext `http` to an origin that is not loopback | off |

```bash
openapi-mcp cache refresh --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

### `cache promote`

`cache promote` accepts the pending candidate spec as the new baseline.

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | the OpenAPI spec source, JSON or YAML | required |
| `--cache-key <name>` | the cache key | none |
| `--hash <digest>` | promote only if the candidate has this content hash | none |

```bash
openapi-mcp cache promote --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

### `cache unlock`

`cache unlock` removes a stale writer lock that a process left behind when it died. Stop the
other `openapi-mcp` processes that use this entry first. If you remove a lock that a running
writer still holds, a second writer can start writing.

The lock records the process ID and host name of its owner. The conflict message and
`cache unlock` report them, and for an owner on the same host they say whether that process is
still running. A lock younger than 60 seconds still needs `--force`, even when its owner looks
dead, because a process in another PID namespace (a container that shares the cache folder) can
look dead from here.

A held lock fails only the commands that change what is accepted: a first use, a new candidate,
`--trust-spec-updates`, `cache promote` and `cache clear`. They fail only after retrying. When a
spec is loaded, they retry for as long as `--timeout` allows, and at least about two seconds.
`cache promote` and `cache clear` retry for about two seconds. A start whose spec is unchanged
serves the verified baseline with a warning instead, and `serve` reports the lock in the
`openapi_mcp_status` tool as `cacheLock: "held"` (another process is writing) or
`cacheLock: "stale"` (the owner looks gone, so run `cache unlock`).

| Flag | Meaning | Default |
|---|---|---|
| `--spec <url\|file>` | unlock the entry for this spec source | none |
| `--id <entry-id>` | unlock the entry with this opaque entry ID | none |
| `--cache-key <name>` | the cache key to use with `--spec` | none |
| `--force` | remove the lock even when it is not known to be stale | off |

```bash
openapi-mcp cache unlock --spec https://api.example.com/openapi.json --cache-key petstore-prod
```

## `help`

`openapi-mcp help [command...]` prints the help text of a command, the same as
`<command> --help`. With `--json` it prints the options of the installed version as data, for
tools that write `openapi-mcp` configurations:

```bash
openapi-mcp --json help            # every command
openapi-mcp --json help serve      # one command
```

```json
{
  "ok": true,
  "data": {
    "version": "0.5.0",
    "name": "openapi-mcp",
    "description": "Turn any OpenAPI spec into a strict, locally running MCP server",
    "arguments": [],
    "options": [{ "flags": "--json", "long": "--json", "description": "machine-readable JSON output", "mandatory": false, "negate": false, "repeatable": false }],
    "commands": [
      {
        "name": "serve",
        "options": [
          {
            "flags": "--tool-mode <mode>",
            "long": "--tool-mode",
            "argument": { "name": "mode", "optional": false },
            "description": "per-operation (one tool per operation), …",
            "mandatory": false,
            "negate": false,
            "default": "per-operation",
            "repeatable": false,
            "choices": ["per-operation", "discover", "auto"]
          }
        ],
        "commands": []
      }
    ]
  },
  "warnings": []
}
```

Each command has `name`, `description`, `arguments` (each with `name`, `required` and
`variadic`), `options` and nested `commands`. Only the top level carries `version`. Each option
has these fields:

| Field | Meaning |
|---|---|
| `flags`, `long`, `short` | as written in the help text |
| `argument` | `name`, and `optional` when the flag may stand alone |
| `mandatory`, `negate` | a required option; a `--no-<name>` option |
| `default` | the value used when the option is absent (`true` for a `--no-<name>` option) |
| `bareValue` | the value of an optional-argument flag given without one (`--nullable-response-fields` means `all`) |
| `repeatable` | the option can be given several times |
| `choices` | the accepted values; when it is absent, the CLI does not list them, which does not mean any value works |
| `perApi` | on `serve`, `check` and `call` with `--api`: `prefix` takes `<api>=` before the value; `prefix-or-all` (`--deny`) applies to every API without one; `enable` is a switch set with `--enable <api>=<switch>` |

## `doctor`

`doctor` prints diagnostics: the CLI and Node versions, the app folder and the cache folder. It
takes only the global options (`--json`, `--verbose`, `-h, --help`) and has no `--spec` flag. To
check a server configuration, use [`check`](#check).

```bash
openapi-mcp doctor
openapi-mcp --json doctor
```

The `--json doctor` output looks like this:

```json
{
  "ok": true,
  "data": {
    "cliVersion": "0.7.1",
    "nodeVersion": "24.12.0",
    "appRoot": "/Users/you/.kaisers-io/openapi-mcp",
    "cacheRoot": "/Users/you/.kaisers-io/openapi-mcp/cache",
    "cacheRootExists": true
  },
  "warnings": []
}
```

## Exit codes

| Code | Meaning | Examples |
|---|---|---|
| `0` | success | |
| `1` | unexpected error; also the startup guard for an unsupported platform or Node version | |
| `2` | usage error | an unknown flag, an invalid flag value, a missing `--base-url`, `--http` without `--http-token-env`, an environment variable `check` finds unset |
| `3` | validation error | an invalid spec, `--strict-filters` with a dead pattern, a case collision or an overlapping tool, a malformed HTTP token, a refused egress target, an invalid argument or a refused check of `call --dry-run` |
| `4` | not found | an unreadable spec file, a missing cache entry, `cache unlock` on an entry without a lock |
| `5` | conflict | a cache lock held by another process, a `cache promote --hash` mismatch |

With the global `--json` flag, `tools`, `call`, `help`, `doctor` and the `cache` commands print
an error as `{"ok": false, "error": {"code": "<code>", "message": "<text>"}}`, with a
`reason` in `error` for the causes listed under [Error reasons](#error-reasons). `check` uses that
envelope only for an error in its flags, such as an unknown flag, and reports any other failure
inside its own report (see [`check`](#check)). Two cases print plain text on stderr whatever the
flags. `serve` does, because its stdout is reserved for MCP messages and stays empty on an
error. The launcher's platform and Node version checks do too, because they run before any
option is parsed, and they exit with `1`.

### Error reasons

Many causes share the code `usage` or `validation`. For the causes you can fix in the config,
the error object also has a `reason`, so a script or an agent can react to it without
matching the message, which may change between versions:

```json
{"ok": false, "error": {"code": "usage", "reason": "env_missing", "message": "environment variable \"SHOP_TOKEN\" (for header \"Authorization\") is not set or empty"}}
```

| `reason` | Raised when |
|---|---|
| `env_missing` | a variable named by an `*-env` flag is unset or empty |
| `base_url_unresolved` | the spec gives no usable API base and `--base-url` is not set |
| `spec_http_401_403` | the spec fetch answered `401` or `403`; a `403` can also mean that the credentials lack a permission |
| `spec_external_ref` | the spec has a `$ref` to another document |
| `filter_no_selector` | an `--allow`, `--deny`, `--omit-output-schema` or `--omit-unsupported-parameters` pattern has no selector |

`tools`, `call`, `cache` and `check` report these reasons, and `check` puts them in the failed
stage. An error without one of these causes has only a `code`. A warning that replaces an error
reports the reason too: when a spec refresh fails with `401` and the cached spec is served
instead, the envelope has `"warningReasons": ["spec_http_401_403"]` next to `warnings`.
`warningReasons` is present only when it is not empty. Tool call errors and the plain-text
errors of `serve` have no reason.

The reasons are part of the stable interface. A new reason may be added in any release;
removing one or changing what it means is a breaking change. `code` and the exit codes stay
as they are.

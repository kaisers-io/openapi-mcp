# openapi-mcp

**Turn any OpenAPI spec into a strict, locally running MCP server.**

`openapi-mcp` is a runtime wrapper, not a code generator: there is no codegen step, no
deployment, no per-API project scaffolding. Point it at an OpenAPI 3.0/3.1 spec (a URL or a
local file) and every allowed operation becomes a validated [MCP](https://modelcontextprotocol.io)
tool that hosts like Claude Code and Codex can call directly.

Four pillars:

- **Strict** — hard-fail on invalid specs, strict schema validation at the tool boundary,
  closed input schemas, deny-wins filtering, read-only by default, fail-closed refresh.
- **Secure** — credentials never appear in argv, tool schemas, tool results, logs, or cache.
  Secrets are read exclusively from environment variables, with central redaction.
- **Zero own config** — all configuration flows through CLI flags and env vars, i.e. through
  your MCP host's own config (`.mcp.json` for Claude Code, `config.toml` for Codex).
  `~/.kaisers-io/openapi-mcp/` holds only caches (the spec cache and Node's compile cache);
  there is no separate config file to maintain.
- **Context-efficient** — filtered tool exposure, concise AI-oriented descriptions, response
  size caps.

> **Trust the spec source.** `openapi-mcp` interprets the OpenAPI document you give it at
> runtime — operation names, descriptions, parameters, and examples all flow into the model's
> context. A hostile or compromised spec is an injection surface: this tool sanitizes and
> caps what it renders, but it cannot semantically filter hostile prose out of a spec you
> chose to trust. **Only point it at a spec source you trust.** As a baseline, the server is
> read-only by default (only `GET`/`HEAD` operations are exposed unless you pass `--allow`),
> and spec updates fetched at runtime are gated behind an explicit `cache promote` (or
> `--trust-spec-updates` for specs you own) rather than applied silently — see
> [Caching & refresh](#caching--refresh) below.

## Install

Requirements: Node.js `^22.19.0 || >=24.11.0`, macOS or Linux. Use the latest patch release of your Node line: older
patches miss its security fixes. Windows is not supported natively (the cache relies on POSIX file permissions and
rename semantics); run it inside [WSL](https://learn.microsoft.com/windows/wsl/). Other POSIX systems (e.g. FreeBSD)
are refused because they are untested, not because they are known to be unsafe.

```bash
npm i -g @kaisers-io/openapi-mcp
```

Then verify the install:

```bash
openapi-mcp --version
openapi-mcp doctor
```

`openapi-mcp doctor` prints CLI/Node versions and the effective cache root — a good first
check when something looks wrong.

The first run per user is slower: it writes Node's V8 compile cache to
`~/.kaisers-io/openapi-mcp/compile-cache/`, which later starts reuse. Set
`NODE_DISABLE_COMPILE_CACHE=1` to turn it off, e.g. where the home directory does not persist.

## Quickstart

Preview the tools a spec would generate, without starting a server:

```bash
openapi-mcp tools --spec https://api.example.com/openapi.json
```

Then run it as an MCP server over stdio. With no `--allow`, only `GET`/`HEAD` operations are
exposed:

```bash
openapi-mcp serve --spec https://api.example.com/openapi.json
```

If the spec has no absolute `servers` URL, add `--base-url <url>`.

Every command accepts `--json` for a stable, machine-readable envelope and `--verbose` for
stack traces on error. Run `openapi-mcp --help` or `openapi-mcp <command> --help` — the CLI's
own help is the authoritative, always-current reference for every flag and default.

## Use as an MCP server

Secrets are supplied through environment variables only, never through argv or a committed
config file. The examples keep the read-only default (no `--allow`); see
[Filtering](#filtering) to expose more. Host examples below always pin an exact version (never `latest`) — an unpinned
version executing with your credentials on every launch is a supply-chain risk; see
[Upgrading](#upgrading).

### Claude Code — stdio (`.mcp.json`)

Claude Code expands `${VAR}` / `${VAR:-default}` in `command`, `args`, and `env`, so secrets
never appear literally in the committed file:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.3.1",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json",
        "--spec-header-env",
        "Authorization=SPEC_TOKEN",
        "--header-env",
        "Authorization=API_TOKEN",
        "--cache-key",
        "petstore",
        "--ttl",
        "1h"
      ],
      "env": {
        "SPEC_TOKEN": "${SPEC_TOKEN}",
        "API_TOKEN": "${API_TOKEN}"
      }
    }
  }
}
```

### Codex CLI — stdio (`config.toml`)

Codex's `config.toml` does **not** expand `${VAR}`: export the secrets in the shell you
launch Codex from, then whitelist their names with `env_vars` so Codex forwards them from its
own environment:

```toml
# ~/.codex/config.toml (or project-scoped .codex/config.toml)
[mcp_servers.petstore]
command = "npx"
args = [
  "-y",
  "@kaisers-io/openapi-mcp@0.3.1",
  "serve",
  "--spec",
  "https://api.example.com/openapi.json",
  "--spec-header-env",
  "Authorization=SPEC_TOKEN",
  "--header-env",
  "Authorization=API_TOKEN",
  "--cache-key",
  "petstore",
  "--ttl",
  "1h",
]
env_vars = ["SPEC_TOKEN", "API_TOKEN"]
```

### HTTP transport (both hosts)

Run the server once with `--http`, then point either host at it as a remote MCP server. See
[HTTP transport](#http-transport) below for the flags.

```bash
export TOKEN=$(openssl rand -base64 32)
npx -y @kaisers-io/openapi-mcp@0.3.1 serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "petstore": {
      "type": "http",
      "url": "http://127.0.0.1:3044/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

Codex (`config.toml`):

```toml
[mcp_servers.petstore_http]
url = "http://127.0.0.1:3044/mcp"
bearer_token_env_var = "TOKEN"
```

Run **one `openapi-mcp` server per API per environment** — dev/stage/prod are separate host
entries with different spec URLs, credentials, and `--cache-key`s, not flags on a shared
server.

A refused call (`--max-concurrency` queue full or wait timed out, or over `--rate-limit`) is a
tool error whose result `_meta` carries `"openapi-mcp/error"` (`overloaded` | `rate_limited`)
and `"openapi-mcp/retryAfterMs"`. Keys under `openapi-mcp/` in `_meta` are part of the public
contract; see [docs/configuration.md](docs/configuration.md).

## Filtering

Tool exposure is controlled with repeatable `--allow`/`--deny` patterns, matched against
three forms (case-sensitive, `*` for a single path segment, `**` for a deep match):

- `readPets`, `read*` — operationId.
- `GET /users/**` — `METHOD /path` (one space between method and path).
- `tag:admin*` — OpenAPI tags.

Rules, no exceptions:

1. `--deny` always wins over `--allow`.
2. Any `--allow` given replaces the default entirely: only matching, non-denied operations
   are exposed (including write operations present at startup).
3. No `--allow` given: read-only default — only `GET`/`HEAD` operations (minus denied ones).

Pass `--strict-filters` to turn a dead pattern (one that matches nothing) into a startup
error instead of a warning — useful once a filter set is stable and you want drift to fail
loudly. Full flag reference: [`docs/configuration.md`](docs/configuration.md).

Patterns match the spec's raw operationId, path and tags, not the generated tool name. A tool
name is the operationId reduced to `[A-Za-z0-9_-]` (at most 64 characters; `repos.get` becomes
`repos_get`, accented letters become their base letter), or method and path when there is no usable operationId
(`GET /users/{id}` becomes `get_users_by_id`). Colliding names get a stable hash suffix.

### Large APIs: `--tool-mode discover`

By default every exposed operation is its own MCP tool, and every tool's schemas are sent to
the model up front — about 30k tokens for DigitalOcean's read-only operations. With
`--tool-mode discover` the server lists three tools instead — `search_operations`,
`describe_operation`, `call_operation` — and `tools/list` stays under 5 KB however many
operations are exposed (up to 4096). Filters, validation and redaction apply exactly as for a
direct call. `--tool-mode auto` picks `discover` above 64 exposed operations. Details and
trade-offs: [Tool modes](docs/configuration.md#tool-modes).

## Secrets

Secrets are read **exclusively** from environment variables named by `--spec-header-env`
(spec fetch), `--header-env` and `--upstream-oauth-client-id-env`/`--upstream-oauth-client-secret-env` (API
requests; the latter for OAuth2 client credentials), and `--http-token-env` (HTTP transport) — never
from argv, config files, or the model context:

- `--spec-header-env Header=ENV` / `--header-env Header=ENV` — **equals** syntax; the value
  comes from the named env var.
- `--header Header:value` — **colon** syntax, for static, non-secret headers only.
  `--header` rejects sensitive header names (`Authorization`, `Proxy-Authorization`, `Cookie`,
  `Set-Cookie`, and any name containing `auth`, `token`, `secret`, `key`, `session`,
  `credential`, `signature`, `password`, `bearer` or `jwt`) — those must use `--header-env`.

For safe terminal testing, avoid leaving secrets in shell history: prefix the command with a
space if your shell has `HIST_IGNORE_SPACE`/`HISTCONTROL=ignorespace` enabled, use `read -s`
to prompt without echoing, or pull the value from a secret-manager CLI (e.g.
`TOKEN=$(op read op://vault/item/token) openapi-mcp serve ...`).

Outbound requests follow an egress policy: an address that comes from the spec (its `servers`
URL) or from a redirect is refused when it is private, loopback or a cloud-metadata endpoint.
`--allow-private-network` permits private and loopback addresses, never cloud metadata. A
`--spec` or `--base-url` you pass yourself may be private or loopback without that flag;
cloud-metadata addresses are refused everywhere.

See [`docs/security.md`](docs/security.md) for the full threat model.

## Caching & refresh

Specs are cached under `~/.kaisers-io/openapi-mcp/cache/<namespace>/` and re-validated at
startup once the TTL has expired (`--ttl`, default `1h`), using conditional requests
(ETag/Last-Modified). A local file is read and hashed on every start; while its bytes match
the accepted baseline, the cached, already validated document is used instead of parsing the
file again. A running server does not refresh its tool list; restart it to pick up a newer
spec.

Refresh is **fail-closed**: the cache holds an accepted baseline and, separately, at most one
pending candidate. A changed spec fetched at runtime is validated and written as a candidate
only — it never activates automatically. The only automatic change is a **removal**: while
the candidate waits, an accepted operation that the candidate no longer has (same method and
path) is withheld, on every start, and listed in a warning and in `openapi_mcp_status`. That
is the fail-safe direction. Operations present in both keep their accepted definition. Paths
are compared with parameter names ignored (`/pets/{petId}` and `/pets/{id}` are the same
operation), and `servers` is not compared: a candidate that only moves the base path (say
`/v1` to `/v2`) withholds nothing, and the move waits for promotion like any other change.
Everything else (new tools, changed descriptions or input schemas, method/path/base-URL
changes, auth-scheme changes) waits for an explicit decision:

```bash
openapi-mcp cache list                                  # list entries + opaque ids
openapi-mcp cache refresh --spec <url|file>              # force a refetch, write a candidate
openapi-mcp cache promote --spec <url|file>               # accept the candidate as baseline
openapi-mcp cache clear --spec <url|file>                 # drop a cache entry
openapi-mcp cache unlock --spec <url|file>                # remove a stale writer lock
```

Pass `--trust-spec-updates` to auto-accept refreshed specs instead (appropriate for an API you
own and control, not a third-party one).

`--cache-key <name>` is **mandatory** for any spec fetched with `--spec-header-env`
(authenticated), unless you pass `--trust-spec-updates` instead — two host entries hitting
the same URL with different credentials must never share cache state, and a durable baseline
is what makes the gated-refresh policy meaningful across restarts. Omitting both is a startup
usage error.

Full flag reference, including duration and size grammar: [`docs/configuration.md`](docs/configuration.md).

## HTTP transport

`--http` starts a Streamable HTTP server bound to `127.0.0.1`, instead of stdio. In the default
static mode, `--http-token-env <ENV>` is **mandatory** with `--http` — the CLI refuses to start
without it, since loopback binding alone does not authenticate local callers:

```bash
export TOKEN=$(openssl rand -base64 32)
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

The token must be exactly 32 bytes from a cryptographically secure random source, encoded as
padded Base64 (what `openssl rand -base64 32` prints) or unpadded Base64URL; any other shape,
including hex, is rejected at startup. Exact rules and an openssl-free generator:
[`docs/security.md`](docs/security.md#http-mode-authentication-and-limits).

Clients must send `Authorization: Bearer <token>`. `--port` defaults to `3044`.

For a shared deployment, `--http-auth oauth` makes the server an OAuth resource server instead:
it publishes Protected Resource Metadata and validates JWT access tokens from `--oauth-issuer`
for `--oauth-audience`. `--http-host` is accepted only in this mode, and a non-loopback address
also needs an `https` `--oauth-audience`. See
[docs/security.md](docs/security.md#oauth-resource-server-mode-opt-in).

The server speaks MCP revision `2026-07-28` and is stateless: each request is served on its
own, with no `initialize` handshake and no session state (no `Mcp-Session-Id`). Older, 2025-era
clients are served the same stateless way. The endpoint is POST-only — `GET` and `DELETE`
return `405`. Cancellation is the client closing the request stream.

## Other options and behaviour

Each is off unless a default or "on" is stated; details in
[`docs/configuration.md`](docs/configuration.md).

- `--request-timeout <duration>` (default `30s`): the budget for each upstream call, queue wait
  included. `--timeout` is separate: it bounds the spec fetch and, with `--http-auth oauth`, the
  authorization-server metadata and JWKS fetches.
- `--retries <n>` (default `0`, at most `3`): retry 429/502/503/504 for `GET`/`HEAD`/`PUT`/
  `DELETE`, and connection errors before any response for `GET`/`HEAD`/`PUT` (never `DELETE`).
  `POST`/`PATCH` are retried only when the operation declares an `Idempotency-Key` header.
- Trace propagation is **on** by default: a valid W3C `traceparent`/`tracestate` from a call's
  `_meta` is forwarded upstream. Pass `--no-trace-propagation` for APIs you do not operate.
- `--log json`: one JSON line per tool call on stderr, without arguments, header values or bodies.
- `--response-projection`: an optional `_fields` argument (JSON Pointers) on JSON tools, so a
  call returns only the selected fields. Adds about 30% to `tools/list`.
- `--tools-page-size <n>`: page `tools/list`. Only for hosts that follow `nextCursor`; other
  hosts would see only the first page.
- `--upstream-oauth-client-id-env` / `--upstream-oauth-client-secret-env`: obtain the upstream
  API's access token with the OAuth2 client-credentials grant.
- Request bodies: JSON, form, `multipart/form-data` and `application/octet-stream` (binary as a
  base64 argument). Query styles: `form`, `deepObject`, `spaceDelimited`, `pipeDelimited`.
  Binary responses are not returned; they are a tool error.
- Results carry selected response headers (`ETag`, same-origin `Location`, rate-limit headers,
  …) and, for paginated `GET` tools, a `pagination.next` hint with the next call's arguments.

[Exit codes](docs/configuration.md#exit-codes): `0` success, `1` unexpected error, `2` usage error, `3` validation error (e.g. an
invalid spec or HTTP token), `4` not found (spec file, cache entry), `5` conflict (cache lock,
candidate mismatch). With `--json`, `tools`, `doctor` and `cache` print an error as
`{"ok": false, "error": {"code", "message"}}`. `serve` always reports errors as text on stderr
(stdout is reserved for MCP), and the platform and Node checks print plain text before any
option is read.

## Upgrading

Host config examples above pin an exact version
(`npx -y @kaisers-io/openapi-mcp@0.3.1 ...`) — **never `latest`**. This process runs with your
API credentials on every launch; letting `npx` silently resolve to whatever was just published
is a supply-chain risk, not a convenience. To upgrade, bump the pinned version number in your
host config deliberately (and re-run `npm i -g @kaisers-io/openapi-mcp` if you installed it
globally instead of invoking via `npx`).

## Development

Requires Node.js `^22.19.0 || >=24.11.0` (the dev pin in `.node-version` is 24) and pnpm `>=11`.

```bash
git clone https://github.com/kaisers-io/openapi-mcp.git
cd openapi-mcp
pnpm install
pnpm build
node packages/cli/bin/openapi-mcp.mjs --help
```

### Benchmarks

`pnpm bench` measures the built CLI (run `pnpm build` first) over stdio, offline: time until the
`initialize` response with an empty and with a warm spec cache, `tools/list` latency and size, peak
RSS (Linux), sequential and parallel `tools/call`s against a local mock upstream with a fixed 20 ms
latency, the upstream connections they open, and `--version` / `tools` timings. Fixtures are the
petstore test spec plus synthetic specs generated by `scripts/bench/fixtures.ts`; it prints a JSON
report.

```bash
pnpm build
pnpm bench --runs 5 --out report.json                  # the CI suite (--suite ci)
pnpm bench --suite heavy                               # the full-size reproductions from the perf issues
pnpm bench --suite public                              # DigitalOcean, GitHub, Stripe (downloads once, pinned by commit + sha256)
# Compare two builds on the same machine, interleaved:
pnpm bench --cli head=packages/cli/bin/openapi-mcp.mjs --cli base=../main/packages/cli/bin/openapi-mcp.mjs --out ab.json
pnpm bench:compare ab.json --base base --baseline scripts/bench/baseline.json
```

The `bench` CI workflow builds the pull request's base in the same job and runs both builds
interleaved on that one runner. A timing or RSS metric fails the job only when both its median and
its minimum regress by more than the threshold in `scripts/bench/stats.ts` (25% for time, 15% for
RSS) and by more than a small absolute floor. `tools/list` bytes are machine-independent, so they
are gated against the committed `scripts/bench/baseline.json` instead, exactly: any difference,
up or down, fails until the baseline is updated. A percentage threshold would let a series of pull
requests each add a little without anyone accepting the total. When such a change is intended,
update the baseline in the same pull request with `pnpm bench:baseline` and say why in the
description. The parallel batch sends as many calls as `serve` admits at once (16), so it measures
concurrent throughput; any refused call fails the gate (`parallelErrors`).

## Documentation

- [`docs/configuration.md`](docs/configuration.md) — every flag, grouped by command, with its
  meaning, default, and an example.
- [`docs/security.md`](docs/security.md) — the threat model: untrusted spec text, the egress
  trust boundary, credential hygiene, and HTTP-mode authentication.

## License

MIT

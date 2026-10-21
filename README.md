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
  `~/.kaisers-io/openapi-mcp/` is cache-only; there is no separate config file to maintain.
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

Requirements: Node.js `>=24.11`, macOS or Linux.

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

The GitHub repository is currently private, so `npm i -g @kaisers-io/openapi-mcp` and the
`npx` invocations below only work for accounts with registry/repo access until
`openapi-mcp` goes public.

## Quickstart

Preview the tools a spec would generate, without starting a server:

```bash
openapi-mcp tools --spec https://api.example.com/openapi.json
```

Then run it as an MCP server over stdio, exposing only read operations:

```bash
openapi-mcp serve --spec https://api.example.com/openapi.json --allow "read*"
```

Every command accepts `--json` for a stable, machine-readable envelope and `--verbose` for
stack traces on error. Run `openapi-mcp --help` or `openapi-mcp <command> --help` — the CLI's
own help is the authoritative, always-current reference for every flag and default.

## Use as an MCP server

Secrets are supplied through environment variables only, never through argv or a committed
config file. Host examples below always pin an exact version (never `latest`) — an unpinned
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
        "-y", "@kaisers-io/openapi-mcp@0.3.1", "serve",
        "--spec", "https://api.example.com/openapi.json",
        "--spec-header-env", "Authorization=SPEC_TOKEN",
        "--header-env", "Authorization=API_TOKEN",
        "--allow", "read*",
        "--cache-key", "petstore",
        "--ttl", "1h"
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
  "-y", "@kaisers-io/openapi-mcp@0.3.1", "serve",
  "--spec", "https://api.example.com/openapi.json",
  "--spec-header-env", "Authorization=SPEC_TOKEN",
  "--header-env", "Authorization=API_TOKEN",
  "--allow", "read*",
  "--cache-key", "petstore",
  "--ttl", "1h",
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

## Secrets

Secrets are read **exclusively** from environment variables named by `--spec-header-env`
(spec fetch), `--header-env` (API requests), and `--http-token-env` (HTTP transport) — never
from argv, config files, or the model context:

- `--spec-header-env Header=ENV` / `--header-env Header=ENV` — **equals** syntax; the value
  comes from the named env var.
- `--header Header:value` — **colon** syntax, for static, non-secret headers only.
  `--header` rejects sensitive header names (`Authorization`, `Cookie`, and anything matching
  `auth`/`token`/`secret`/`key`/`session`/`credential`/`cookie`/`signature`) — those must use
  `--header-env`.

For safe terminal testing, avoid leaving secrets in shell history: prefix the command with a
space if your shell has `HIST_IGNORE_SPACE`/`HISTCONTROL=ignorespace` enabled, use `read -s`
to prompt without echoing, or pull the value from a secret-manager CLI (e.g.
`TOKEN=$(op read op://vault/item/token) openapi-mcp serve ...`).

See [`docs/security.md`](docs/security.md) for the full threat model.

## Caching & refresh

Specs are cached under `~/.kaisers-io/openapi-mcp/cache/<namespace>/` and re-validated at
startup once the TTL has expired (`--ttl`, default `1h`), using conditional requests
(ETag/Last-Modified). A running server does not refresh its tool list; restart it to pick up
a newer spec.

Refresh is **fail-closed**: the cache holds an accepted baseline and, separately, at most one
pending candidate. A changed spec fetched at runtime is validated and written as a candidate
only — it never activates automatically. The only automatic change is a **removal**: while
the candidate waits, an accepted operation that the candidate no longer has (same method and
path) is withheld, on every start, and listed in a warning and in `openapi_mcp_status`. That
is the fail-safe direction. Operations present in both keep their accepted definition.
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

`--http` starts a Streamable HTTP server bound to `127.0.0.1` only, instead of stdio.
`--http-token-env <ENV>` is **mandatory** with `--http` — the CLI refuses to start without it,
since loopback binding alone does not authenticate local callers:

```bash
export TOKEN=$(openssl rand -base64 32)
openapi-mcp serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

Clients must send `Authorization: Bearer <token>`. `--port` defaults to `3044`.

The server speaks MCP revision `2026-07-28` and is stateless: each request is served on its
own, with no `initialize` handshake and no session state (no `Mcp-Session-Id`). Older, 2025-era
clients are served the same stateless way. The endpoint is POST-only — `GET` and `DELETE`
return `405`. Cancellation is the client closing the request stream.

## Upgrading

Host config examples above pin an exact version
(`npx -y @kaisers-io/openapi-mcp@0.3.1 ...`) — **never `latest`**. This process runs with your
API credentials on every launch; letting `npx` silently resolve to whatever was just published
is a supply-chain risk, not a convenience. To upgrade, bump the pinned version number in your
host config deliberately (and re-run `npm i -g @kaisers-io/openapi-mcp` if you installed it
globally instead of invoking via `npx`).

## Development

```bash
git clone https://github.com/kaisers-io/openapi-mcp.git
cd openapi-mcp
pnpm install
pnpm build
node packages/cli/bin/openapi-mcp.mjs --help
```

## Documentation

- [`docs/configuration.md`](docs/configuration.md) — every flag, grouped by command, with its
  meaning, default, and an example.
- [`docs/security.md`](docs/security.md) — the threat model: untrusted spec text, the egress
  trust boundary, credential hygiene, and HTTP-mode authentication.

## License

MIT

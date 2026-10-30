# Connecting a host

A host is the program that starts `openapi-mcp` and gives its tools to a model, such as Claude
Code, Codex, Claude Desktop, Cursor, VS Code or Gemini CLI. This page shows a working entry for
each of them, how each host passes credentials to the server, and what changes on Windows and
over HTTP. Read it when you add `openapi-mcp` to a host or a host cannot start it.

## Before you start

- Give secrets to the server through environment variables only, never in `args` or in a
  committed config file. `--header-env Authorization=API_TOKEN` tells the server to read the
  header value from the variable `API_TOKEN`. [credentials.md](credentials.md) explains the
  options.
- The examples keep the read-only default and pass no `--allow`. See
  [filtering.md](filtering.md) to expose more operations.
- Every example pins an exact version, never `latest`. See [Upgrading](#upgrading) for the
  reason.
- `--cache-key` names the cache entry of a spec. It is required for a spec fetched with
  `--spec-header-env` unless you pass `--trust-spec-updates`.
  [spec-updates.md](spec-updates.md) explains the cache. `--ttl 1h` in the examples is the
  default, written out to show where it goes.

## How each host passes variables

Each host has its own rule for getting a variable from your environment to the server. A
variable that the host does not pass arrives empty, and the server cannot authenticate.

| Host | Config file | Server key | How a variable reaches the server |
|---|---|---|---|
| Claude Code | `.mcp.json` or `~/.claude.json` | `mcpServers` | `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers`. |
| Codex | `~/.codex/config.toml` or `.codex/config.toml` | `mcp_servers` | No expansion. Codex passes a fixed set such as `HOME` and `PATH`, plus the names in `env_vars`. |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | The app does not load your shell profile. Use a start script. |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers` | `${env:NAME}` expands in `command`, `args`, `env`, `url` and `headers`. |
| VS Code | `.vscode/mcp.json` or the user `mcp.json` | `servers` | `${input:id}` asks once and stores the value. `${env:NAME}` reads VS Code's environment. |
| Gemini CLI | `.gemini/settings.json` or `~/.gemini/settings.json` | `mcpServers` | `$VAR` and `${VAR}` expand in `env`. Inherited credential-like names are removed. |

## Claude Code

Claude Code expands `${VAR}` and `${VAR:-default}`, so the secret never appears in the
committed file:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.7.1",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json",
        "--base-url",
        "https://api.example.com",
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

An unset variable without a default stays as the literal text `${VAR}`, and `claude mcp list`
warns about it.

The entry can live in three scopes:

| Scope | File | Applies to |
|---|---|---|
| project | `.mcp.json` in the repository root | everyone who uses the repository |
| local, the default of `claude mcp add` | `~/.claude.json`, under the project | you, in this project |
| user | `~/.claude.json`, top level | you, in every project |

Claude Code uses the first scope that has a server of that name, in the order local, project,
user. It does not merge entries. Use project scope for a team and local scope for a personal
setup. To write an entry with the CLI, run
`claude mcp add-json --scope project petstore '<the inner object>'`. With a start script that
loads the credentials, `command` is the script's absolute path, `args` is empty and you leave
out `env`.

To check the server, run `claude mcp list` or `claude mcp get petstore` in a terminal, or
`/mcp` in a session. The states mean:

- Connected: the server works.
- Failed: the server exited or timed out. `claude mcp get petstore` shows the reason.
- Needs authentication: `openapi-mcp` does not use this over stdio.
- Pending approval: a project server waits until you approve it in an interactive session.
  `claude mcp reset-project-choices` asks again after you rejected it.

The tools appear as `mcp__petstore__<tool>`. `claude --debug=mcp` prints connection details,
including the server's stderr. On macOS each server's log is under
`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-petstore/`. `MCP_TIMEOUT` in
milliseconds raises the startup timeout, for example `MCP_TIMEOUT=60000 claude`. Claude Code
cuts tool output over 25,000 tokens, and `MAX_MCP_OUTPUT_TOKENS` raises that limit. After you
change the entry, run `/mcp` and reconnect, or restart Claude Code.

## Codex

Codex's `config.toml` does not expand `${VAR}`. Export the secrets in the shell you start Codex
from, then list their names in `env_vars` so Codex forwards them:

```toml
# ~/.codex/config.toml (or project-scoped .codex/config.toml)
[mcp_servers.petstore]
command = "npx"
args = [
  "-y",
  "@kaisers-io/openapi-mcp@0.7.1",
  "serve",
  "--spec",
  "https://api.example.com/openapi.json",
  "--base-url",
  "https://api.example.com",
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
startup_timeout_sec = 60
```

- `~/.codex/config.toml` applies to every project. Codex reads `.codex/config.toml` in a
  project only when you trust the project. The CLI, the desktop app and the IDE extension share
  these files.
- Codex passes only a fixed set of variables, such as `HOME` and `PATH`, plus the names in
  `env_vars`. A token that is not listed there does not arrive, even when your shell has it.
- Never put a secret into `env`. It holds literal values. For the same reason, write the entry
  yourself instead of using `codex mcp add`, which writes literal `--env` values.
- The first `npx` download can take longer than the default startup timeout, hence
  `startup_timeout_sec = 60`.
- With a start script that loads the credentials, `command` is the script's absolute path and
  `args` is empty.
- `enabled_tools` and `disabled_tools` act on the tools the host lists. Under
  `--tool-mode discover` those are the discovery tools and `execute_code`, so
  restrict operations with
  `--allow` and `--deny` instead.
- `openapi-mcp` does not use an HTTP proxy for spec fetches or API calls, so `HTTPS_PROXY`
  in `env_vars` does not route its traffic through a proxy.

Run `codex mcp list` or `codex mcp get petstore` in a terminal, or `/mcp` in a session. A
listed server is not necessarily running. `/mcp` in a session shows whether it started. The
log location depends on the Codex version: look in `~/.codex/log/` and, in newer versions, in
`~/.codex/logs_2.sqlite`. `RUST_LOG=debug codex` writes more detail. After a change, quit
Codex and start it again from a terminal that has the variables set.

## Claude Desktop

The config file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Settings, Developer, Edit Config
opens it.

Claude Desktop starts from the Dock or the Start menu and does not load your shell profile.
Variables you export in `~/.zshrc` do not reach the server, and its `PATH` may not contain
`node`. Use a start script that loads the credentials, sets `PATH` and starts the CLI:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "/Users/<name>/.config/openapi-mcp/petstore.sh",
      "args": []
    }
  }
}
```

A server without credentials can skip the script. Set `command` to the absolute path of the
`npx` next to `node`, keep the usual `args`, and add a `PATH` that holds that directory,
because `npx` starts `node` through `PATH`:

```json
"env": { "PATH": "/Users/<name>/.nvm/versions/node/v24.11.0/bin:/usr/bin:/bin" }
```

Take the directory from `dirname "$(node -p process.execPath)"`. `command -v node` can name a
version manager's shim that only works in its shell.

Quit Claude Desktop completely and open it again after every change. The tools appear in the
tools menu of a new chat. The logs are `~/Library/Logs/Claude/mcp.log` and
`mcp-server-petstore.log` on macOS, and the folder `%APPDATA%\Claude\logs\` on Windows.

## Cursor

The entry goes into `.cursor/mcp.json` in a project or `~/.cursor/mcp.json` for every project.
Cursor expands `${env:NAME}`:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@0.7.1", "serve", "--spec", "https://api.example.com/openapi.json", "--base-url", "https://api.example.com", "--header-env", "Authorization=API_TOKEN"],
      "env": { "API_TOKEN": "${env:API_TOKEN}" }
    }
  }
}
```

- `"envFile": "/absolute/path/petstore.env"` loads variables from a file for a stdio server.
  Keep that file out of the repository.
- Cursor started from the Dock may not have your shell's variables or `PATH`. Use a start
  script that loads the credentials and starts the CLI as `command` then.

Cursor Settings, MCP lists each server with its state and tools. After a change, turn the
server off and on there, or restart Cursor.

## VS Code

The entry goes into `.vscode/mcp.json` in a workspace, or into the user profile's `mcp.json`,
which the command "MCP: Open User Configuration" opens. The key is `servers`, not
`mcpServers`, and each stdio server has `"type": "stdio"`:

```json
{
  "inputs": [
    { "type": "promptString", "id": "petstore-token", "description": "Petstore API token, starting with Bearer", "password": true }
  ],
  "servers": {
    "petstore": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@0.7.1", "serve", "--spec", "https://api.example.com/openapi.json", "--base-url", "https://api.example.com", "--header-env", "Authorization=API_TOKEN"],
      "env": { "API_TOKEN": "${input:petstore-token}" }
    }
  }
}
```

- An input with `"password": true` asks once, and VS Code stores the value. The value never
  appears in the file. This is the recommended way in VS Code.
- `${env:NAME}` reads a variable of the VS Code process, and `envFile` loads a file.
- Some agent modes do not start servers that need `${input:...}`. If the server does not start
  there, use `envFile` or a start script that loads the credentials and starts the CLI.

"MCP: List Servers" shows each server, and "Show Output" opens its log. After a change,
restart the server from that list.

## Gemini CLI

The entry goes into `.gemini/settings.json` in a project or `~/.gemini/settings.json` for
every project:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": ["-y", "@kaisers-io/openapi-mcp@0.7.1", "serve", "--spec", "https://api.example.com/openapi.json", "--base-url", "https://api.example.com", "--header-env", "Authorization=API_TOKEN"],
      "env": { "API_TOKEN": "$API_TOKEN" },
      "timeout": 60000
    }
  }
}
```

- Before it starts a server, Gemini CLI removes inherited variables whose names contain
  `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `AUTH` or `CREDENTIAL`. Name every credential variable
  in `env`, as above, or it arrives empty.
- Gemini CLI expands `$VAR` and `${VAR}` in `env`. An unset variable becomes an empty string.
- `includeTools` and `excludeTools` act on the listed tools. Restrict operations with
  `--allow` and `--deny` instead.

`/mcp` in a session lists each server with its state and tools, and `gemini mcp list` does the
same in a terminal. Restart Gemini CLI after a change.

## Windows hosts

Native Windows support starts with version 0.4.0. Earlier versions refuse to install on
Windows.

On Windows, `npx` and a globally installed `openapi-mcp` are `.cmd` scripts, not executables.
A host that resolves the command itself takes the configs above unchanged. Claude Desktop's own
Windows example uses `"command": "npx"`. A host that starts the command directly, without a
shell, cannot run a `.cmd` file. The server then never starts, and the host log shows `ENOENT`,
`EINVAL` or just "client closed". Node has refused to spawn `.cmd` files without a shell since
its April 2024 security release. Start the server through `cmd /d /c` instead. The `/d` switch
skips `cmd`'s AutoRun commands, which could print into the MCP stream:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "cmd",
      "args": [
        "/d",
        "/c",
        "npx",
        "-y",
        "@kaisers-io/openapi-mcp@0.7.1",
        "serve",
        "--spec",
        "C:\\specs\\petstore.json",
        "--cache-key",
        "petstore"
      ]
    }
  }
}
```

In Codex the same form is `command = "cmd"` with `args = ["/d", "/c", "npx", ...]`.

- JSON needs doubled backslashes. `--spec` takes absolute drive paths (`C:\specs\x.json`,
  `C:/specs/x.json`) and UNC paths (`\\server\share\x.json`). The CLI refuses a drive-relative
  path such as `C:x.json` like any other scheme-like value, so give the full path.
- `cmd` reads `&`, `|`, `<`, `>`, `^` and `%` in arguments as its own syntax. Keep them out of
  `args`. Secrets belong in `env` anyway.
- The config files on Windows are `%APPDATA%\Claude\claude_desktop_config.json` for Claude
  Desktop (`mcpServers`), `.vscode/mcp.json` for VS Code (`servers`, each with
  `"type": "stdio"`) and `%USERPROFILE%\.cursor\mcp.json` for Cursor (`mcpServers`).
- GUI hosts may not see your terminal's `PATH`. If the host cannot find `npx`, give its full
  path. Or install the package globally and run `node` with the full path of the installed
  `bin\openapi-mcp.mjs`, under `%APPDATA%\npm\node_modules`.
- The host stops the server by closing its stdin. `openapi-mcp` treats that as a clean
  shutdown on every platform.

[security.md](security.md#windows) explains how the cache stays private on Windows.

## Connecting over HTTP

Instead of letting each host start its own process, you can run the server once with `--http`
and point a host at its URL. [http.md](http.md) explains the flags and the token.

```bash
export TOKEN=$(openssl rand -base64 32)
npx -y @kaisers-io/openapi-mcp@0.7.1 serve --spec https://api.example.com/openapi.json \
  --http --http-token-env TOKEN --port 3044
```

The host needs the same `TOKEN` in its environment. Claude Code (`.mcp.json`):

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

Codex (`config.toml`) reads the token from the variable that `bearer_token_env_var` names and
sends it as `Authorization: Bearer <token>`:

```toml
[mcp_servers.petstore_http]
url = "http://127.0.0.1:3044/mcp"
bearer_token_env_var = "TOKEN"
```

## One server per API, or several APIs in one server

You can run one `openapi-mcp` process per API, or serve several APIs from one process with
`--api <name>=<source>`. Both work. One process keeps each API's base URL, credentials,
egress policy and filters apart, but the APIs share one tool budget, one rate limit and one
concurrency cap. If any of the specs fails to load, the whole server does not start. Separate
processes isolate the APIs completely, which matters when they need different global options
such as `--tool-mode`, or when a broken spec or a restart should affect only one API.
[several-apis.md](several-apis.md) describes the multi-API mode.

Treat environments such as dev, stage and prod as separate host entries, each with its own
spec URL, credentials and `--cache-key`.

## Upgrading

The host examples pin an exact version, such as `npx -y @kaisers-io/openapi-mcp@0.7.1 ...`,
never `latest`. The server runs with your API credentials on every start. If `npx` resolves
to whatever was just published, a compromised release would run with those credentials
without you noticing. To upgrade, change the pinned version in your host config on purpose. If
you installed the package globally instead of running it through `npx`, install the new
version explicitly, for example `npm i -g @kaisers-io/openapi-mcp@0.7.1`.

The `configuring-openapi-mcp` skill compares the configured version with the latest one and
proposes the config changes an update needs.

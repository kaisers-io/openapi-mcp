# openapi-mcp

[![npm](https://img.shields.io/npm/v/@kaisers-io/openapi-mcp?label=npm&color=blue)](https://www.npmjs.com/package/@kaisers-io/openapi-mcp)
[![CI](https://github.com/kaisers-io/openapi-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kaisers-io/openapi-mcp/actions/workflows/ci.yml)

`openapi-mcp` gives an AI agent safe access to an HTTP API. You point it at the API's OpenAPI
3.0, 3.1 or 3.2 description, from a URL or a file, and it runs on your machine as an
[MCP](https://modelcontextprotocol.io) server: each operation you allow becomes a tool that
agents in Claude Code, Codex and other MCP hosts can call. There is no code to generate and
nothing to deploy.

<a id="defaults"></a>

Without any configuration, the agent can only read (`GET`, `HEAD` and `QUERY` operations),
credentials come only from environment variables, every call is checked against the
operation's schema, and a changed API description waits for your approval before the server
uses it.

The agent also spends few tokens on the API. With many operations, `--tool-mode discover` lists
a few fixed tools instead of one per operation, and `execute_code` combines many calls in one
program that returns only the result. For six tasks on GitHub's API, one agent spent 2.7 cents
per task this way and 23.5 cents with one tool per operation
([measurements](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/tool-modes.md#why-it-is-on-by-default)).

> **Only use a description you trust.** Its operation names and texts reach the model, and a
> hostile description can try to steer the agent.

Requirements: Node.js 22.19 or later, or 24.11 or later (Node 23 is not supported), on
macOS, Linux or Windows. Use the latest patch release of your Node line, because older patches miss
its security fixes. On Windows the cache directories are private through your user profile's access
control list (owner, SYSTEM, Administrators), not through `0700`/`0600` modes. Other platforms, such
as FreeBSD, are refused because they are untested, not because they are known to be unsafe.

## Set it up with your agent

Two agent skills ask what the agent should do with the API, show which operations it may use,
store the credentials safely, write the host config after you confirm, and check that the
server works:

```bash
npx skills add kaisers-io/openapi-mcp
```

The command finds both skills, `configuring-openapi-mcp` and `debugging-openapi-mcp`, and asks
which ones to install and for which agents.

<a id="install"></a><a id="quick-start"></a>

## Set it up by hand

Preview the tools, without starting a server:

```bash
npx -y @kaisers-io/openapi-mcp@0.8.1 tools --spec https://api.example.com/openapi.json
```

Claude Code (`.mcp.json`, which expands `${VAR}`):

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.8.1",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json",
        "--base-url",
        "https://api.example.com",
        "--header-env",
        "Authorization=SHOP_TOKEN"
      ],
      "env": { "SHOP_TOKEN": "${SHOP_TOKEN}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`). Codex does not expand `${VAR}`; it forwards the variables named
in `env_vars` from the environment you start it in:

<!-- prettier-ignore -->
```toml
[mcp_servers.shop]
command = "npx"
args = [
  "-y", "@kaisers-io/openapi-mcp@0.8.1", "serve",
  "--spec", "https://api.example.com/openapi.json", "--base-url", "https://api.example.com",
  "--header-env", "Authorization=SHOP_TOKEN",
]
env_vars = ["SHOP_TOKEN"]
```

`--header-env` sends the variable's value unchanged, so for a bearer token the variable holds
`Bearer ` followed by the token. With a spec from a URL, `--base-url` is required next to
`--header-env`, so the spec cannot choose where the token goes. Run the same arguments with
`check` instead of `serve` to see whether the server would start.

On Windows, a host that starts commands without a shell cannot run `npx`, which is a `.cmd`
script. Use `"command": "cmd"` with `"args": ["/d", "/c", "npx", "-y", ...]` there, keep
`& | < > ^ %` out of the arguments, and double the backslashes in JSON paths
(`"C:\\specs\\shop.json"`).

Pin an exact version, as above, and never `latest`: the server runs with your API credentials
every time the host starts it. Without `--trust-spec-updates`, a description fetched with
`--spec-header-env` also needs `--cache-key`.

<a id="options-worth-knowing"></a>

## Choose what the agent may do

`--allow` and `--deny` take selectors, matched regardless of case: `method:delete`,
`path:/users/**`, `route:GET /users/**`, `operationId:list*`, `name:get_users_by_id` and
`tag:<glob>`. `--deny` always wins, and any `--allow` replaces the read-only default. A tool's
name is the operationId reduced to `[A-Za-z0-9_-]` (at most 64 characters), or method and path
when there is no usable operationId (`get_users_by_id`).

## Learn more

- [Connecting a host](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/hosts.md):
  every host, Windows, HTTP clients.
- [Credentials](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/credentials.md) and
  the [security model](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/security.md).
- [Filtering](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/filtering.md).
- [Large APIs and tool modes](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/tool-modes.md):
  `--tool-mode discover` lists a few tools instead of one per operation, among them
  `execute_code`, which runs a short program over several read-only calls.
- [Spec updates and the cache](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/spec-updates.md):
  `openapi-mcp cache promote` accepts a changed description.
- [Serving over HTTP](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/http.md).
- [Configuration reference](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/configuration.md):
  every flag and default, also in `openapi-mcp <command> --help`.

## License

MIT

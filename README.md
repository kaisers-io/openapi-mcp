# openapi-mcp

`openapi-mcp` gives an AI agent safe access to an HTTP API. You point it at the API's OpenAPI
description, and it runs on your machine as an [MCP](https://modelcontextprotocol.io) server:
each operation the description defines, and you allow, becomes a tool that agents in Claude
Code, Codex, Claude Desktop, Cursor, VS Code or Gemini CLI can call.

There is no code to generate and nothing to deploy. The agent's host starts the server from
its own config file, and every setting is a command-line flag or an environment variable.

What you get without configuring anything:

- The agent can only read. Only `GET`, `HEAD` and `QUERY` operations become tools until you
  allow more with `--allow`.
- Credentials come only from environment variables, so your config holds variable names, not
  secrets. The server keeps them out of the tool definitions the model sees and redacts them
  from results, errors and logs.
- The server checks every tool call against the operation's schema before it sends a request,
  and rejects arguments the operation does not define. When it can derive a schema for the
  response, it checks the response against it too.
- When the API description changes, the server keeps using the version you accepted until you
  approve the new one.

It supports OpenAPI 3.0, 3.1 and 3.2, from a URL or a local file. Swagger 2.0 is not
supported.

> **Only use a description you trust.** The server puts the description's operation names,
> summaries and parameter texts in front of the model. A hostile description can try to steer
> the agent. The server cleans and shortens that text, but it cannot tell an honest sentence
> from a manipulative one. See [Trust the spec source](docs/security.md).

## Requirements

Requirements: Node.js 22.19 or later, or 24.11 or later (Node 23 is not supported), on macOS, Linux
or Windows. Use the latest patch release of your Node line, because older patches miss its security
fixes. Other platforms, such as FreeBSD, are refused because they are untested, not because they are
known to be unsafe.

Node.js comes with `npx`, which runs the commands below in a terminal without installing
anything else.

<a id="agent-skills-optional"></a>

## Set it up with your agent

Two [agent skills](https://agentskills.io) let your agent do the setup with you. They work in
Claude Code, Codex and other agents that read skills, and they ask before they change anything.

```bash
npx skills add kaisers-io/openapi-mcp
```

The command finds both skills and asks which ones to install and for which agents. To install
only one, add `--skill configuring-openapi-mcp` or `--skill debugging-openapi-mcp`.

Then ask your agent, for example: `Connect the shop API at https://api.example.com/openapi.json`

`configuring-openapi-mcp` asks in plain words what the agent should do with the API. It shows
a table of the operations the agent would be allowed to use and what each one does, and you
confirm the list. It proposes a way to store the credentials on your operating system, such as
the macOS Keychain, writes the host config after you agree, and checks that the server starts
and that a first read call works. It also compares your configured version with the latest one
and tells you what to change when you update.

`debugging-openapi-mcp` finds out why a server does not start, lists fewer tools than you
expect, or returns errors, and proposes the smallest fix.

To pin the skills to a release, add its tag: `npx skills add kaisers-io/openapi-mcp#vX.Y.Z`. A
skill's `metadata.version` is the CLI version it was checked against. The skills only run the
commands and write the files this documentation describes, so you can always configure by hand
instead.

<a id="install"></a><a id="quickstart"></a><a id="use-as-an-mcp-server"></a>

## Set it up by hand

Preview the tools a description would produce, without starting a server:

```bash
npx -y @kaisers-io/openapi-mcp@0.5.0 tools --spec https://api.example.com/openapi.json
```

Then add the server to your host. For Claude Code, put this in `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": [
        "-y",
        "@kaisers-io/openapi-mcp@0.5.0",
        "serve",
        "--spec",
        "https://api.example.com/openapi.json"
      ]
    }
  }
}
```

For Codex, put this in `~/.codex/config.toml`:

```toml
[mcp_servers.shop]
command = "npx"
args = [
  "-y",
  "@kaisers-io/openapi-mcp@0.5.0",
  "serve",
  "--spec",
  "https://api.example.com/openapi.json",
]
```

If the description has no absolute `servers` URL, add `--base-url https://api.example.com` to
the arguments.

If the API needs a token, add `"--header-env", "Authorization=SHOP_TOKEN"` to the arguments.
The server then sends the value of the environment variable `SHOP_TOKEN` as the
`Authorization` header, unchanged, so for a bearer token the variable holds `Bearer ` followed
by the token. The host must pass the variable on: in Claude Code add
`"env": { "SHOP_TOKEN": "${SHOP_TOKEN}" }` to the entry, and in Codex add
`env_vars = ["SHOP_TOKEN"]`, because Codex does not expand `${VAR}`. The
[credentials guide](docs/credentials.md) shows how to set the variable without writing the
token into a file or your shell history.

To find out whether the server would start with these options, run the same arguments with
`check` instead of `serve`. Then restart the host, and the agent sees the API's read operations
as tools. The [hosts guide](docs/hosts.md) covers
the other hosts, Windows, a description that needs its own credentials, and serving over HTTP.

<a id="filtering"></a>

## Choose what the agent may do

`--allow` and `--deny` select operations by method, path, operationId, tag or tool name. Any
`--allow` replaces the read-only default, and `--deny` always wins:

```bash
npx -y @kaisers-io/openapi-mcp@0.5.0 tools --spec ./shop.json --allow "tag:Orders" --deny "method:delete"
```

`tools` shows which operations become tools with these filters and how many it left out. Add
`--json` before `tools` to see every left-out operation with its reason, under `notExposed`.
In a host config, the same patterns go into the `serve` arguments. The [filtering
guide](docs/filtering.md) explains every selector, with tested examples.

<a id="windows-hosts"></a><a id="http-transport"></a><a id="caching--refresh"></a>
<a id="large-apis---tool-mode-discover"></a><a id="other-options-and-behaviour"></a><a id="documentation"></a>

## More topics

| Topic | Guide |
|---|---|
| Claude Code, Codex, Claude Desktop, Cursor, VS Code, Gemini CLI, Windows | [Connecting a host](docs/hosts.md) |
| API keys, bearer tokens, OAuth client credentials | [Credentials](docs/credentials.md) |
| Which operations become tools | [Filtering](docs/filtering.md) |
| APIs with hundreds of operations | [Large APIs and tool modes](docs/tool-modes.md) |
| Several APIs in one server | [Serving several APIs](docs/several-apis.md) |
| Bodies, uploads, images, retries, timeouts, errors | [Requests and responses](docs/requests-and-responses.md) |
| What happens when the API description changes | [Spec updates and the cache](docs/spec-updates.md) |
| Running one server for several clients | [Serving over HTTP](docs/http.md) |
| Fixing a wrong detail in a description you cannot change | [OpenAPI Overlays](docs/overlays.md) |
| What the server protects against, and what it does not | [Security model](docs/security.md) |
| Every command and flag | [Configuration reference](docs/configuration.md) |

`openapi-mcp --help` and `openapi-mcp <command> --help` list every flag of the version you run.

## Secrets

Credentials are read only from environment variables that you name with `--header-env`,
`--spec-header-env`, `--upstream-oauth-client-id-env`, `--upstream-oauth-client-secret-env`
and `--http-token-env`. `--header` takes only values that are not secret, and refuses header
names such as `Authorization`. The [credentials guide](docs/credentials.md) shows how to keep
a token out of your config and your shell history.

## Install globally

The examples run the CLI through `npx`. To have an `openapi-mcp` command instead:

```bash
npm i -g @kaisers-io/openapi-mcp@0.5.0
openapi-mcp --version
openapi-mcp doctor
```

`doctor` prints the CLI and Node versions and where the cache lives. The first run per user is
slower because Node writes its compile cache; see the
[configuration reference](docs/configuration.md) for where it lives and how to turn it off.

## Upgrading

Pin an exact version in your host config, as the examples do, and never use `latest`. The
server runs with your API credentials every time the host starts it, so a version that `npx`
resolves on its own could run code that you never chose. To upgrade, change the version number
in the config, or install the new version globally
again (`npm i -g @kaisers-io/openapi-mcp@<version>`) if you use the global command.
The [changelog](CHANGELOG.md) lists what changed, and the configuring skill can propose the
config changes for you.

## Development

Development is supported on Linux and macOS. [CONTRIBUTING.md](CONTRIBUTING.md) describes the
setup, the checks CI runs and the benchmark gate. Report security problems privately, as
[SECURITY.md](SECURITY.md) describes.

## License

MIT

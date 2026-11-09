# Codex

Sources: [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Where the entry goes

- `~/.codex/config.toml`: every project of this user.
- `.codex/config.toml` in a project: read only when the user trusts the project.

The CLI, the desktop app and the IDE extension share these files.

## Entry

```toml
[mcp_servers.shop]
command = "npx"
args = ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--base-url", "https://shop.example.test", "--header-env", "Authorization=SHOP_API_TOKEN"]
env_vars = ["SHOP_API_TOKEN"]
startup_timeout_sec = 60
```

- Codex passes only a fixed set of variables (such as `HOME` and `PATH`) to the server, plus
  the names in `env_vars`. A token that is not listed there does not arrive, even when it is
  set in the shell. openapi-mcp does not use a proxy, so `HTTPS_PROXY` changes nothing.
- TOML does not expand `${VAR}`. Never put a secret into `env`: it holds literal values.
- `codex mcp add` writes literal `--env` values; write the entry yourself instead.
- The first `npx` download can take longer than the default startup timeout, hence
  `startup_timeout_sec = 60`.
- With a start script that loads the credentials, `command` is the script's absolute path and
  `args` is empty.
- Windows: `command = "cmd"`, `args = ["/d", "/c", "npx", ...]`.
- `enabled_tools` and `disabled_tools` act on the tools the host lists. Under
  `--tool-mode discover` those are the discovery tools and `execute_code`, so
  restrict operations with
  `--allow` and `--deny` instead.

## Sandbox

- Codex runs commands in a sandbox that may write only the project and, by default, has no
  network. openapi-mcp keeps its spec cache under `~/.kaisers-io/openapi-mcp/`, so a command
  can fail there with `the spec cache could not prepare the namespace for …: EPERM: operation
  not permitted`. Run the same command outside the sandbox, with the user's approval. If it
  passes there, the sandbox caused the error. If it fails there too, read that error: it names
  its own cause. Do not point `HOME` elsewhere to get around it.
- A DNS lookup or registry request that fails inside the sandbox says nothing about whether
  the user's machine can reach the API. Ask before you conclude that it cannot.

## Status

- `codex mcp list` and `codex mcp get shop` in a terminal, `/mcp` in a session.
- Listed is not the same as started: `/mcp` in a session shows whether the server runs.

## Logs

The log location depends on the Codex version: look in `~/.codex/log/` and, in newer versions,
in `~/.codex/logs_2.sqlite`. `RUST_LOG=debug codex` writes more detail.

After a change, quit Codex and start it again from a terminal that has the variables set.

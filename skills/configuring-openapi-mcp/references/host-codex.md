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
args = ["-y", "@kaisers-io/openapi-mcp@X.Y.Z", "serve", "--spec", "https://shop.example.test/openapi.json", "--header-env", "Authorization=SHOP_API_TOKEN"]
env_vars = ["SHOP_API_TOKEN"]
startup_timeout_sec = 60
```

- Codex passes only a fixed set of variables (such as `HOME` and `PATH`) to the server, plus
  the names in `env_vars`. A token that is not listed there does not arrive, even when it is
  set in the shell. Add `HTTPS_PROXY` too when the user is behind a proxy.
- TOML does not expand `${VAR}`. Never put a secret into `env`: it holds literal values.
- `codex mcp add` writes literal `--env` values; write the entry yourself instead.
- The first `npx` download can take longer than the default startup timeout, hence
  `startup_timeout_sec = 60`.
- With a start script that loads the credentials, `command` is the script's absolute path and
  `args` is empty.
- Windows: `command = "cmd"`, `args = ["/c", "npx", ...]`.
- `enabled_tools` and `disabled_tools` act on the tools the host lists. Under
  `--tool-mode discover` those are the four discovery tools, so restrict operations with
  `--allow` and `--deny` instead.

## Status

- `codex mcp list` and `codex mcp get shop` in a terminal, `/mcp` in a session.
- Listed is not the same as started: `/mcp` in a session shows whether the server runs.

## Logs

The log location depends on the Codex version: look in `~/.codex/log/` and, in newer versions,
in `~/.codex/logs_2.sqlite`. `RUST_LOG=debug codex` writes more detail.

After a change, quit Codex and start it again from a terminal that has the variables set.

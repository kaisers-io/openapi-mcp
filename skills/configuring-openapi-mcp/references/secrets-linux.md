# Credentials on Linux

Propose the default that fits the machine. Offer the alternative when the user has 1Password.
The user decides. Never ask for the value in the chat: the user types it into a prompt in their
own terminal. Before you show a command, replace `X.Y.Z`, the spec URL, the names and the header
flag with the values of this setup, each in single quotes; a single quote inside a value is
written `'\''`. Never run these commands with shell tracing (`set -x`).

## Default with a desktop keyring

`secret-tool` stores the value in the Secret Service (GNOME Keyring, KWallet) and prompts for
it without echo ([secret-tool(1)](https://manpages.debian.org/testing/libsecret-tools/secret-tool.1.en.html)).
It needs the `libsecret-tools` package and a running keyring in the user's session:

```sh
secret-tool store --label='Shop API token' service openapi-mcp account shop-api-token
```

Check that it exists without showing it:

```sh
secret-tool lookup service openapi-mcp account shop-api-token >/dev/null && echo stored
```

The host command is a start script. It reads the value, adds one variable to the environment it
inherits, and starts the pinned CLI:

```sh
#!/bin/sh
# ~/.config/openapi-mcp/shop.sh
PATH="$HOME/.local/bin:$PATH"
token="$(secret-tool lookup service openapi-mcp account shop-api-token)" || exit 1
[ -n "$token" ] || exit 1
SHOP_API_TOKEN="Bearer $token"
export SHOP_API_TOKEN
unset token
exec npx -y '@kaisers-io/openapi-mcp@X.Y.Z' serve --spec 'https://shop.example.test/openapi.json' --base-url 'https://shop.example.test' --header-env 'Authorization=SHOP_API_TOKEN'
```

- Set `PATH` to the output of `dirname "$(node -p process.execPath)"`: `npx` starts `node`
  through `PATH`, and `command -v node` can name a version manager's shim that only works in
  its shell.
- Leave out `Bearer ` for an API key, and use the API's own header name in `--header-env`.
- `chmod 700` the script. It holds no secret.
- The keyring must be unlocked. A password login to the desktop usually unlocks it; a
  fingerprint login or an SSH session may not
  ([GNOME Keyring](https://wiki.gnome.org/Projects/GnomeKeyring/RunningDaemon)).

## Default without a keyring (servers, SSH)

A file that holds only the token, readable only by the user, outside every repository. This
runs in `bash`. It makes the directory private, writes the token into a new file that
`mktemp` creates with mode 600, moves it over the old one, and stops at the first failure.
`read -rs` reads without echo or history
([bash, read](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html#index-read),
[mktemp](https://www.gnu.org/software/coreutils/manual/html_node/mktemp-invocation.html)):

```sh
bash -c 'd="$HOME/.config/openapi-mcp"; mkdir -p "$d" && chmod 700 "$d" && t="$(mktemp "$d/.shop-api-token.XXXXXX")" && IFS= read -rsp "Shop API token: " value && printf "%s" "$value" > "$t" && mv -f "$t" "$d/shop-api-token" && echo && echo stored'
```

The start script reads the file as data, never as shell code:

```sh
#!/bin/sh
PATH="$HOME/.local/bin:$PATH"
token="$(cat "$HOME/.config/openapi-mcp/shop-api-token")" || exit 1
[ -n "$token" ] || exit 1
SHOP_API_TOKEN="Bearer $token"
export SHOP_API_TOKEN
unset token
exec npx -y '@kaisers-io/openapi-mcp@X.Y.Z' serve --spec 'https://shop.example.test/openapi.json' --base-url 'https://shop.example.test' --header-env 'Authorization=SHOP_API_TOKEN'
```

The token is stored in plain text, protected by file permissions only. Say so.

## Alternative: 1Password CLI

No file on disk holds the credential: [`op run`](https://developer.1password.com/docs/cli/reference/commands/run/)
resolves `op://` references from an env file when the server starts. The env file holds
`SHOP_API_TOKEN=op://Private/Shop API/credential` (copied with "Copy Secret Reference", never
sourced as a script). The field must hold the full header value, for example `Bearer <token>`.
Use the start script above, with its `PATH` line, and replace its token lines and the `exec`
line with `exec /usr/bin/op run --env-file="$HOME/.config/openapi-mcp/shop.env" -- npx -y '@kaisers-io/openapi-mcp@X.Y.Z' serve ...`.
Replace `/usr/bin/op` with the output of `command -v op`. The value is then in the environment
of `op`, `npx` and the server. A GUI host needs the
[app integration](https://developer.1password.com/docs/cli/app-integration/) so `op` can unlock
without a terminal.

## Avoid

- `export SHOP_API_TOKEN=...` with the value in `~/.bashrc` or `~/.profile`: plain text,
  inherited by every program started from that shell.
- The value in a host config or any file in a repository.

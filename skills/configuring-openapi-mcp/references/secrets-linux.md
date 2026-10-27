# Credentials on Linux

Propose the default that fits the machine. Offer the alternative when the user has 1Password
or `pass`. The user decides. Never ask for the value in the chat: the user types it into a
prompt in their own terminal.

## Default with a desktop keyring

`secret-tool` stores the value in the Secret Service (GNOME Keyring, KWallet) and prompts for
it ([secret-tool(1)](https://manpages.debian.org/testing/libsecret-tools/secret-tool.1.en.html)):

```sh
secret-tool store --label='Shop API token' service openapi-mcp account shop-api-token
```

Check that it exists without showing it:

```sh
secret-tool lookup service openapi-mcp account shop-api-token >/dev/null && echo stored
```

The host command is a start script that reads the value, exports only what the server needs,
and starts the pinned CLI:

```sh
#!/bin/sh
# ~/.config/openapi-mcp/shop.sh
SHOP_API_TOKEN="Bearer $(secret-tool lookup service openapi-mcp account shop-api-token)" || exit 1
export SHOP_API_TOKEN
exec "$HOME/.local/bin/npx" -y @kaisers-io/openapi-mcp@X.Y.Z serve --spec https://shop.example.test/openapi.json --header-env Authorization=SHOP_API_TOKEN
```

Replace the `npx` path with the output of `command -v npx`, run `chmod 700` on the script, and
leave out `Bearer ` for an API key. The keyring must be unlocked, which it is after a desktop
login.

## Default without a keyring (servers, SSH)

A file only the user can read, outside every repository. Create it with mode 600 before it gets
content, and read the value with `read -rs`, which shows nothing and keeps it out of the history
([bash, read](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html#index-read)):

```sh
mkdir -p ~/.config/openapi-mcp
install -m 600 /dev/null ~/.config/openapi-mcp/shop.env
read -rs value && printf 'SHOP_API_TOKEN=Bearer %s\n' "$value" >> ~/.config/openapi-mcp/shop.env; unset value
```

The start script loads it:

```sh
#!/bin/sh
set -a
. "$HOME/.config/openapi-mcp/shop.env"
set +a
exec "$HOME/.local/bin/npx" -y @kaisers-io/openapi-mcp@X.Y.Z serve --spec https://shop.example.test/openapi.json --header-env Authorization=SHOP_API_TOKEN
```

The value is stored in plain text. Say so.

## Alternative: 1Password CLI or pass

[`op run`](https://developer.1password.com/docs/cli/reference/commands/run/) keeps no plain-text
copy: the env file holds `SHOP_API_TOKEN=op://Private/Shop API/credential`, and the host command
is `op run --env-file=<absolute path> -- npx -y @kaisers-io/openapi-mcp@X.Y.Z serve ...`. With
[`pass`](https://www.passwordstore.org/), the start script reads `pass show openapi-mcp/shop-api-token`
in place of `secret-tool lookup`.

## Avoid

- `export` lines with the value in `~/.bashrc` or `~/.profile`: plain text, read by every shell.
- The value in a host config or any file in a repository.

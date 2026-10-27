# Credentials on macOS

Propose the default. Offer the alternative when the user has 1Password. The user decides.
Never ask for the value in the chat: the user types it into a prompt in their own terminal.

## Default: Keychain and a start script

Store the value. The trailing `-w` makes `security` prompt for it, so it stays out of the shell
history; `-U` replaces an existing item ([security(1)](https://keith.github.io/xcode-man-pages/security.1.html)):

```sh
security add-generic-password -U -a "$USER" -s shop-api-token -w
```

Check that it exists without showing it:

```sh
security find-generic-password -s shop-api-token >/dev/null && echo stored
```

A Keychain item does not reach the server by itself, and an app started from the Dock does not
read `~/.zshrc`. Use a start script as the host command. It reads the item, exports only the
variables the server needs, and starts the pinned CLI:

```sh
#!/bin/sh
# ~/.config/openapi-mcp/shop.sh
SHOP_API_TOKEN="Bearer $(/usr/bin/security find-generic-password -s shop-api-token -w)" || exit 1
export SHOP_API_TOKEN
exec /usr/local/bin/npx -y @kaisers-io/openapi-mcp@X.Y.Z serve --spec https://shop.example.test/openapi.json --header-env Authorization=SHOP_API_TOKEN
```

- Replace `/usr/local/bin/npx` with the output of `command -v npx`. GUI apps may not have the
  `PATH` of the terminal.
- Leave out `Bearer ` for an API key.
- `chmod 700 ~/.config/openapi-mcp/shop.sh`. The script holds no secret.
- The host entry then runs the script with no arguments; the host file says where.
- macOS may ask whether the script may read the item. "Always Allow" stops the question.

For a terminal host only (Claude Code or Codex in a terminal), the user can instead add this to
`~/.zshrc` and open a new terminal:

```sh
export SHOP_API_TOKEN="Bearer $(security find-generic-password -s shop-api-token -w)"
```

## Alternative: 1Password CLI

Nothing is stored in plain text, and the value exists only in the server process.
[`op run`](https://developer.1password.com/docs/cli/reference/commands/run/) resolves
`op://` references from an env file
([secret references](https://developer.1password.com/docs/cli/secrets-environment-variables/)):

```sh
# ~/.config/openapi-mcp/shop.env (no secret, only a reference)
SHOP_API_TOKEN=op://Private/Shop API/credential
```

The host command is `op` with the arguments
`run --env-file=/Users/<name>/.config/openapi-mcp/shop.env -- npx -y @kaisers-io/openapi-mcp@X.Y.Z serve ...`.
The stored field must hold the full header value, for example `Bearer <token>`. 1Password may
ask the user to unlock it when the host starts the server.

## Avoid

- `launchctl setenv`: every app of the session can read the value, and it is gone after a
  restart.
- The value in `.mcp.json`, `config.toml` or any file in a repository.

# Credentials on macOS

Propose the default. Offer the alternative when the user has 1Password. The user decides.
Never ask for the value in the chat: the user types it into a prompt in their own terminal.
Before you show a command, replace `X.Y.Z`, the spec URL, the names and the header flag with
the values of this setup, each in single quotes; a single quote inside a value is written
`'\''`. Never run these commands with shell tracing (`set -x`).

## Default: Keychain and a start script

Store the value. The trailing `-w` makes `security` prompt for it, so it stays out of the shell
history and the process list; `-U` replaces an existing item, and `-T ""` gives no program
access without asking, `security` itself included
([security(1)](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1)):

```sh
security add-generic-password -U -a "$USER" -s shop-api-token -T "" -w
```

Check that it exists without showing it:

```sh
security find-generic-password -a "$USER" -s shop-api-token >/dev/null && echo stored
```

A Keychain item does not reach the server by itself, and an app started from the Dock may not
have the variables or the `PATH` of a terminal. Use a start script as the host command, for
terminal hosts too. It reads the item, adds one variable to the environment it inherits, and
starts the pinned CLI:

```sh
#!/bin/sh
# ~/.config/openapi-mcp/shop.sh
PATH="/opt/homebrew/bin:$PATH"
token="$(/usr/bin/security find-generic-password -a "$USER" -s shop-api-token -w)" || exit 1
[ -n "$token" ] || exit 1
SHOP_API_TOKEN="Bearer $token"
export SHOP_API_TOKEN
unset token
exec npx -y '@kaisers-io/openapi-mcp@X.Y.Z' serve --spec 'https://shop.example.test/openapi.json' --header-env 'Authorization=SHOP_API_TOKEN'
```

- Set `PATH` to the directory of `command -v node`: `npx` starts `node` through `PATH`.
- Leave out `Bearer ` for an API key, and use the API's own header name in `--header-env`.
- `chmod 700 ~/.config/openapi-mcp/shop.sh`. The script holds no secret.
- The host entry runs the script with no arguments; the host file says where.
- macOS asks whether `security` may read the item each time the server starts. "Always Allow"
  lets the `security` tool read it without asking from then on, for any script that calls it.
  "Allow" asks again next time. Explain both and let the user choose.

## Alternative: 1Password CLI

No file on disk holds the credential: [`op run`](https://developer.1password.com/docs/cli/reference/commands/run/)
resolves `op://` references from an env file when the server starts
([secret references](https://developer.1password.com/docs/cli/secrets-environment-variables/)).
The value is then in the environment of `op`, `npx` and the server, as with any variable.

```sh
# ~/.config/openapi-mcp/shop.env (no secret, only a reference; never source it as a script)
SHOP_API_TOKEN=op://Private/Shop API/credential
```

- Copy the reference from 1Password ("Copy Secret Reference") instead of guessing field names.
  The field must hold the full header value, for example `Bearer <token>`.
- A host started from the Dock needs the
  [1Password app integration](https://developer.1password.com/docs/cli/app-integration/) turned
  on, so `op` can ask for Touch ID instead of a terminal sign-in.
- Use the start script above, with its `PATH` line, and replace its token lines and the
  `exec` line with
  `exec /opt/homebrew/bin/op run --env-file="$HOME/.config/openapi-mcp/shop.env" -- npx -y '@kaisers-io/openapi-mcp@X.Y.Z' serve ...`,
  with the output of `command -v op` as the path of `op`. A host started from the Dock would
  otherwise find neither `op` nor `node`.

## Avoid

- `export SHOP_API_TOKEN=...` with the value in `~/.zshrc`: plain text, inherited by every
  program started from that shell.
- `launchctl setenv`: the value goes into launchd's environment for apps started afterwards.
- The value in `.mcp.json`, `config.toml` or any file in a repository.

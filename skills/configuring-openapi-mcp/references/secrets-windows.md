# Credentials on Windows

Propose the default. Offer the alternative when the user has 1Password. The user decides.
Never ask for the value in the chat: the user types it into a prompt in their own PowerShell.

## Default: a user environment variable

Read the value without echo, then store it for the user. `Read-Host -AsSecureString` hides the
input ([Read-Host](https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/read-host)),
and `SetEnvironmentVariable` with `User` stores it for new processes of this user
([Environment.SetEnvironmentVariable](https://learn.microsoft.com/dotnet/api/system.environment.setenvironmentvariable)):

```powershell
$secure = Read-Host -AsSecureString 'Shop API token'
$plain = [System.Net.NetworkCredential]::new('', $secure).Password
[Environment]::SetEnvironmentVariable('SHOP_API_TOKEN', "Bearer $plain", 'User')
Remove-Variable plain, secure
```

- Leave out `Bearer ` for an API key.
- Windows keeps user variables unencrypted in the user's registry. Say so.
- Apps that are already running keep their old environment: the user restarts the host. A
  terminal inside an editor needs the editor restarted too.

Check that it is set without showing it:

```powershell
$null -ne [Environment]::GetEnvironmentVariable('SHOP_API_TOKEN', 'User')
```

`True` while the host still reports it missing means the host was not restarted.

## Alternative: 1Password CLI

No plain-text copy in the registry, and the value exists only in the server process.
[`op run`](https://developer.1password.com/docs/cli/reference/commands/run/) resolves
`op://` references from an env file:

```
# %USERPROFILE%\.config\openapi-mcp\shop.env (no secret, only a reference)
SHOP_API_TOKEN=op://Private/Shop API/credential
```

The host command is `op` with the arguments
`run --env-file=C:\Users\<name>\.config\openapi-mcp\shop.env -- cmd /c npx -y @kaisers-io/openapi-mcp@X.Y.Z serve ...`.
The stored field must hold the full header value, for example `Bearer <token>`.

## Avoid

- `setx`: it cuts values at 1,024 characters and leaves the value in the command history
  ([setx](https://learn.microsoft.com/windows-server/administration/windows-commands/setx)).
- The value in a host config or any file in a repository.

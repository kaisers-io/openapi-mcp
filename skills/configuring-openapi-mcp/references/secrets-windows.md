# Credentials on Windows

Microsoft recommends protected storage for secrets, Credential Manager or DPAPI, over plain text
([Handling passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)).
Propose the first option that fits and let the user decide. Never ask for the value in the
chat: the user types it into a prompt in their own PowerShell. Before you show a command,
replace `X.Y.Z`, the spec URL, the names and the header flag with the values of this setup, in
single quotes; a single quote inside a value is written twice (`''`).

## VS Code

In a `.vscode/mcp.json` or user `mcp.json`, use `inputs` with `"password": true` (host file):
VS Code asks once and keeps the value in its secret storage. Some agent modes and portable
configurations do not support input variables
([VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#input-variables-for-sensitive-data)).
Use the next option there.

## Default: DPAPI and a start script

`Export-Clixml` encrypts a credential with DPAPI, so only this user on this machine can read it
([Export-Clixml](https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/export-clixml)).
Store it:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\openapi-mcp" | Out-Null
$secure = Read-Host -AsSecureString 'Shop API token'
[pscredential]::new('shop-api-token', $secure) | Export-Clixml -Path "$env:USERPROFILE\.config\openapi-mcp\shop-api-token.xml"
Remove-Variable secure
```

`Read-Host` masks the input and accepts at most 1,022 characters. The start script decrypts it,
adds one variable to the environment it inherits, and starts the pinned CLI:

```powershell
# %USERPROFILE%\.config\openapi-mcp\shop.ps1
$ErrorActionPreference = 'Stop'
$credential = Import-Clixml -Path "$env:USERPROFILE\.config\openapi-mcp\shop-api-token.xml"
$token = $credential.GetNetworkCredential().Password
if ([string]::IsNullOrEmpty($token)) { exit 1 }
$env:SHOP_API_TOKEN = "Bearer $token"
Remove-Variable token, credential
& npx.cmd -y '@kaisers-io/openapi-mcp@X.Y.Z' serve --spec 'https://shop.example.test/openapi.json' --header-env 'Authorization=SHOP_API_TOKEN'
exit $LASTEXITCODE
```

- Leave out `Bearer ` for an API key, and use the API's own header name in `--header-env`.
- `npx.cmd` is a batch file: `cmd` reads `& | < > ^ %` and `"` in its arguments as its own
  syntax, whatever the quoting in PowerShell
  ([about_Parsing](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing)).
  If the spec URL or another value holds one of them, put the spec in a local file and pass
  its path.
- The host command is `powershell.exe` with the arguments `-NoLogo`, `-NoProfile`,
  `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-File` and the script's absolute path, each
  as its own array element (backslashes doubled in JSON). `Bypass` applies to this one process,
  so the user's execution policy stays as it is.
- Before you write the host entry, test the script as a host would start it, with the
  [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector):
  `npx -y @modelcontextprotocol/inspector@2.11.0 --cli powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> --method tools/list`.
  If it does not list the tools, do not use this option: offer 1Password.

## Alternative: 1Password CLI

No file on disk holds the credential: [`op run`](https://developer.1password.com/docs/cli/reference/commands/run/)
resolves `op://` references from an env file when the server starts. The value is then in the
environment of `op`, `cmd`, `npx` and the server.

```
# %USERPROFILE%\.config\openapi-mcp\shop.env (no secret, only a reference)
SHOP_API_TOKEN=op://Private/Shop API/credential
```

- Copy the reference from 1Password ("Copy Secret Reference"). The field must hold the full
  header value, for example `Bearer <token>`.
- Turn on the [app integration](https://developer.1password.com/docs/cli/app-integration/), so
  `op` can unlock with Windows Hello when a host starts it.
- The host command is `op` with the arguments `run`,
  `--env-file=C:\Users\<name>\.config\openapi-mcp\shop.env`, `--`, `cmd`, `/d`, `/c`, `npx`,
  `-y`, `@kaisers-io/openapi-mcp@X.Y.Z`, `serve`, and the rest, each as its own array element.
  The same limit on `& | < > ^ %` and `"` applies as for the start script above.

## Avoid

- A user environment variable (`SetEnvironmentVariable(..., 'User')`) or `setx` with the value:
  Windows stores it unencrypted, and every program the user starts inherits it.
- The value in a host config or any file in a repository.

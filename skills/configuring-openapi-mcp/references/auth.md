# Credentials

Map the `security` of the allowed operations to flags. Every credential reaches the server as
an environment variable that a flag names. Details:
[docs/credentials.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/credentials.md) and
[docs/security.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/security.md#credential-hygiene).

## Reading the spec

`CLI --json tools` gives each operation a `security` list. Any one entry of the list is enough;
the schemes inside one entry are needed together. `[]` needs no credentials, and an entry `{}`
makes them optional. `securitySchemes` names the type of each scheme, and `security` (the
top-level list in the output) gives the flag for each scheme an exposed operation uses.

## Scheme to flag

| Scheme | Flag | The variable holds |
|---|---|---|
| `http` `bearer` | `--header-env Authorization=VAR` | `Bearer <token>` |
| `http` `basic` | `--basic-auth-env USER_VAR:PASSWORD_VAR` | the user name and the password, in two variables |
| `apiKey` in header `X-Key` | `--header-env X-Key=VAR` | the key |
| `apiKey` in cookie `sid` | `--header-env Cookie=VAR` | `sid=<value>`; several cookies joined with `; ` |
| `oauth2` with `clientCredentials` | `--upstream-oauth-client-id-env ID_VAR --upstream-oauth-client-secret-env SECRET_VAR` | client ID, client secret |
| `oauth2` other flows, `openIdConnect` | `--header-env Authorization=VAR` | `Bearer <token>` the user gets elsewhere |

`--header-env` sends the value exactly as stored. For a bearer token the variable must contain
the word `Bearer`, a space and the token. Tell the user this when they store it.

A spec loaded from a URL needs `--base-url` with `--header-env` or `--basic-auth-env`, so that
the spec alone does not decide where the credential goes. Take the URL from the spec's
`servers` and ask the user to confirm it.

Not supported: API keys in the query string, client certificates (`mutualTLS`), and
challenge schemes such as `digest` or `ntlm`. Say so and stop if the allowed operations need
only those.

## Upstream OAuth (client credentials)

- Add `--upstream-oauth-scope` once per scope the operations need. The server requests no
  scope by default.
- A spec loaded from a URL needs `--base-url`, or `--upstream-oauth-token-url`, so that the
  spec alone does not decide where the client secret goes.
- A token URL on another origin than the API needs `--upstream-oauth-token-url`. Ask the user
  to confirm that URL.
- With several `clientCredentials` schemes, pick one with `--upstream-oauth-scheme`.
- Do not combine it with `--header-env Authorization=...`.

## A spec behind authentication

When the spec URL itself needs a credential, add `--spec-header-env Authorization=VAR` and a
`--cache-key <name>` (letters, digits, `.`, `_`, `-`), unique per account. `--header-env` does
not authenticate the spec fetch.

## Naming variables

Name each variable after the service and its purpose: `SHOP_API_TOKEN`, `SHOP_CLIENT_SECRET`.
Use letters, digits and `_`, starting with a letter. Never reuse one variable for two services.

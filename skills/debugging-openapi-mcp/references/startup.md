# The server does not start

Read the `check` output first: `environment` lists every variable, `startup` the first error.
`serve` writes the same errors to stderr after `openapi-mcp:`, and the host log shows them.
Lines with `openapi-mcp: warning:` do not stop the server. Exit codes: 2 usage (a flag or its
value), 3 validation (the spec, the cache, a budget, `--strict-filters`), 4 not found,
5 conflict (a cache lock or a concurrent change). With `--json`, some errors carry a stable
`reason`: `env_missing`, `base_url_unresolved`, `spec_http_401_403`, `spec_external_ref` or
`filter_no_selector`. Details:
[docs/configuration.md, Exit codes](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/configuration.md#exit-codes).

## Contents

- [Host side](#host-side)
- [Variables, spec and base URL](#variables-spec-and-base-url)
- [Flags and their values](#flags-and-their-values)
- [Credentials and OAuth](#credentials-and-oauth)
- [Several APIs and HTTP](#several-apis-and-http)
- [Egress, filters and the cache](#egress-filters-and-the-cache)
- [Startup warnings](#startup-warnings)

## Host side

| Evidence | Cause | Fix |
|---|---|---|
| `Executable not found`, `ENOENT`, `command not found` | the host cannot find `npx`; GUI apps often lack the terminal's `PATH` | the directory of `node -p process.execPath` in `PATH`, or a start script that sets it |
| `EINVAL` or "client closed" on Windows | `npx` is a `.cmd` file | `"command": "cmd"`, `"args": ["/d", "/c", "npx", ...]` |
| `requires Node` | Node below 22.19, or 23 | install Node 24, then point the host at it |
| timeout on the first start | `npx` downloads the package | raise the host's startup timeout (host file); start once by hand to fill the cache |
| `MCP error -32000: Connection closed` | the process exited before the handshake | run `check`; its error is the reason |
| Claude Code: Pending approval | a project server waits for approval | approve it in `/mcp` |
| Codex: variable missing, but set in the shell | not in `env_vars` | add the name to `env_vars`, restart Codex |
| Gemini CLI: variable empty | Gemini removes `*TOKEN*`, `*KEY*` and similar | name it in `env` |
| Claude Desktop: variable missing | the app does not read the shell profile | start script as `command` |

## Variables, spec and base URL

| `check` or stderr says | Cause | Fix |
|---|---|---|
| `environment variable "X" (for header "H") is not set or empty`, `is not set or empty`, `env var "X" is not set` | the variable does not reach the server | see the host rows above |
| `invalid header mapping`, `expected <Header>=<ENV_VAR>`, `must match the RFC 9110 token grammar` | `--header-env` or `--spec-header-env` not in `Header=VAR` form, or a header name with spaces or other characters | `--header-env X-Api-Key=VAR` |
| `names an invalid environment variable`, `invalid env var name` | a flag names a variable with characters other than letters, digits and `_` | rename the variable |
| `contains control characters`, `contains a character above U+00FF` | a variable or `--header` value holds a line break or non-Latin-1 text, which no HTTP header can carry | the user fixes the stored value |
| `cannot read spec file` | wrong path, or relative to another working directory | absolute path |
| `--spec must not be empty`, `invalid spec URL`, `unsupported URL scheme` | a typo, or a file path with `:` | a full `https://` URL; a relative path with `:` starts with `./` |
| `spec URLs must not contain userinfo credentials`, `looks credential-bearing` | user and password in the URL, or a query parameter such as `token=` | `--spec-header-env`; query-string secrets are not supported |
| `spec fetch failed with HTTP 401` or `403` | the spec URL needs a credential | `--spec-header-env Authorization=VAR` and a `--cache-key` |
| `spec fetch failed with HTTP` and another status | wrong spec URL | find the right URL with the user |
| `spec fetch timed out` | slow or unreachable URL | check the URL in a browser; raise `--timeout` only for a slow spec |
| `spec fetch failed for` | DNS, TLS or network; the text after the colon says which | test the URL from the same machine |
| `spec fetch exceeded 5 redirects`, `has no Location header`, `without a conditional request` | the spec server misbehaves | use the final URL of the spec |
| `exceeds the 20971520-byte budget` | the spec is over 20 MiB | a smaller spec |
| `is neither valid JSON ... nor valid YAML`, `spec document is empty`, `spec root must be a JSON/YAML object`, `failed OpenAPI ... schema validation` | the URL serves a web page, or the spec is broken | find the JSON or YAML document; for schema errors, fix the paths it lists |
| `OpenAPI 2.0 (swagger) documents are not supported`, `must declare an "openapi" version of 3.0.x, 3.1.x or 3.2.x` | Swagger 2.0, or no version | convert it to OpenAPI 3 first |
| `external $ref "..." is not supported` | the spec spans several files | bundle it into one file first |
| `does not resolve`, `only JSON-pointer fragments ("#/...") are supported`, `contains an invalid URI escape` | a broken `$ref` in the spec | the spec needs a fix (overlay) |
| `exceeds the YAML alias budget of 1000`, `nesting is too deep`, `$ref expansion exceeds the maximum depth of 64`, `-node budget` | the spec is too deep or expands too much | the spec needs a change; these limits have no flag |
| `operations ... exceeds the 4096-operation limit` | over 4,096 operations | a smaller spec; filters do not help here |
| `has no absolute server URL ... pass --base-url` | no usable `servers` entry, or `servers[0].url` over 2,048 bytes | `--base-url https://...` |
| `the resolved API base URL (...) is invalid`, `invalid --base-url` | a query string, a fragment, user and password, or a scheme other than `http(s)` | `--base-url` with only scheme, host and path |
| `the spec alone would decide where --header-env/--basic-auth-env/--upstream-oauth-* credentials are sent` | a spec URL with `--header-env`, `--basic-auth-env` or `--upstream-oauth-*` (also with `--upstream-oauth-token-url`) and no `--base-url` | `--base-url https://...`, the API base URL the user confirms |
| `has an output schema that cannot be compiled` | a response schema the validator cannot build | `--omit-output-schema "operationId:<id>"` for that tool, after the user agrees |
| `could not derive unique tool names` | operationIds that still collide after hashing | rename the operations (overlay) |
| `is not object-rooted`, `duplicate tool name` | a broken generated tool | report it with the spec, as a bug |

## Flags and their values

Every value error names the flag and the expected form, for example `invalid --rate-limit`
with `expected <calls>/<duration>, e.g. "120/1m"`. The accepted values:

| Flag | Accepted values |
|---|---|
| `--timeout`, `--request-timeout` | `<int><s\|m\|h\|d>`, up to about 24.8 days |
| `--ttl` | `<int><s\|m\|h\|d>`, up to `365d` |
| `--max-response-bytes` | `<int><B\|KB\|MB>` or bytes, at most 100 MiB |
| `--image-dir-max-bytes` | the same form, at least 5 MiB (one image) |
| `--max-concurrency` | 1 to 256 |
| `--rate-limit` | `<calls>/<duration>`, calls 1 to 100,000 |
| `--retries` | 0 to 3 |
| `--tools-page-size` | 1 to 512 |
| `--port` | 1 to 65535 |
| `--log` | `json` only |
| `--tool-mode`, `--output-schema`, `--image-responses`, `--nullable-response-fields`, `--http-auth`, `--upstream-oauth-client-auth` | one of the values `CLI --json help` lists (`is not one of`) |
| `--cache-key` | 1 to 64 letters, digits, `.`, `_`, `-` |
| a filter pattern | a selector, at most 256 characters, 10 wildcards and 128 patterns per flag |

An unknown flag, command or missing value fails with the parser's text, such as `unknown option`,
`unknown command` or
`required option '--spec <url|file>' not specified (or --api <name>=<source>)`.

## Credentials and OAuth

| `check` or stderr says | Cause | Fix |
|---|---|---|
| `looks like a credential`, `use --header-env instead` | a secret-looking name (`Authorization`, `Cookie`, `*token*`, `*key*`, `*secret*`) in `--header` | `--header-env` with a variable |
| `is a hop-by-hop or client-managed header` | `--header` sets `Host`, `Content-Type`, `Content-Length` or similar | remove it; the server sets these |
| `duplicate header`, `is configured via both --header and --header-env`, `has an empty value` | the same header twice, or no value | keep one, with a value |
| `too many API headers configured`, `-byte aggregate budget`, `-char budget`, `-character budget` | over 32 headers, 64 KiB together, 256 characters per name or 8,192 per value | fewer or shorter headers |
| `--basic-auth-env cannot be combined with` | Basic auth next to `--header-env Authorization=...` or `--upstream-oauth-*`; all set the one `Authorization` header | keep one way to authenticate |
| `contains ":", which HTTP Basic auth cannot carry` | a `:` in the user name | the API needs another credential |
| `both --upstream-oauth-client-id-env <ENV> and --upstream-oauth-client-secret-env <ENV>` | an `--upstream-oauth-*` flag without both variables | add both |
| `cannot be combined with --header-env Authorization=...` | OAuth and a static `Authorization` header | keep one |
| `must use https (http is accepted for loopback only)`, `must not embed credentials in the URL`, `must not contain a fragment` | the token URL is not a plain `https` URL | the token URL from the API docs |
| `is not on the API origin` | the token URL comes from the spec and points elsewhere | `--upstream-oauth-token-url <url>` after the user confirms it |
| `declares several client-credentials schemes`, `does not name an oauth2 scheme` | the spec has several such schemes | `--upstream-oauth-scheme <name>` from the list it prints |
| `declares no oauth2 clientCredentials flow`, `the spec token URL is invalid` | the spec has no usable token URL | `--upstream-oauth-token-url <url>` |
| `too many --upstream-oauth-scope values`, `a scope is one RFC 6749 scope-token` | over 64 scopes, or a scope with a space or quote | one flag per scope |
| `the OAuth token URL is refused` | token URL private or not allowed | check the URL with the user |
| `too trivial to redact safely`, `secret exceeds the redaction length budget`, `too many secrets to redact` | a secret that is part of `[redacted]`, over 8,192 characters, or more than 64 secrets | a real secret; fewer headers or APIs |
| `refusing to send a --spec-header-env credential in cleartext` | an `http://` spec URL to a host that is not loopback | an `https://` spec URL; `--allow-insecure-http` (also on `tools` and `cache refresh`) only if the user agrees |
| `--spec-header-env only applies to URL spec sources` | a file spec with a spec credential | remove `--spec-header-env` |
| `an authenticated spec source ... requires an explicit cache decision` | `--spec-header-env` without a cache key | `--cache-key <name>`; `--trust-spec-updates` skips the cache instead, if the user agrees |

## Several APIs and HTTP

| `check` or stderr says | Cause | Fix |
|---|---|---|
| `--spec and --api cannot be combined`, `--enable needs --api` | mixed syntax | declare every API with `--api <name>=<source>` |
| `is not <name>=<source>`, `is reserved`, `twice`, `at most 32 APIs` | an API name breaks the rules | 1 to 32 of `a-z 0-9 -`, starting with a letter; not `openapi`, `search`, `describe`, `call` or `execute` |
| `does not start with the name of an API`, `needs <name>=<value> with --api`, `is given twice for the API` | a per-API flag without its `<name>=` prefix, or twice | `--flag <name>=<value>`, once per API |
| `cannot be used with --api; write --enable`, `names no switch` | a switch such as `--allow-private-network` given for all APIs | `--enable <name>=allow-private-network` for the API that needs it |
| `load the same spec with the same cache key`, `each API needs a base URL of its own` | two APIs share a cache entry or a base URL | a `--cache-key` or `--base-url` of their own |
| `all APIs together configure`, `one server holds at most 64` | over 64 secrets in one server | split the APIs over several server entries |
| `tools would be exposed by all APIs together` | over 512 tools together (4,096 under `discover`) | narrow the filters, or `--tool-mode discover` |
| `require --http` | an HTTP flag without `--http` | add `--http`, or remove the flag |
| `--http requires --http-token-env <ENV>`, `must decode to exactly 32 bytes` | no token, or a token of the wrong length | a variable with `openssl rand -base64 32` |
| `require --http-auth oauth`, `requires --oauth-issuer <url> and --oauth-audience <uri>`, `--http-token-env cannot be combined with --http-auth oauth` | static mode and OAuth flags mixed | one mode with its flags |
| `must be an IP address`, `a non-loopback --http-host requires an https --oauth-audience`, `requires OAuth resource-server mode` | a host name, or a public bind without OAuth over `https` | an IP address, OAuth mode and an `https` audience |
| `single OAuth scope tokens` | an `--oauth-required-scope` with a space or quote | one flag per scope |
| `must be an absolute URL`, `must not contain credentials, a query string or a fragment`, `(http is accepted only for a loopback host)` | `--oauth-issuer`, `--oauth-audience` or the issuer's `jwks_uri` is not a plain `https` URL | the URLs from the authorization server's docs |
| `cannot discover the authorization server metadata`, `has no jwks_uri`, `cannot load a usable JWKS` | the issuer URL is wrong or unreachable | check `--oauth-issuer` with the user |
| `--uploads cannot be used with a non-loopback --http-host`, `--image-responses file cannot be used with a non-loopback --http-host` | a remote client could read or fill this machine's folders | use these over stdio or loopback only |
| `needs a home directory`, `cannot resolve the home directory`, `is not a plain directory`, `belongs to another user`, `changed while it was being opened` | the upload or image folder cannot be used | a home directory the user owns, without a file or link in the folder's place |

## Egress, filters and the cache

| `check` or stderr says | Cause | Fix |
|---|---|---|
| `points at the private/loopback address`, `is loopback`, `resolves to a private/loopback address`, `rejected:` after the spec URL | the spec, its redirect or the API address from the spec is on a private network | `--allow-private-network`, only after the user confirms the address is theirs |
| `is a cloud-metadata address`, `is a cloud-metadata endpoint`, `points at the cloud-metadata address` | a metadata host, or a link-local address (`169.254.0.0/16`, `fe80::/10`) | no flag admits it, `--allow-private-network` neither; use another address of the API |
| `cannot resolve redirect target` | this machine cannot resolve the API host from the spec | the right base URL or network |
| `tools would be exposed after filtering`, `exceeds the 512-tool budget` | too many operations for `per-operation` (4,096 under `discover`) | narrow `--allow`, or `--tool-mode discover` |
| filter warnings that stop the start | `--strict-filters` turns every filter warning into an error | fix the pattern with the suggestion it prints (the missing-tools file of the routing table) |
| `a filter pattern needs a selector; write` | a pattern from before 0.5.0 | apply the replacement it names |
| `unknown filter selector`, `needs an HTTP method`, `needs a path that starts with "/" or "*"`, `filter pattern needs a value`, `which is not a standard method and no operation in the spec declares` | a pattern with a typo | `method:`, `path:`, `route:`, `operationId:`, `name:` or `tag:` with a value |
| `a filter pattern must be at most 256 characters`, `at most 10 wildcards`, `at most 128 patterns are accepted per flag`, `filter matching exceeded its work budget` | too long, too many or too broad patterns | fewer, narrower patterns |
| `the spec cache entry is unusable`, `the accepted baseline is the durable record` | a damaged cache entry | ask the user; `openapi-mcp cache clear --spec <source>` for that entry |
| `is locked by another openapi-mcp process`, `openapi_mcp_status` with `cacheLock: stale` | another process holds the entry's lock, or a dead one left it | wait; if that process is gone, ask the user before `cache unlock` (with `--force` only when the text says so) |
| `changed while this run was reading it`, `another openapi-mcp process changed it` | two processes updated the cache at once | run the command again |
| `is a symlink, which is not allowed`, `exists and is not a directory`, `the spec cache could not`, `cache file` with `-byte budget` | the cache folder under `~/.kaisers-io/openapi-mcp/cache` is broken | `openapi-mcp doctor` shows the folder; the user fixes it |

Cache commands are the user's decision. They fail with `cache clear needs an explicit target`
(pass `--spec`, `--id` or `--all`; an `--id` is the 16-character id `cache list` prints),
`no cache entry` (exit 4), `no candidate is waiting for promotion` or `--hash does not match
the waiting candidate` (exit 5), and `is not known to be stale` (`cache unlock` needs
`--force`, after the user confirms that no other process runs).

## Startup warnings

| Warning | Meaning | What to do |
|---|---|---|
| `spec refresh failed, serving the last known good accepted baseline` | the refresh failed; the text after the colon says why | fix that cause; with `persisted-document budget`, the spec is over 64 MiB and does not update |
| `the refreshed spec is stored as a candidate`, `a refreshed spec is waiting as a candidate` | a changed spec waits for review | the user reviews it, then `openapi-mcp cache promote --spec <source>` |
| `removed in the pending candidate spec are withheld` | those tools are gone until the review | as above |
| `operations of the candidate spec pass the current filters` | after `cache promote` the server may not start | narrow the filters before promoting |
| `spec cache bypassed` | `--trust-spec-updates` with a spec credential and no key, or no home directory | expected; `--cache-key` gives a durable cache |
| `cache metadata not updated, serving the verified baseline` | another process held the lock | nothing; tools work |
| `expands to N bytes after variable substitution` | the spec's server URL is too long and is ignored | `--base-url` |
| `credentials no configured header satisfies` | exposed operations need a credential that no flag sends; it names the flag | add the flag it names |
| `--tool-mode auto: discover, since` | `auto` chose `discover` by count or size | expected; `--tool-mode per-operation` for one tool each |
| `--tool-mode discover exposes` | one approval of `call_operation` covers every write | tell the user; narrow `--allow`, or `per-operation` |
| `has the name of the program tool` | the spec has an operation named `execute_code` | `--tool-mode discover` lists both |
| `are longer than 50 characters` | with `--api`, hosts may cut longer tool names | shorter API names, or `--tool-mode discover` |
| `has an output side that cannot be built`, `so its calls fail` | under `discover`, one tool cannot be called | `--omit-output-schema` for it, after the user agrees |
| `oauth: no --oauth-required-scope is set` | every token of the issuer for this audience grants all tools | `--oauth-required-scope`, if the user wants to restrict |
| `--uploads: removed` | the startup sweep of files older than 24 hours | expected |
| `published an EMPTY JWKS`, `JWKS refresh failed` | the issuer's key set is empty or unreachable; tokens fail until it recovers | the user checks the authorization server |
| `stdio transport:`, `http transport:`, `more warning` ... `suppressed` | the client sent requests the server could not read | a host or client bug; update the host |
| `operations not exposed:`, `matches no`, `which is not exposed, is refused`, `omitted` | filter and spec results | the missing-tools file of the routing table |

# A tool call returns an error

Errors from the API carry no host or path, so that a response cannot leak them. The result's
`_meta` has `openapi-mcp/effect`, which states evidence, not a guarantee: `not_sent` (no
request reached the API), `upstream_rejected` (the one request got a 4xx), `upstream_reported_success`
(a 2xx came back, but the result could not be returned) or `outcome_unknown`. Only `not_sent`
means the API saw nothing. After any other effect, check the data before a write is repeated.
Details:
[docs/security.md, Failed writes and retries](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/security.md#failed-writes-and-retries).

| Error text | Cause | Fix |
|---|---|---|
| `invalid tool arguments:` with paths | arguments do not match the input schema | read the tool's schema; nothing was sent |
| `upstream request failed with status 401` | missing or wrong credential | check the variable holds the full value (`Bearer <token>` for bearer), and that it reaches the server |
| `status 403` | the credential lacks a permission or scope | the user checks the token's permissions; `--upstream-oauth-scope` for OAuth |
| `status 404` | wrong base URL, or the object does not exist | compare `check`'s `baseUrl` with the API docs; `--base-url` with the API's path prefix |
| `the upstream request timed out` | the API is slow | `--request-timeout`, below the host's tool timeout |
| `the request to the upstream server failed` | DNS, TLS or network | test the base URL from the same machine |
| `not allowed by the egress policy` | the base URL or a redirect leads to a private address | `--allow-private-network` only after the user confirms the address is theirs |
| `did not match the tool's declared output schema` | the API answers differently from its spec | `--log json` shows `mismatch`; a spec fix, `--nullable-response-fields`, or `--omit-output-schema` for that tool |
| `exceeded the maximum response size` | response over `--max-response-bytes` | smaller responses from the API (pagination, its own field or page-size parameters); `--response-projection` does not help, since the limit applies while the response is read; raise the limit last |
| `could not obtain an OAuth2 access token` | client ID, secret, token URL or scope | check the variables and `--upstream-oauth-token-url` |
| `refusing to send a secret header in cleartext` | `http://` to a remote host | use `https://` |
| `rate limit exceeded`, `overloaded` | `--rate-limit` or `--max-concurrency` reached | wait `retryAfterMs`; raise the limit if the user agrees |
| `its result was withheld because it contained a registered secret` | the API echoed a credential | do not retry; tell the user |

## `execute_code` errors

A failed program returns `error` and `calls`, the operations it called with their status. A
call inside a program fails with the same text as a `call_operation` call, see above.

| Error text | Cause | Fix |
|---|---|---|
| `is not read-only: execute_code calls read-only operations only` | the program called a write | the agent uses `call_operation` for writes; nothing was sent |
| `call limit reached: at most 50 api.call() per script` | too many calls in one program | split the work over several programs, or filter in the API (query parameters) |
| `rate limit exceeded` inside a program | the program's calls count against `--rate-limit` (120 a minute by default) | wait `retryAfterMs`, or raise `--rate-limit` if the user agrees |
| `time limit reached` | the program, its calls included, ran over 30 s | fewer or faster calls; `--request-timeout` bounds each call |
| `result too large` | the returned JSON is over 50 KB | return only the fields needed |
| `results too large` | the program received over 8 MB of results | smaller pages, fewer calls |
| `memory limit reached`, `out of memory` | the program built too large values | keep less in memory |
| `scripts are already running` | four programs run at once in this server | wait for one to finish |
| `SyntaxError`, `TypeError` and other script errors | a bug in the program | the agent fixes the program |
| no `execute_code` tool | `--no-execute` is set, an operation of the spec is named `execute_code` (startup says so), or the version is older than the one that added the tool | remove `--no-execute`; `--tool-mode discover` for the name; update the version |
| `the result is not a JSON value` | the program returned a function, a symbol or other data JSON cannot hold | the agent returns plain data |
| `returned an image, which a program cannot read` | a program called an operation with an image result | the agent calls that operation directly |

## More detail

`--log json` on the entry writes one line per call to stderr: `outcome`, `status`, timings, and
for a schema mismatch the failing location. It never logs arguments, header values or bodies.
Add it, restart the host, repeat the call, and read the host log.

# A tool call returns an error

Errors from the API carry no host or path, so that a response cannot leak them. Most texts
start with `tool execution failed:`. The result's `_meta` has `openapi-mcp/effect`, which states
evidence, not a guarantee: `not_sent` (no request reached the API), `upstream_rejected` (the
one request got a 4xx), `upstream_reported_success` (a 2xx came back, but the result could not
be returned) or `outcome_unknown`. Only `not_sent` means the API saw nothing. After any other
effect, check the data before a write is repeated; a write's text then ends with
`so do not retry it blindly`. Details:
[docs/security.md, Failed writes and retries](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/security.md#failed-writes-and-retries).

## Contents

- [The request](#the-request)
- [The API's answer](#the-apis-answer)
- [Limits, OAuth and secrets](#limits-oauth-and-secrets)
- [Images and uploads](#images-and-uploads)
- [`discover` tools](#discover-tools)
- [`execute_code` errors](#execute_code-errors)
- [Over HTTP](#over-http)
- [More detail](#more-detail)

## The request

Nothing was sent after any of these.

| Error text | Cause | Fix |
|---|---|---|
| `invalid tool arguments:` with paths | arguments do not match the input schema | read the tool's schema |
| `missing required value for`, `is required and must not be null`, `missing required request body` | a required argument is missing | the agent adds it |
| `contains a path separator or dot-segment` | a path argument holds `/`, `\`, `..` or an encoded form | the agent passes the plain value |
| `must not be empty`, `cannot be serialized`, `could not be encoded`, `must be an object`, `must be an array or object` | a value of the wrong shape | the agent follows the schema |
| `contains its own ... delimiter, which is ambiguous`, `has a key containing "[" or "]"` | a query value holds the character the style uses as separator | another value, or the API's other parameter |
| `contains a control character`, `contains a character above U+00FF` | a header argument with a line break or non-Latin-1 text | ASCII text in headers |
| `must be a valid base64 string`, `must be valid base64 (RFC 4648)` | a binary field that is not base64 | base64, or `{"file": "<name>"}` with `--uploads` |
| `body needs at least one part`, `the event-stream body`, `a sequential request body must be an array` | a body of the wrong form for its media type | the agent follows the schema |
| `with these arguments its URL is not this tool's own operation of the API` | the arguments turn the URL into another operation | other values; nothing was sent |
| `its URL also matches an operation this server does not expose` | the path overlaps an excluded one; `check` warns at startup | the user decides: allow the other operation, or keep the refusal |
| `the built request URL exceeds`, `the built request headers exceed`, `the built request body exceeds`, `the final request exceeds the outbound resource budget` | URL over 8 KiB, headers over 16 KiB, or a body over `--max-response-bytes` | smaller arguments |
| `provide all required body fields together, or omit the body entirely` | only part of an optional body was given | all its required fields, or none |
| `the final request URL could not be constructed`, `escaped the configured base URL` | a path argument would leave the base URL | other values |
| `this tool's output schema could not be compiled` | the tool cannot validate a response, so it sends nothing | `--omit-output-schema` for it, after the user agrees |
| `a tool argument collided with a reserved header name` | an argument sets a header a flag already sets | expected; the flag's value is sent |
| `refusing to send a secret header in cleartext` | `http://` to a remote host | use `https://`; `--allow-insecure-http` only if the user agrees |
| `not allowed by the egress policy` | the base URL or a redirect leads to a private address | `--allow-private-network` only after the user confirms the address is theirs; it never admits link-local addresses (`169.254.0.0/16`, `fe80::/10`) |
| `projection requires a JSON response` | `_fields` on a tool without JSON | call it without `_fields` |
| `_fields would return more than twice the size of the response` | the selection repeats or overlaps parts of the response | select fewer or narrower fields |
| `not a valid JSON Pointer` | a `_fields` entry is not `/a/b` form | up to 32 pointers such as `/items/*/id` |

## The API's answer

| Error text | Cause | Fix |
|---|---|---|
| `upstream request failed with status 401`, `(check the X environment variable)` | missing or wrong credential | check the variable holds the full value (`Bearer <token>` for bearer), and that it reaches the server |
| `status 403` | the credential lacks a permission or scope | the user checks the token's permissions; `--upstream-oauth-scope` for OAuth |
| `status 404` | wrong base URL, or the object does not exist | compare `check`'s `baseUrl` with the API docs; `--base-url` with the API's path prefix |
| `status 4xx: <text>` | the API's own error text follows the colon | read it; it is the API's answer |
| `the upstream request timed out` | the API is slow | `--request-timeout`, below the host's tool timeout |
| `the request to the upstream server failed` | DNS, TLS or network | test the base URL from the same machine |
| `the request was cancelled` | the host cancelled the call, for example on its own timeout | raise the host's tool timeout, or a lower `--request-timeout` |
| `tool execution failed unexpectedly`, `tool call failed unexpectedly`, `an unexpected error occurred` | a fault in the server | `--log json` and the host log; report it with the spec |
| `returned status 3xx, which is not supported` | the API answers with a redirect it does not follow | the API's direct URL as `--base-url` |
| `followed too many redirects`, `sent an invalid redirect` | over 5 redirects, or no valid `Location` | the API's direct URL |
| `redirected a request other than GET or HEAD, which is not followed` | a write was redirected | the API's direct URL; the write may have arrived |
| `redirected outside the API base URL` | the API sends the client to another host or path | `--allow-offsite-redirects` after the user agrees, for example for downloads |
| `redirected to a URL that is not an operation this server exposes` | the target is excluded or unknown | allow the target operation, if the user wants |
| `did not match the tool's declared output schema`, `did not match a declared output branch`, `had no body to validate`, `was not valid JSON`, `was not a valid ... sequence`, `was not valid UTF-8 text` | the API answers differently from its spec | `--log json` shows `mismatch`; a spec fix, `--nullable-response-fields`, or `--omit-output-schema` for that tool |
| `No structured result is returned: this status is not documented` | an undocumented 2xx under `--default-response-is-error` | the write likely happened; fix the spec, or drop that flag |
| `used an unsupported media type` | a PDF, binary or image answer the server does not return | images: `--image-responses inline` or `file`; other types are not supported |
| a tool returns text, `CLI --json tools` shows `outputSchemaWithheld: No output schema: ...` | a name or value in the response schema has a control or bidirectional-override character | expected; the agent reads the text |
| a field description ends with `Pattern (not enforced): <pattern>` | the response `pattern` nests quantifiers, or has quantifiers side by side that can match the same characters (`^\d*\.?\d+$`, `.*:.*`), which is too costly for the client's regex engine, or RE2 cannot run it (lookaround, backreferences); only that keyword left the output schema | expected; a value that does not match is not an error |
| a field description ends with `Format (not enforced): url` | the client's check of the ajv-formats `url` format slows down quadratically on long values; only that keyword left the output schema | expected; a value that is not a URL is not an error |
| `(the response text above was truncated` | the text copy is over 8 KiB | `_fields` with `--response-projection`, or smaller pages |

## Limits, OAuth and secrets

| Error text | Cause | Fix |
|---|---|---|
| `exceeded the maximum response size` | response over `--max-response-bytes` | smaller responses from the API (pagination, its own field or page-size parameters); `--response-projection` does not help, since the limit applies while the response is read; raise the limit last |
| `rate limit exceeded`, `too many upstream requests are already in flight or queued`, `timed out waiting for a free upstream request slot` | `--rate-limit` or `--max-concurrency` reached | wait `retryAfterMs`; raise the limit if the user agrees |
| `the call timed out before the request was sent` | the call's time went to waiting in the queue | fewer parallel calls, or a higher `--request-timeout` |
| `could not obtain an OAuth2 access token:` | the text after it names the cause, see below | check the variables and `--upstream-oauth-token-url` |
| `the token endpoint answered HTTP 401 (invalid_client)`, `(invalid_scope)` and other codes | wrong client ID or secret, or a scope the client may not have | the user checks the client; `--upstream-oauth-scope` |
| `the token endpoint could not be reached`, `the token request timed out`, `the token endpoint address is not allowed by the egress policy`, `redirected, which is never followed` | network, a private token URL, or a token URL that redirects | the final token URL; `--allow-private-network` only if the user confirms |
| `is not a JSON object`, `carries no valid access_token`, `is not a Bearer token`, `exceeded its size budget` | the token endpoint answers in an unexpected form | the user checks the token URL |
| `timed out waiting for an OAuth2 access token`, `fresh OAuth2 access token` | the token request took the call's time | a faster token endpoint, or a higher `--request-timeout` |
| `its result was withheld because it contained a registered secret`, `its error details were withheld` | the API echoed a credential | do not retry; tell the user |

## Images and uploads

| Error text | Cause | Fix |
|---|---|---|
| `is an image over the 5242880-byte image limit`, `over 8000 pixels per side` | an image over 5 MiB or 8,000 pixels | smaller images from the API |
| `is not a PNG, JPEG, GIF or WebP image` | another image format | not supported |
| `is an image that could not be saved` | `--image-responses file` cannot write its folder | check `~/.kaisers-io/openapi-mcp/images/` |
| `upload "x" is not a plain file name in the upload folder`, `is not in the upload folder`, `is not a regular file`, `must be a plain file name` | the name has a path, or the file is missing or a link | copy the file into `~/.kaisers-io/openapi-mcp/uploads/<api>/` and pass its name |
| `is larger than the ... request body limit` | the file is over `--max-response-bytes` | a smaller file, or a higher limit if the user agrees |
| `is not the declared` | the file's bytes do not match the image type the operation declares | the right file |

## `discover` tools

| Error text | Cause | Fix |
|---|---|---|
| `unknown operation "x"` | the name is not an exposed operation | `search_operations` for the name; filters decide what exists |
| `is unavailable: its definition could not be built` | startup warned about this operation | the startup warnings of the startup file |
| `unknown tool "x"`, `invalid tools/list cursor`, `task-augmented tools/call is not supported` (protocol errors, not results) | the host calls a tool this server does not list, or speaks a form it does not support | restart the host so it reloads the list; remove `--tools-page-size` |

## `execute_code` errors

A failed program returns `error` and `calls`, the operations it called with their status. A
call inside a program fails with the same text as a `call_operation` call, see above.

| Error text | Cause | Fix |
|---|---|---|
| `is not read-only: execute_code calls read-only operations only` | the program called a write | the agent uses `call_operation` or the tool for writes; nothing was sent |
| `call limit reached: at most 50 api.call() per script`, `the script exceeded its call limits` | too many calls in one program | split the work over several programs, or filter in the API (query parameters) |
| `arguments too large` | one call's arguments are over 100,000 bytes of JSON | smaller arguments |
| `time limit reached` after many calls | the program's calls count against `--rate-limit` (120 a minute by default); a call the limit stops waits, and the waits used up the 30 s | fewer calls per program, or raise `--rate-limit` if the user agrees |
| `time limit reached` | the program, its calls included, ran over 30 s | fewer or faster calls; `--request-timeout` bounds each call |
| `result too large` | the returned JSON is over 50 KB | return only the fields needed |
| `results too large` | the program received over 8 MB of results | smaller pages, fewer calls |
| `memory limit reached: the script used too much memory` | the program built too large values | keep less in memory |
| `scripts are already running` | four programs run at once in this server | wait for one to finish |
| `SyntaxError`, `TypeError` and other script errors | a bug in the program | the agent fixes the program |
| `unknown operation` | the program names an operation that is not exposed | the name from `search_operations` or the tool list |
| `the script failed unexpectedly`, `the call failed unexpectedly`, `cancelled` | the sandbox stopped, or the host cancelled the call | run it again; report it if it repeats |
| no `execute_code` tool | `--no-execute` is set, an operation of the spec is named `execute_code` (startup says so), or the version is older than the one that added the tool | remove `--no-execute`; `--tool-mode discover` for the name; update the version |
| `the result is not a JSON value` | the program returned a function, a symbol or other data JSON cannot hold | the agent returns plain data |
| `returned an image, which a program cannot read` | a program called an operation with an image result | the agent calls that operation directly |

## Over HTTP

With `--http`, a refused request gets an HTTP status, not a tool result. The body is empty
unless noted, and stderr says `oauth: token rejected: <reason>` in OAuth mode.

| Status | Cause | Fix |
|---|---|---|
| 401 | missing or wrong bearer token; in OAuth mode an invalid or expired token (`invalid_token`) | the host sends `Authorization: Bearer <token>` from the same variable |
| 403 | a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, any `Origin` header, or a token without a required scope (`insufficient_scope`) | connect to the loopback URL from a non-browser client; the scopes of `--oauth-required-scope` |
| 405 | a method other than `POST` (the server keeps no sessions) | the host's Streamable HTTP client |
| 400 | a body over 4 MiB, or not JSON (`Parse error`) | smaller requests |
| 415 | no `Content-Type: application/json` | the host's Streamable HTTP client |
| 503 `temporarily_unavailable` | the issuer's keys could not be refreshed | check the issuer; stderr shows `JWKS refresh failed` |

## More detail

`--log json` on the entry writes one line per call to stderr: `outcome`, `status`, timings, and
for a schema mismatch the failing location. It never logs arguments, header values or bodies.
Add it, restart the host, repeat the call, and read the host log. To see the request a call
would send without sending it, see the reproduce file of the routing table.

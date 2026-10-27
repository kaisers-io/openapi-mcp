# Requests and responses

This page explains how `openapi-mcp serve` turns a tool call into an HTTP request and the
upstream answer back into a tool result. It covers the OpenAPI features the server supports,
request bodies, uploads, response validation, images, headers, pagination, limits, retries,
error details, the call log and memory use. Read it when a tool behaves differently than you
expect, or before you tune `serve` for an API. Every flag is listed in the
[flag reference](configuration.md#serve).

A few terms first. The *upstream* is the HTTP API that the spec describes. An *output schema*
is the JSON Schema a tool declares for its result; when a tool has one, the result also comes
as `structuredContent`, data that the host can read without parsing text. `_meta` is a field
of an MCP result that carries details for the host, next to the text the model reads.

## Supported OpenAPI versions

`--spec` accepts OpenAPI 3.0.x, 3.1.x and 3.2.x. The server serves a 3.2 spec like a 3.1 one,
plus the 3.2 features below. Swagger (OpenAPI 2.0) documents are not supported. Operations
with the `OPTIONS` or `TRACE` method are never exposed.

### `QUERY` operations

A 3.2 `QUERY` operation (RFC 10008: a safe, idempotent read with a request body) becomes a
read-only tool. The read-only default exposes it, `--retries` applies to it, and the server
sends its body with the `QUERY` method. If an optional form-urlencoded body is left out, the
server sends the empty form with its `Content-Type`, because a QUERY server must reject a
request without one.

The server follows a redirect of a `QUERY` only when it is a `303`, and then as a `GET`, as
RFC 10008 §2.5 allows. Any other redirect would repeat the query without its body, so it is a
tool error, as it is for a write.

### Other methods (`additionalOperations`)

An operation under `additionalOperations` (another HTTP method, such as `LINK` or `COPY`)
becomes a tool, and the server sends its request with the method exactly as declared. The
server does not know what the method does, so it treats it like `POST`:

- The read-only default does not expose it.
- Its tool annotations mark it as destructive.
- `--retries` never repeats it.
- A redirect other than `303` is a tool error.

You name it in a filter like any other method, for example `--allow "method:link"` or
`--allow "route:LINK /orders/*"`. The server omits the operation when the method name is not
upper case, when it is `CONNECT` or `TRACK`, or when it is a method that has its own Path Item
field (such as `GET`).

### `querystring` parameters

A 3.2 `querystring` parameter stands for the whole query string. It becomes one tool argument
when its `content` is `application/x-www-form-urlencoded` over an object of scalar values.
The server form-encodes the object's entries into the query string, with `+` for a space.

The server omits the operation in these cases:

- the parameter uses any other media type or shape;
- it declares an Encoding Object;
- there are two `querystring` parameters, one on the path item and one on the operation;
- a `querystring` parameter sits next to `query` parameters.

### Sequential media types

A sequential media type is a body made of repeated items without an outer envelope. The
server knows four of them: JSON Lines (`application/jsonl`), NDJSON (`application/x-ndjson`),
JSON text sequences (`application/json-seq`, and any `+json-seq` type) and Server-Sent Events
(`text/event-stream`).

The server reads such a response as the array of its items, once the upstream has sent the
whole body within `--request-timeout`. It does not stream it. In a 3.2 spec, `itemSchema`
validates each item and `schema` validates the whole array, so the tool returns structured
data. An event is `{data, event?, id?, retry?}`, as OAS 3.2.1 §4.14.4 describes it.

A request body in one of these types becomes one array argument, `body`, which the server
writes in the media type's framing. A request body that declares both `schema` and
`itemSchema` omits the operation.

A 3.0 or 3.1 spec defines no such mapping. There, such a response comes back as text, and
such a request body omits the operation.

### OAuth2 metadata URL

The credential hint shows an oauth2 scheme's `oauth2MetadataUrl`. The server never fetches
it, because the flows already name the token endpoint.

### The API base URL

The server expands `servers[0].url` with the defaults of its variables. If the result would
be longer than 2048 UTF-8 bytes, the server ignores it with a warning and builds nothing.
`--base-url` still works with such a spec. Without `--base-url`, `serve` stops with the usual
"no absolute server URL" usage error. That also holds for a spec loaded from a URL: the server
does not fall back to the spec's own origin in this case.

## Request bodies and parameters

Each tool's input schema is closed: the server checks every call against it before it builds a
request, and an argument the operation does not define is an invalid argument, not ignored.

### Which body media type is used

When an operation declares several request body media types, the server picks one, in this
order:

1. `application/json`.
2. Otherwise one `application/*+json` type. If several are declared,
   `application/merge-patch+json` wins; any other tie omits the operation.
3. Otherwise `application/x-www-form-urlencoded`, bare or with `charset=utf-8`. The server
   always encodes the form as UTF-8.
4. Otherwise `multipart/form-data`, declared without parameters.
5. Otherwise `application/octet-stream`.
6. Otherwise one of `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
7. Otherwise, in a 3.2 spec, a sequential media type.

A request body with an Encoding Object omits the operation. So does a body that has none of
these types.

### Query parameter styles

Query parameters support the OAS 3.1.1 §4.8.12.4 styles that the spec defines for their
shape. The server lists an operation that uses an undefined combination as omitted, with the
reason:

- `form` (the default), with or without `explode`.
- `deepObject` needs `explode: true`, set explicitly. `explode` defaults to `true` only for
  `form`, so a spec that leaves it out on a `deepObject` parameter has that operation omitted
  (Stripe-style specs often do). The value must be an object of scalars. At call time the
  server rejects a key that contains `[` or `]`, because the upstream would read it as
  nesting (`filter[a][b]`).
- `spaceDelimited` and `pipeDelimited` need `explode: false`, their only defined form. The
  value is an array or an object of scalars. The server rejects an item that contains its own
  delimiter as ambiguous. An empty array or object sends nothing, as with `form`.

Path and header parameters use the `simple` style. A parameter with `allowReserved: true`, or
with `content` instead of `schema`, omits the operation, and so does a cookie parameter.

### `multipart/form-data` bodies

Each property of the body object becomes one part:

- A file part (`{type: string, format: binary}`, or 3.1 `contentMediaType`) is a base64 tool
  argument. The server sends it as raw bytes with `filename="<part name>"`. Its
  `Content-Type` is the declared `contentMediaType` when that names one concrete type
  (`image/png`), otherwise `application/octet-stream`. A file part with other keywords
  (`maxLength`, `nullable`, `enum` and so on) omits the operation, so it is never sent as
  text.
- Any other part must be a single non-null scalar: a string, number, integer or boolean, or
  an `enum` or `const` of those. Arrays (repeated parts or several files), objects (JSON
  parts) and nullable parts omit the operation.
- RFC 2046 requires at least one part. If a call to a required multipart body leaves every
  part out, the server refuses it with a message that names the parts. It does not send an
  empty body, which strict servers reject.

### Header parameters and `Accept`

A tool caller can pass the header parameters the operation declares. The server sends header
values as bytes and refuses some characters before any request is sent; see
[credentials](credentials.md#rules-for-every-header) for the rules, which also apply to `--header`.

The server derives the `Accept` header from the media types the operation declares for its
`2xx` responses. Declared JSON types come first, other declared types follow with `q=0.9`,
and `*/*;q=0.1` comes last. An operation that declares no success media type asks for
`application/json, */*;q=0.1`.

The server ignores a header parameter named `Accept` in the spec, because OpenAPI says it
must be ignored. An API that needs a vendor media type that the spec expresses only there
(for example a GitHub preview type, `application/vnd.github.<preview>+json`) then returns its
default representation. Pass `--header Accept:<media type>` to override the derived value.

### Request size limits

`--max-response-bytes` (default `10MB`, at most 100 MiB) also caps every outgoing request
body. The server measures the body after encoding; for an `application/octet-stream` upload
that is the decoded bytes. Inside the JSON-RPC message, the base64 tool argument that carries
an upload is about 4/3 of that size.

Two more limits have no flag. A built request URL may be at most 8192 characters long, and
the request headers at most 16,384 bytes. A call over any of these limits is a tool error,
and the server sends nothing.

## Binary bodies and uploads

A request body of `application/octet-stream`, or of `image/png`, `image/jpeg`, `image/gif` or
`image/webp`, is one base64 tool argument, `body`. The server sends it as the raw bytes with
that `Content-Type`. When the operation also declares a structured body type (JSON, form,
multipart), the server prefers that type, then `application/octet-stream`, then an image
type.

Base64 costs the model about a third more characters than the file has bytes, which makes
anything but a tiny file impractical to send. With `serve --uploads`, every binary field (a
multipart file part, an octet-stream body or an image body) also takes a file name:

```json
{ "body": { "file": "photo.png" } }
```

A call then costs a few tokens for the name, instead of about 1.3 characters per byte of the
file. Base64 keeps working next to file names.

### The upload folder

The server reads the named file from `~/.kaisers-io/openapi-mcp/uploads/<api>/` and sends its
bytes.

- `<api>` is the name the spec cache uses for the spec source and `--cache-key`.
- The folder path is the same on every platform. The server creates it at startup, open to
  your user only.
- The field's description names the folder, so the agent can copy a file there first.
- At startup the server removes files in the folder that are older than 24 hours.

An agent that runs in a sandbox needs write access to that folder:

- Codex in `workspace-write` mode: add the folder to `writable_roots` under
  `[sandbox_workspace_write]` in `config.toml`.
- Claude Code: add the folder to `permissions.additionalDirectories`, or pass it with
  `--add-dir`. Otherwise Claude Code asks before it writes there.

### Which names and files the server accepts

A name is letters, digits, `_` and `-`, in dot-separated parts, starting with a letter or a
digit, at most 128 characters, in a flat folder. The server refuses paths, `..`, drive
letters, `:`, spaces, non-ASCII characters and Windows device names (`CON`, `NUL` and so on)
before it opens anything.

The server reads only a regular file with a single link that fits the request body limit
(`--max-response-bytes`). It refuses a symbolic link, a junction, a directory, or a hard link
to a file elsewhere.

For a declared image type, the file's first bytes must show that type. An octet-stream field
takes any file.

A refused upload is a tool error, and the server sends nothing. You cannot combine
`--uploads` with a non-loopback `--http-host`, because a remote client could then make the
server send this machine's files.

## Responses

### What a result contains

When a tool has an output schema, a successful result carries `structuredContent` with this
envelope:

| Field | Content |
|---|---|
| `status` | the upstream status code |
| `contentType` | the documented media type of the response |
| `data` | the parsed body |
| `headers` | forwarded response headers, when there are any (see [Response headers](#response-headers)) |
| `pagination` | the next-page hint, for paginated tools (see [Pagination](#pagination)) |

The result also has a text copy of the envelope. That copy is capped at 8 KB (8192 bytes)
with a `…[truncated]` marker; the full data is in `structuredContent`.

A tool gets an output schema only when every documented `2xx` response has a body in exactly
one JSON media type (in a 3.2 spec, a sequential type counts too) and nothing else. A
`default` response or a `2XX` range key also prevents it, unless the flags below change that.
How the schema is shown to the host is covered in
[Output schema form](tool-modes.md#output-schema-form).

A tool without an output schema returns its result as text. A JSON, `text/*` or sequential
body comes back as text, also cut at 8 KB with the same marker; a truncated result says that
it was cut. Any other media type, such as a binary file or `application/xml`, is a tool error
that names the media type. Images are the exception when you turn on
[image responses](#image-responses).

### Response validation

For a tool with an output schema, the server checks the status, media type and body of every
`2xx` response against the schema before it returns anything. A response that does not match
becomes a tool error with only the status in the message: "upstream response for status N did
not match the tool's declared output schema". The server never returns structured output that
does not match the declared schema. The [call log](#call-log) says why a response was
refused. Three opt-in flags change the check for specs that do not describe their API
exactly.

#### `--default-response-is-error`

Without this flag, an operation that documents a `default` response gets no output schema,
because `default` may cover an undocumented success status. With it, only the explicitly
documented `2xx` responses form the output schema. A `2XX` range key still prevents an output
schema. An undocumented `2xx` at runtime then returns a tool error that names the flag; the
server never returns structured output that does not match. [`tools`](configuration.md#tools)
marks the affected tools.

The flag buys structured output at the cost of a possible false error. When the upstream
answers with an undocumented success status (say `201` or `202` where only `200` is
documented), the server reports the call as a tool error even though the upstream action
happened. The error text says so: the upstream reported success (status N), the request was
likely applied, and the caller should not retry it blindly. For write-heavy APIs whose specs
under-document success statuses, leave the flag off.

#### `--nullable-response-fields`

Some generators (springdoc, for one) leave `nullable` out unless a field is annotated, while
the server serializes every unset field as `null`. OpenAPI 3.0 defaults `nullable` to
`false`, so the derived output schema rejects such a response, and the call fails with
"upstream response for status N did not match the tool's declared output schema", even though
the data is usable.

With the flag, every value under an object's `properties` in the derived response (`data`)
schema also admits `null`. That applies at every depth, through `$ref`s, and in the
properties of `allOf`, `anyOf` and `oneOf` members. It includes properties listed in
`required`, because these generators use "required" for "the key is always serialized", not
for "never null".

The flag takes an optional scope:

| Scope | Admits `null` for | Choose it when |
|---|---|---|
| `all` (the default, also given as the bare flag) | every property | the server sends `null` for required keys too |
| `optional` | only the properties their object does not list in `required` | the spec's `required` does mean "never null" |

springdoc, for example, derives `required` from `@NotNull`, `@NotBlank` and
`@Schema(requiredMode = REQUIRED)`. With `optional`, a `null` there still fails, while unset
optional fields sent as `null` pass. A key required only in another `allOf` member counts as
optional.

The flag does not widen these:

- `required` itself, so a required key must still be present;
- array items, so a `null` element is still refused;
- `additionalProperties` values;
- the root `data` value;
- request and input schemas;
- the envelope fields `status`, `contentType`, `headers`, `pagination` and `projection`.

A property that already admits `null` (3.0 `nullable: true`, 3.1 `type: [T, "null"]`) stays
as it is. A wrong non-null type and a missing required key still fail with the same
status-only message. The flag only relaxes validation: the server returns the upstream data
unchanged, nulls included, and `_fields` works on it as usual. The flag applies to
`--tool-mode discover` (`call_operation`) as well. `tools --json` marks each widened tool with
`outputSchemaAdmitsNullFields: true`. Without the flag, the server widens no output schema.

To admit `null` for one property only, or to fix anything else in a spec you cannot change,
correct the spec with an [OpenAPI Overlay](overlays.md) instead.

Prefer fixing it at the source when you can, because that keeps the null check strict for the
fields that are never null:

- In the spec: in springdoc, annotate the fields with `@Schema(nullable = true)`, or
  `types = {"string", "null"}` for OpenAPI 3.1.
- In the server, if you control it: with Spring Boot, set
  `spring.jackson.default-property-inclusion=non_null`. Unset fields are then left out of the
  response instead of being sent as `null`, and optional properties validate without the
  flag. This changes the response for every client of the API, and a required key sent as
  `null` still needs `nullable` in the spec, or the flag.

#### `--omit-output-schema <pattern>`

Sometimes an API's responses do not match its own spec in a way `--nullable-response-fields`
does not cover: a wrong type, a missing required key, or an undocumented property under
`additionalProperties: false`. Then every call to the tool fails with "upstream response for
status N did not match the tool's declared output schema".

`--omit-output-schema` is repeatable. For the tools a pattern matches, the server declares no
output schema, so it returns the result as text, the same way as for a tool whose responses
cannot be described. The MCP specification requires structured results to conform to a
declared output schema, so declaring none is the conforming way to stop the check.

The patterns use the [`--allow`/`--deny` selectors](filtering.md#selectors), such as
`operationId:getOrder` or `route:GET /orders/**`. They act only on the tools the server
exposes. A pattern that matches none of them is a dead pattern: a warning, or an error under
`--strict-filters`. That happens, for example, when the pattern names an operation the filters
exclude or that is omitted as unsupported. For such an operation the warning says that it is
not exposed, instead of suggesting a similar tool, also when the pattern names the omitted
operation by its operationId or tags. A pattern that matches only tools without an output
schema (for example operations with a `default` response, see above) changes nothing; a
warning says so, but it is not an error. At startup the server names the tools that lost
their output schema.

For these tools, the following changes:

- There is no `structuredContent`.
- The server does not check status, media type or body against the spec.
- A JSON body that does not parse comes back as text.
- The pagination hint from a `Link` header still arrives as a separate text block, but a hint
  from the response body does not.

The following stays: the secret scan (a result that contains a configured secret is still
withheld), the size limits, request validation and every network safeguard. The flag applies
to `--tool-mode discover` (`call_operation`) as well, where `describe_operation` shows no
output schema for the tool. Prefer fixing the spec, for example with an
[OpenAPI Overlay](overlays.md), when you can, because that keeps the tool's output validated.

### Selecting fields with `_fields`

With `--response-projection` (off by default), every tool that documents a JSON `2xx`
response accepts an optional `_fields` argument. It takes up to 32 RFC 6901 JSON Pointers,
each at most 256 characters and 32 segments long. A `*` segment maps over an array, for
example `["/items/*/id", "/next_cursor"]`.

Only the selected values come back, under `projection`, keyed by pointer. A missing path
yields `null`. A sequential body (JSON Lines, NDJSON, JSON text sequences, Server-Sent Events)
counts as the array of its items, with or without an output schema. The server still
validates the full response against the tool's output schema first, and then checks only the
selected values for secrets.

The server instructions explain the pointer grammar once. Each tool's schema carries only a
one-line description, and its output schema gains one `projection` branch.

A truncated result of such a tool tells the model to use `_fields`, but only for `GET`,
`HEAD` and `QUERY`, because repeating a write to see the rest of its answer could apply it
twice. When the result is structured, the hint says that only the text copy is cut and
`structuredContent` is complete. Every other truncated result says that it was cut.

The cost is that `tools/list` grows by about 30%, in every session, which is why the flag is
opt-in. Measured: the petstore fixture grows from 907 to 1,174 bytes, and 100 JSON `GET`
operations grow from 83,681 to 110,481 bytes.

## Image responses

`--image-responses <mode>` decides what happens to a `2xx` image from the upstream. The
default, `off`, keeps the old behaviour: an image is a tool error that names its media type.

| Mode | Result | Tokens for a 1000×1000 image |
|---|---|---|
| `off` | tool error: unsupported media type | none |
| `inline` | a text line (media type, size in pixels and bytes) and an MCP `image` block | about 1,300 as vision input |
| `file` | a text line with the same facts and the absolute path of the saved image | about 30; the agent opens the file only when it needs to look at it |

The server accepts only PNG, JPEG, GIF and WebP. The response's `Content-Type` must be an
`image/` type, but the server decides the format from the first bytes of the body, not from
the header. SVG is never accepted. An image may be at most 5 MB (5 MiB) and 8,000 pixels per
side; anything else is a tool error. An image that contains a configured secret is withheld,
like any other result.

Image handling applies only to tools without an output schema, which is every operation that
documents its `2xx` response as an image. An image result carries no `structuredContent`,
because some hosts drop the image when it is present.

### `file` mode

- The server saves images to `~/.kaisers-io/openapi-mcp/images/<api>/`. `<api>` is the same
  name the spec cache uses, derived from the spec source and `--cache-key`. The server creates
  the folder open to your user only. It refuses the folder if it is a link or belongs to
  another user, and closes it to other users again if it is open.
- The server generates the file names (`img-<UTC time>-<random>.<ext>`). It never takes a name
  from the upstream.
- When the folder holds more than `--image-dir-max-bytes` (default `100MB`, at least the 5 MiB
  of one image), the server deletes its own oldest images until the folder fits. It never
  deletes the image it just saved, and never touches files it did not create.
- You cannot combine `file` mode with a non-loopback `--http-host`, because the path means
  nothing to a client on another machine.

A host that cannot open local files (a desktop app without file access, or a remote HTTP
client) needs `inline`. Hosts with file tools, such as coding agents, can use `file`. Some of
them ask before they read a file outside the project folder.

## Response headers

The server forwards a fixed allowlist of upstream response headers into tool results:
`etag`, `last-modified`, `retry-after`, `x-total-count`, `x-ratelimit-*`, `ratelimit*` and
`location`.

- The server forwards a `location` header only when it points to the same origin as the base
  URL, and then only as the path and query.
- A structured result carries the headers in the envelope's `headers` object. A text result
  gets a trailing `headers:` block.
- The server never reads `Set-Cookie` or authentication headers. It does not forward `Link`
  as a raw URL; it turns `Link` into a pagination hint instead.
- The server drops a header whose name or value contains a configured secret.
- The server keeps at most 16 headers per response, and cuts each forwarded value at 512
  characters.

On a `429` or `503`, the server also reports a valid `Retry-After` as
`_meta["openapi-mcp/upstreamRetryAfterMs"]`.

## Pagination

A `GET` tool is paginated when it has a query parameter named `cursor`,
`page_token`/`pageToken`, `after`, `starting_after` or `page`, or when it declares a `Link`
response header. Size or position parameters alone (`limit`, `offset`, `per_page`,
`page_size`) do not make it paginated.

For a paginated tool, each successful result carries `pagination.next`: the arguments for the
next call, including the call's other arguments. `null` means that no next page is known,
either because this is the last page or because the upstream gave no usable hint. It does not
prove that the data is exhausted, for example with an `offset` API without a `Link` header.
The hint never contains a raw URL. A text result gets the hint as a separate `pagination:`
text block.

The server finds the next page in this order:

1. A `Link: <…>; rel="next"` header. The server uses it only if it has the same origin and the
   same (byte-identical) path as the request, and all of its query parameters map onto the
   tool's own query parameters. The server decodes values by the parameter's declared type
   and style: booleans, numbers, comma-joined or repeated arrays, and space- or
   pipe-delimited arrays. `name[key]` parameters (JSON:API `page[number]=2&page[size]=10`,
   `filter[status]=x`) map back onto a `deepObject` parameter `name`, but only keys its schema
   declares, one level deep, each once. A name that could be either a literal parameter or a
   `deepObject` key gives `null`.
2. Without a pagination `Link` header, a JSON:API response (media type
   `application/vnd.api+json`, or a response schema that declares `links.next`) uses its
   top-level `links.next` (a URL, or a link object's `href`) under the same rules.
   `links.next: null` means the last page.
3. Otherwise a cursor in the body. `next_cursor` and `nextCursor` map to `cursor`,
   `next_page_token` to `page_token`, and `nextPageToken` to `pageToken`. Stripe-style
   `has_more` with the last item's `id` maps to `starting_after`. A body cursor needs a
   structured result (an output schema), so a text-only result gets only the `Link` hint.

A hint that the tool's own input schema would reject becomes `null`.

## Timeouts, concurrency and retries

### Timeouts

`--request-timeout` (default `30s`) is the budget for each upstream call, including the time
the call waits in the queue. Keep it below your MCP host's own `tools/call` timeout.

`--timeout` (default `30s`) does not apply to API calls. It bounds the spec fetch and, with
`--http-auth oauth`, each authorization-server metadata and JWKS fetch. If you upgrade from a
version where you raised `--timeout` to make slow API calls work, set `--request-timeout`
instead.

### Concurrency and the rate limit

Both limits apply to the whole process, over stdio and HTTP alike, and with
[several APIs](several-apis.md) all APIs share them.

`--max-concurrency` (default `16`) is the number of upstream calls in flight at once. A call
that finds that many calls in flight waits for a slot, first come first served. At most
4 × `--max-concurrency` calls can wait. The wait and the upstream request share one budget of
`--request-timeout`: a call waits at most half of it for a slot, and its request gets what is
left. A tool call therefore never takes longer than `--request-timeout` end to end, plus
response processing.

`--rate-limit` (default `120/1m`) is the number of tool calls allowed in a sliding window.
Every call to a known tool counts, also one whose arguments turn out to be invalid.

The server refuses a call when the queue is full, when the wait timed out, or when the call
is over `--rate-limit`. A refused call returns a tool error whose text ends in
`retry after <n>s`, and whose result `_meta` holds `"openapi-mcp/error"` and
`"openapi-mcp/retryAfterMs"`:

| `openapi-mcp/error` | When | `openapi-mcp/retryAfterMs` |
|---|---|---|
| `overloaded` | the queue is full, or the wait timed out | a fixed 1000 |
| `rate_limited` | the call is over `--rate-limit` | exact: the time until the oldest call in the window expires |

These details go in `_meta`, not in `structuredContent`, because a tool's structured content
must match its output schema. Both limits are always finite. There is no "unlimited" setting,
because MCP servers must rate-limit tool calls. `--max-concurrency` can be at most 256.

### Retries

`--retries <n>` is off by default (`0`) and takes at most `3`. The server retries a failed
upstream call only for `GET`, `HEAD`, `QUERY`, `PUT` and `DELETE` requests. It retries a
`POST` or `PATCH` only when its operation declares an `Idempotency-Key` header. The server
then sends one key, the caller's value or a generated UUID, on every attempt, and returns it
as `_meta["openapi-mcp/idempotencyKey"]`. If the call still fails, repeat it with that key so
the upstream can deduplicate it.

The server retries only `429`, `502`, `503` and `504` responses, and connection errors that
happen before any response arrived. It does not retry a `DELETE` after such a connection
error: the upstream may already have deleted the resource, and the retry would then report
`404`.

Backoff is exponential with full jitter (250 ms base, 5 s cap). On a `429` or `503`, the
server waits for the upstream's `Retry-After` instead. Retries stay within
`--request-timeout`, the call's concurrency slot and its single rate-limit charge. A retry
whose wait would not fit in the remaining time is not made. The server holds the slot during
the backoff, so under a storm of upstream `Retry-After` answers, queued calls wait (and may
time out waiting for a slot) instead of adding load.

For what a failed write means and when it is safe to repeat it, see
[security](security.md#failed-writes-and-retries).

## Errors and their `_meta`

Keys under `openapi-mcp/` in a result's `_meta` are part of the public contract:

| Key | Present on | Value |
|---|---|---|
| `openapi-mcp/effect` | every tool error of an API call | what the server knows about the call's effect, see below |
| `openapi-mcp/error` | a refused call | `overloaded` or `rate_limited` |
| `openapi-mcp/retryAfterMs` | a refused call | milliseconds to wait before calling again |
| `openapi-mcp/upstreamRetryAfterMs` | an upstream `429` or `503` with a valid `Retry-After` | the upstream's wait, in milliseconds |
| `openapi-mcp/idempotencyKey` | every result of a `POST` or `PATCH` whose operation declares an `Idempotency-Key` header, when `--retries` is above `0` | the key the request was sent with |

### The effect of a failed call

`_meta["openapi-mcp/effect"]` states what the server knows about the effect of a failed call
(issue #25). It is evidence, not a transactional guarantee.

| Value | When |
|---|---|
| `not_sent` | no request left the server (the cases are listed below the table) |
| `upstream_rejected` | the call sent one request, and the upstream answered it with a `4xx` |
| `upstream_reported_success` | the call sent one request, the upstream answered it with a `2xx`, but the result could not be returned (it did not match the declared schema, was not valid JSON, or contained a secret) |
| `outcome_unknown` | everything else: a timeout, a lost connection, an oversized response, a redirect, a `5xx`, and any call that sent more than one attempt |

`not_sent` covers calls the server refused itself: invalid arguments, request authorization,
egress, the rate limit, a full queue and a failed first OAuth2 token. It also covers a failure on
the first hop before the request was written: a failed DNS lookup, a refused connection, a TLS
error, and a timeout or a cancel while connecting.

A first request that the upstream answered with `401`, and that the server sent again with a
fresh OAuth2 token, does not count. It was not authorized, so it had no effect, and the
request sent again decides the value.

For a write (any method other than `GET`, `HEAD` and `QUERY`), the text of an
`outcome_unknown` or `upstream_reported_success` error ends with a warning that the request
may have been applied and must not be retried blindly. Messages for reads are unchanged.

## Logging and tracing

### Call log

`--log json` (off by default) writes one JSON line per tool call to stderr, never to stdout.
Each line has `ts`, `event: "tool_call"`, `tool`, `outcome` and `latencyMs`. When they are
known, it also has `method`, `pathTemplate`, `status`, `responseBytes`, `queuedMs`,
`upstreamMs` and `attempts`.

`outcome` is one of these values:

| Outcome | Meaning |
|---|---|
| `ok` | success |
| `http_error` | the upstream answered with a status of `300` or above |
| `response_error` | the upstream's success response could not be returned |
| `secret_withheld` | the upstream answered, but the result contained a configured secret, so the client got an error |
| `validation_error` | bad arguments |
| `refused` | local policy refused the call: the cleartext credential gate or the outbound size budget |
| `token_error` | the server could not obtain an upstream OAuth2 access token, so it sent no request |
| `rate_limited` | over `--rate-limit` |
| `overloaded` | the queue was full or the wait timed out |
| `egress_denied` | the egress policy refused the destination |
| `timeout` | the call ran out of time |
| `cancelled` | the client cancelled the call |
| `network_error` | a connection failed |
| `internal_error` | an unexpected error in the server |

`upstreamMs` runs from the first request to the final outcome. With `--retries` it includes
every attempt and the backoff or `Retry-After` waits between them. `attempts` says how many
requests the server sent, a `401` token replay included.

The log never contains arguments, header values, filled URLs or bodies, and the server
redacts every string in it.

When the server refuses a response because it does not match the operation's output schema,
the line also says why, under `mismatch`, so you can fix the spec where it is wrong:

```json
{"category":"schema","keyword":"type","path":"/owner/email","expected":"string","observed":"null"}
```

- `category` is `schema`, `empty_body`, `invalid_json`, `invalid_utf8`, `invalid_sequence` or
  `unmatched_branch` (a status or media type the spec does not document).
- `path` points into the response data and is built from the spec's property names only. An
  array element is `*`, and a key the response added, an index or a value never appears. The
  server leaves `path` out where it cannot prove the location (through a `$ref`), where the
  path contains a configured secret, and where it is longer than 256 characters; it never
  cuts the path. With `--output-schema defs` most repeated subschemas sit behind a `$ref`, so
  `path` is mostly absent there.
- `expected` and `observed` are JSON type names, given only for a `type` failure.
- A failed union is reported as its `anyOf` or `oneOf`.

The client still gets the same message, and without `--log json` the server computes none of
this.

### Call counters

Whether or not `--log` is set, the `openapi_mcp_status` tool reports process-local counters
under `calls`: the total (`total`), counts by outcome (`byOutcome`), and the p50 and p95 of
`upstreamMs` over the last 512 calls that reached the upstream (`upstreamLatencyMs`). The
counters reset when the server restarts. Every client of the server sees them: over `--http`
with several clients, each one sees the aggregate counts of all of them (counts only, no
content).

### Trace context

Trace propagation is on by default. When a `tools/call` carries a valid W3C `traceparent`
(and optionally `tracestate`) in `_meta`, the server sends them to the upstream as the
same-named headers, on same-origin hops only. The server drops an invalid value. It reads a
higher `traceparent` version by the version-00 layout and forwards it as `00`. Tool arguments
can never set these headers.

This gives the upstream a correlation ID across calls and sessions, which is what you want for
an API you operate. For a third-party API that you do not operate, pass
`--no-trace-propagation`.

## Memory

Each in-flight call may buffer up to `--max-response-bytes` of decompressed body. While the
server processes a JSON result, the call briefly holds a few copies of it: the bytes, the
decoded text, and the parsed value that the MCP SDK then serializes. Plan for roughly
4 × `--max-response-bytes` per in-flight call, times `--max-concurrency` at worst. With the
defaults of `10MB` and `16`, that is about 640 MB.

For the memory a large spec needs at startup, see
[Memory for large specs](tool-modes.md#memory-for-large-specs).

## Related options

- [Exit codes](configuration.md#exit-codes) and the full flag list are in the
  [configuration reference](configuration.md).
- `--tools-page-size` is in [Paging `tools/list`](tool-modes.md#paging-toolslist), and the tool
  modes for large APIs are in [tool-modes.md](tool-modes.md).
- `--upstream-oauth-client-id-env` and `--upstream-oauth-client-secret-env`, which obtain the
  upstream API's access token with the OAuth2 client-credentials grant, are in
  [credentials](credentials.md#oauth2-client-credentials).

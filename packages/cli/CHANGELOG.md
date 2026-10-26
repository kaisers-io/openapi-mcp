# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Several APIs behind one server (#16).** `serve --api <name>=<source>` declares one API, and
  can be repeated; every per-API option then starts with the API's name (`--allow
  github=tag:repos`, `--header-env shop=Authorization=SHOP_TOKEN`), switches are set with
  `--enable <name>=<switch>`, and an unnamed `--deny` applies to every API. Tools are named
  `<api>_<name>`. Each API keeps its own base URL, credentials, OAuth, egress policy, filters and
  routes; its credentials go only to URLs under its own base URL, also on a shared origin.
  Overlapping base URLs, a shared cache namespace and a spec that fails to load stop the start.
  `--spec` works exactly as before. See [Several APIs](docs/configuration.md#several-apis).

- **The call log says why a response was refused (#24).** With `--log json`, a response that
  does not match the operation's output schema adds a `mismatch` record to its log line: the
  category, the failing keyword, the location in the response data
  (`/owner/email`, `/items/*/id`) and, for a type failure, the expected and observed JSON
  types. The location comes from the spec's property names only, never from the response:
  added keys, indexes and values never appear, a path is never cut, and one that contains a
  configured secret is left out. Clients see no difference, and without `--log json` nothing is
  computed; measured on 100 KiB and 1 MiB responses, the time per call stays within noise.

### Changed

- **`--tool-mode auto` also decides by the size of the tool definitions (#61).** At or below 64
  operations, `auto` now picks `discover` when the definitions a model sees (name, description
  and input schema) take more than 40,000 bytes. Measured over 194 public specs, a median
  definition takes 646 bytes, so 64 operations take about 40 KB; 20 of 278 configurations with
  at most 64 operations took more, up to 439 KB. Above 64 operations nothing changes. `serve`
  prints which rule picked `discover`; `--tool-mode per-operation` keeps one tool per operation.
- **Open objects are listed as `additionalProperties: true` (#70).** Input and output schemas
  wrote an object that allows undeclared properties as `additionalProperties: {}`, which the MCP
  Inspector's `--strict` check reports as a schema that accepts anything by accident. Both mean
  the same; validation is unchanged.

## [0.5.0] - 2026-10-26

### BREAKING

- **Filter patterns name their selector, and match regardless of case (#42).** `--allow`,
  `--deny` and `--omit-output-schema` take `method:`, `path:`, `route:`, `operationId:`,
  `name:` or `tag:`. A bare word used to be an operationId glob, so `--allow "post*" --deny
  "delete*"` exposed a `DELETE` named `postsDelete`, and `DeleteOrder` slipped past
  `delete*`. A pattern without a selector is now a usage error that names the replacement:

  | Before | Now |
  |---|---|
  | `--deny "DELETE /**"` | `--deny "method:delete"` |
  | `--allow "GET /orders/**"` | `--allow "route:GET /orders/**"` |
  | `--allow "**"` | `--allow "operationId:*"`, or `--allow "path:/**"` to include operations without an operationId |
  | `--allow "read*"` | `--allow "operationId:read*"`, or `--allow "method:get"` |
  | `--allow "tag:Orders"` | unchanged |

  In an operationId, tool name or tag, `*` now matches any characters, `/` included. A pattern
  that matches values differing only by case is reported, and is an error under
  `--strict-filters`. See [`docs/filtering.md`](docs/filtering.md).

- **Redirects are authorized like the request itself (#40).** A redirect that leaves the API
  base URL (another origin, or outside the base path) is no longer followed unless `serve`
  runs with the new `--allow-offsite-redirects`. A redirect to a path on the API that matches
  no operation of the spec is not followed either. A client that relied on such redirects,
  for example a download link to a storage host, needs the flag.

- **`describe_operation` leaves out the `outputSchema` by default (#9).** Output schemas are
  most of an operation's definition (79% of the `per-operation` `tools/list` for the GitHub
  REST description), and calling an operation needs only its `inputSchema`; the server still
  validates every result against the output schema. A describe result without it carries
  `outputSchemaOmitted: true`. Pass `include_output_schema: true` to get it. Operations that
  accept `_fields` (`--response-projection`) list their result fields instead, as
  `outputFields` with `<pointer>: <type>` lines (#49): 12 to 20 KB per GitHub describe
  response instead of 44 to 154 KB. A client that relied on `outputSchema` in every describe
  result must now ask for it.

### Added

- **`--no-output-schema-descriptions` (#49).** Output schemas are shown without their
  `description` keywords, which are about half their size: the GitHub `tools/list` above
  shrinks by 39%. Off by default, since the model then no longer sees what a result field
  means. Validation is unchanged.
- **Uploads by file name (#29).** With `serve --uploads`, a binary request field (a
  multipart file part, an octet-stream or an image body) also takes `{"file": "<name>"}`.
  The server reads that file from `~/.kaisers-io/openapi-mcp/uploads/<api>/` and sends its
  bytes. A call costs a few tokens for the name instead of the whole file as base64.
  - The folder is the same on every platform, owner-only, and files in it older than
    24 hours are removed at startup.
  - Names are plain, the folder is flat, and links and hard links are refused, also on
    Windows.
  - An image field only takes a file of its declared type.
- **Raw image request bodies (#29).** An operation whose body is `image/png`, `image/jpeg`,
  `image/gif` or `image/webp` is now a tool, with the body as one base64 argument, like
  `application/octet-stream`. Before, it was omitted.
- **Image responses (#14).** `--image-responses inline|file` returns an upstream PNG, JPEG,
  GIF or WebP image instead of a tool error:
  - `inline` returns it as an MCP image;
  - `file` saves it under `~/.kaisers-io/openapi-mcp/images/<api>/` and returns only its
    path, about 30 tokens instead of about 1,300 for a 1000×1000 image;
  - `--image-dir-max-bytes` (default `100MB`) caps the folder, and the oldest saved images
    go first.
  The default, `off`, keeps the tool error.
- **`docs/filtering.md` (#42)** explains every selector, the order in which an operation is
  exposed or excluded, what is reported where, recipes such as "never delete" and their limits,
  and overlapping paths. Its examples run as tests.
- **`name:` selector (#42)** matches the tool name the agent sees, also for operations without
  an operationId.

- **`--allow-offsite-redirects` on `serve` (#40)** follows a redirect off the API base URL.
  The egress policy still applies, and a later hop back onto the API is authorized again.

- **`--omit-output-schema <pattern>` on `serve` and `tools` (#13).** For an API whose
  responses do not match its own spec, every call to the tool used to fail with "did not match
  the tool's declared output schema". The matching exposed tools now declare no output schema,
  so their results are returned as text, as for a tool whose responses cannot be described.
  The secret scan, size limits and request validation stay. The flag is repeatable and uses
  the `--allow`/`--deny` pattern syntax; a pattern that matches no exposed tool is a dead
  pattern (an error under `--strict-filters`); when it names an operation that is filtered
  out or omitted, the warning says so instead of suggesting another tool. A pattern that
  matches only tools without an output schema gets a warning that it changes nothing.
  Startup names the affected tools, and `tools` marks them (`[output schema omitted]`,
  `outputSchemaOptedOut: true`). It is named
  `--omit-output-schema` rather than `--no-output-schema` because the CLI would read the
  latter as negating `serve --output-schema`.
- **Sequential media types (#33).** JSON Lines (`application/jsonl`), NDJSON
  (`application/x-ndjson`), JSON text sequences (`application/json-seq`, RFC 7464) and
  Server-Sent Events (`text/event-stream`) are read as the array of their items, as OpenAPI
  3.2 defines it. In a 3.2 spec, a response becomes structured data validated by `itemSchema`
  per item and `schema` for the whole array, and a request body in one of these types becomes
  one array argument written in the media type's framing. In 3.0 and 3.1 specs, such a
  response is returned as text; before, a JSON Lines response was a tool error ("unsupported
  media type"). A malformed sequence fails closed, and a secret escaped inside an item is
  found like in a JSON body.
- **OpenAPI 3.2 `oauth2MetadataUrl` (#33).** The credential hint of an oauth2 scheme shows
  the authorization server metadata URL (RFC 8414). It is never fetched: the flows already
  name the token endpoint, and fetching it would add a request to a spec-chosen URL.
- **OpenAPI 3.2 `additionalOperations` (#33).** An operation for another HTTP method, such as
  `LINK` or `COPY`, becomes a tool instead of being omitted, and its request is sent with the
  method exactly as declared. Its semantics are unknown, so it is treated like `POST`: the
  read-only default does not expose it, its annotations are destructive, `--retries` never
  repeats it, and a redirect other than `303` is a tool error. A `METHOD /path` filter pattern
  may name it; a non-standard method that no operation declares is still a startup error, so a
  misspelled method does not silently match nothing. A method that is not upper case,
  `CONNECT`, `TRACK`, or a name that has its own Path Item field is omitted with a reason.
  Without an operationId, a punctuation-only method on a path without letters (`! /`) is named
  `operation_<hash>`, so its tool name is never empty.
- **OpenAPI 3.2 `querystring` parameters (#33).** A parameter `in: querystring` whose
  `content` is `application/x-www-form-urlencoded` over an object of scalar values becomes one
  tool argument, and its entries are form-encoded into the query string. Other media types or
  shapes, an Encoding Object, a second `querystring` (for example one on the path item and one
  on the operation), and a `querystring` next to `query` parameters still omit the operation
  with a reason.
- **OpenAPI 3.2 `QUERY` operations (#33).** A 3.2 `query` operation (RFC 10008: a safe,
  idempotent read with a request body) becomes a read-only tool instead of being omitted. The
  read-only default exposes it, its annotations are read-only, `--retries` applies, and the
  body is sent with the `QUERY` method (an omitted optional form body as the empty form, with
  its `Content-Type`). A `303` redirect is followed as a `GET`; any other
  redirect is a tool error, because it would repeat the query without its body.
- **OpenAPI 3.2 (#33).** 3.2.x specs are validated against the official 3.2 schema and served
  like 3.1 ones: JSON Schema 2020-12 dialect, `$ref` siblings, `components.mediaTypes`
  references, and the `deviceAuthorization` OAuth flow in the credential hints. A security
  scheme the spec marks `deprecated` says so in the hint. An operation that cannot be mapped
  to a tool is omitted on its own with a reason, so the rest of the spec is served. A cyclic
  `components.mediaTypes` reference stays fail-closed: the operation is omitted for a request
  body, and the output schema is withheld for a response. Before, every 3.2 spec was refused.
  **Downgrading:** a cache entry for a 3.2 spec cannot be read by 0.4.1 or earlier, which
  reports it as unusable; run `openapi-mcp cache clear` for that entry first.
- **Guide: correcting a spec with an OpenAPI Overlay (#26).** `docs/overlays.md` shows how to
  fix one detail of a spec you cannot change, such as a property the API returns as `null`
  or an unhelpful operation description, with an Overlay 1.2 document applied by vacuum
  0.35.1. It covers OpenAPI 3.0 and 3.1, the pitfalls (empty and too broad targets, action
  order) and how to check the result before serving it. The example files in
  `docs/overlays/` are tested against the real CLI.
- **`serve --output-schema defs` (#9).** Shows each output schema with its repeated
  subschemas once under `$defs`, referenced with a local `$ref`, instead of written out in
  full every time. For the GitHub REST description (`--allow tag:repos`) `tools/list` shrinks
  by 22%. Validation is unchanged: both forms accept exactly the same values, and the
  envelope branches stay inline. In `discover` mode it applies to `describe_operation`, computed
  on demand, so startup does not grow. The default stays `inline`, since a host that does not
  resolve local `$ref`s would see an incomplete schema.
- **`--nullable-response-fields optional` (#17).** The flag now takes an optional scope.
  `optional` admits `null` only for the properties their object does not list in
  `required`, so a `null` in a required property still fails: for specs whose `required`
  means "never null", as springdoc derives it from `@NotNull`. The bare flag and `all` keep
  the 0.4.1 behaviour (every property). The documentation also names a server-side fix for
  Spring Boot, `spring.jackson.default-property-inclusion=non_null` (#19).
- **Two more schema shapes convert instead of omitting the operation (#20).** A
  `oneOf`/`anyOf` with a sibling `type` is accepted when every branch declares that type or
  none: the type then applies to each branch, as JSON Schema defines it. An `anyOf` whose
  branches only list `required` keys beside the object's `properties` ("send at least one of
  these") is enforced on the tool input and advertised unchanged. With the GitHub REST
  description, 16 of the 28 operations omitted before are now served, among them the
  rulesets, Actions policies, the Dependabot, code scanning and secret scanning alert
  updates, and requesting pull request reviewers. Shapes that cannot be represented exactly stay omitted: a branch of
  another type, a `nullable` or non-object root, a key that is not a declared property, or a
  `readOnly`/`writeOnly` key.

### Changed

- **Documented: less memory for large specs (#59).** `NODE_OPTIONS=--max-semi-space-size=8`
  lowers peak memory for the GitHub REST description from 297 to 189 MB (`discover`) with
  latency unchanged. The server does not set it itself, because restarting with the flag costs
  30 to 70 ms on every start; see [`docs/configuration.md`](docs/configuration.md).
- **Fewer tokens per session and per call (#49).** Measured with the GitHub REST description
  (`--allow tag:repos`, 201 tools) and DigitalOcean (265 tools); the name, description and
  input schema of every tool shrink by 7.6% and 12.9% for a client on MCP 2025-11-25, and by
  4.8% and 8.3% for an older one. Every parameter, required field and parameter description
  is unchanged.
  - A documented error that only restates its status (`401: Unauthorized`, `404: The
    resource was not found.`, `500: Server error.`) is left out of the tool description.
    Specific ones such as `422: Validation failed` stay.
  - A markdown link in a description keeps its text and drops the URL. A description with
    any code (a backtick or a `~~~` fence) is left whole, since there the link syntax can
    be the request format.
  - Listed schemas leave out `$schema` when the negotiated MCP revision makes JSON Schema
    2020-12 the default (2025-11-25 and later). The `data` part of an output schema never
    carries it, since 2020-12 allows it only at a resource root.
  - An upstream error body that is not JSON (an HTML error page) is shown up to 1 KB instead
    of 8 KB. JSON error bodies keep the full 8 KB.
  - An argument error names the unknown keys (`(root): unrecognized_keys per_page`) and the
    expected type (`id: invalid_type (expected string)`). Only the caller's own key names,
    capped and sanitized, and a type from a fixed list; never a value.
  - Every truncated result says that it was cut. Only a `GET`, `HEAD` or `QUERY` is told to
    call again with `_fields`; a write was told so before, which could apply it twice.
- **Large results return faster (#48).** The text preview of a schema-validated result is
  built from only as much of the result as fits in it, instead of serializing all of it. A
  1 MB result takes about 13% less time per call. The preview is byte-identical.
- **`--tool-mode discover` starts faster (#47).** An operation's output schema and
  description are now built on its first `describe_operation` or `call_operation`, not at
  startup. For the GitHub REST description (1,241 operations), `initialize` answers in about
  490 ms instead of 815 ms, and peak memory drops from 343 to 315 MB. The definitions and the
  validation are unchanged. An output schema that cannot be built now fails that operation's
  calls with a tool error, and nothing is sent. `--omit-output-schema` still builds every
  output schema at startup.
- **Clearer error for Swagger 2.0 specs (#11).** A YAML Swagger 2.0 spec that writes its
  version unquoted (`swagger: 2.0`) now gets the Swagger error instead of the generic version
  error.
- **Faster `serve` startup for large specs (#6, #7, #8).** Output validators are compiled
  without Ajv's code-optimization pass, which only shrinks the generated code and took most of
  the compile time; operations with identical output schemas now share one validator; and in
  `--tool-mode discover` an operation's validator is compiled on its first call instead of at
  startup. For the GitHub REST description, time until `initialize` answered dropped from
  about 27 s to about 2 s in `discover` mode (`--allow '**'`) and from about 3.8 s to about
  1.7 s with `--allow tag:repos` (one development machine, warm spec cache). Validation results
  are unchanged; a single validation can take up to about 1 µs longer. In `discover` mode, an
  output schema that cannot be compiled no longer stops `serve` at startup: calls to that
  operation fail with a tool error before anything is sent, and `serve` names the operation
  once on stderr. `per-operation` mode still compiles every validator at startup.

### Fixed

- **A short secret could appear JSON-escaped in a text error body (#46).** A secret shorter than
  8 characters was redacted only as its raw value. One containing `"`, `\` or a control
  character, embedded in a JSON snippet of a text/plain or HTML error page, appeared escaped
  and was not redacted. Its JSON-escaped forms are now redacted too, for every length.
- **A failed write could read like a safe retry (#25).** A tool error after the request had
  reached the upstream did not always say so. This applied to a timeout, a lost connection,
  an oversized response, a redirect of a write, a `5xx`, and a `2xx` whose result did not
  match its schema or was not valid JSON. An agent could repeat a write that had already been
  applied. Every tool error of an API call now carries `_meta["openapi-mcp/effect"]`
  (`not_sent`, `upstream_rejected`, `upstream_reported_success` or `outcome_unknown`). For a
  write that may have been applied, the text warns not to retry it blindly. Reads are unchanged.
  A failure on the first hop before the request was written (a failed DNS lookup, a refused
  connection, a TLS error, a timeout or a cancel while connecting) is `not_sent` (#53).
- **Every operation that is not a tool is reported, with its reason (#41).** Operations left
  out by `--allow`, `--deny` or the read-only default had no record at all, and an operation
  without an `operationId` disappeared under `--allow '**'` without a trace. `tools --json`
  now lists every operation that is not a tool under `notExposed`, with its decision and
  reason; `tools` and `serve` print one summary line, and `openapi_mcp_status` reports the
  counts under `notExposedCounts`. `omitted` keeps its shape.
- **A tool that request authorization refuses for some URLs is named at startup (#41).**
  When an exposed template and one that is not exposed can match the same URL
  (`/orders/{orderId}/items` and `/orders/{orderId}/{section}`), those calls are refused,
  because an upstream that routes in declaration order could reach the excluded one. That
  stays, but startup now names the pair (an error under `--strict-filters`), `tools --json`
  lists it under `overlaps`, and the tool error no longer blames the arguments.
- **Dead patterns that name an omitted operation (#41).** A pattern that names an operation
  omitted as not supported, by operationId or tag, got a "closest" suggestion for a different
  operation; it now says the operation is not supported. A `METHOD /path` pattern may name a
  method only an omitted operation declares (an OpenAPI 3.2 `SEARCH` with a `servers`
  override), which used to stop the start.
- **The tool limit counts the tools that are served (#41).** It was checked before
  operations a pending candidate removed were withheld, so a start could be refused for
  tools the server would never expose.
- **An exposed tool could reach an operation the filters exclude (#40).** The request was
  built from the tool's own path template, but its arguments or an upstream redirect could
  turn it into another operation: `getItem` with `id: "export"` sent `GET /items/export`
  under `--deny "GET /items/export"`, and an allowed `GET /safe` followed a `302` to an
  excluded `GET /denied`. Every hop is now resolved against every operation of the spec
  before it is sent. Hop 0 must be the tool's own operation, and a redirect must reach an
  exposed one; otherwise the call fails without retrying. A method-level deny such as
  `--deny "DELETE /**"` was not affected.
- **Operations declared next to a Path Item `$ref` were lost (#40).** `/orders: {$ref: ...,
  post: ...}` kept only the referenced operations, without any report. Fields from both
  sides are now merged; an operation, `parameters` or `servers` declared on both sides omits
  the affected operations with a reason, and so does a `$ref` chain that is too deep or does
  not resolve. A pending candidate no longer reads such operations as removed.
- **A spec path with a control character could route a request elsewhere (#40).** URL
  parsing drops tab and newline, so a static segment `.<TAB>.` became `..`. Such operations
  are now omitted with a reason.

- **`_fields` on a sequential response of a tool without an output schema.** The body was
  parsed as one JSON value, so a JSON Lines or NDJSON body with several records failed with
  "projection requires a JSON response", and a single record was projected as an object
  (`{"/*/id":null}` instead of `[1]`). It is now read as the array of its items, as on the
  structured path, and a malformed sequence fails closed. This affected 3.0 and 3.1 specs
  that declare a sequential response next to a JSON one, and tools opted out with
  `--omit-output-schema`.

- **A call waiting for an OAuth2 access token now honours its own cancellation and deadline
  (#21).** Before, a call cancelled while the shared token request was still running kept
  its concurrency slot until the token arrived, and the wait for a first or refreshed token
  could outlast the call's `--request-timeout`. Now each waiting call ends at once when it is
  cancelled or its budget runs out, frees its slot and sends nothing more, while the token
  request keeps serving the other callers. A `401` replay is no longer sent once the budget
  is spent. Every exit after a sent request keeps the idempotency key in the result, and its
  text says the request was not sent again rather than that nothing was sent; a refresh
  token error after a `401` also keeps the key now.

## [0.4.1] - 2026-10-23

### Added

- **`--nullable-response-fields` on `serve` and `tools` (#3).** Some generators (springdoc,
  for one) leave `nullable` out unless a field is annotated, while the server serializes
  unset fields as `null`; one such `null` failed the whole tool call with "upstream response
  for status 200 did not match the tool's declared output schema". With the flag, every value
  under an object's `properties` in a derived output schema also admits `null`, at every
  depth, through `$ref`s and composition members, `required` properties included. Unchanged:
  `required` (the key must still be present), array items, `additionalProperties` values, the
  root `data` value, request schemas and the envelope fields. Discover mode (`call_operation`)
  applies it too. The flag only relaxes validation: the upstream data, nulls included, is
  returned unchanged. Off by default; without it the output schemas and `tools/list` are
  byte-identical to 0.4.0. `tools --json` reports the widened tools with
  `outputSchemaAdmitsNullFields: true`.

## [0.4.0] - 2026-10-23

### BREAKING

- **Generated tool names change for some specs (kaisers-io/openapi-mcp-archive#67).** Tool
  names now use only `[A-Za-z0-9_-]`, the charset that OpenAI and Anthropic tool-calling
  APIs accept, and non-ASCII letters are transliterated. Hosts that store per-tool
  permissions or allowlists by tool name will see the affected tools as new tools and must
  approve them again. Affected:
  - operationIds containing `.` (`repos.get` becomes `repos_get`);
  - operationIds with invalid characters at either end (`list-pets!` becomes `list-pets`,
    formerly `list-pets_`), and runs of invalid characters, which collapse into one `_`;
  - non-ASCII operationIds. Accented letters keep their base letter (`Ünïcödé` becomes
    `Unicode`). `ß ø ł æ œ đ þ` (and uppercase forms) become `ss o l ae oe d th`.
    Operation IDs without any ASCII letter or digit left (e.g. CJK) fall back to the
    method+path name;
  - operations without an operationId whose path mixes a placeholder with text in one
    segment (`GET /users/{id}.json` becomes `get_users_by_id_json`, formerly
    `get_users__id_.json`);
  - collisions. When a sanitized or method+path name lands on an operationId that is
    already a valid tool name as written, the operationId keeps its name and only the
    other entry gets the hash suffix (formerly both were suffixed).

  `--allow` and `--deny` are not affected: they match the raw operationId and path, not
  the generated tool name.

### Changed

- **Windows is supported natively (kaisers-io/openapi-mcp-archive#158).** The package's `os`
  field and the bin stub now accept `win32` next to `darwin` and `linux`; Windows users are
  no longer sent to WSL. Three Windows differences, each measured on `windows-latest`, are
  handled: `--spec` takes absolute drive paths (`C:\specs\api.json`, `C:/specs/api.json`)
  and UNC paths instead of refusing them as URL scheme `c:`; the cache treats the `EPERM`
  that Windows returns for every directory fsync as "no directory barrier" (only on win32);
  and replacing `meta.json` while another process reads it retries `EPERM`/`EACCES`/`EBUSY`
  for at most 2 s before failing as before. On Windows the cache's trust basis is the user
  profile's ACL instead of `0700`/`0600` modes (see
  [docs/security.md](docs/security.md#windows)). The README shows the `cmd /c npx` form for
  MCP hosts that start servers without a shell. Linux and macOS behave exactly as before. A
  `windows-latest` CI job runs the test suite on main and on every pull request.
- **Node.js 22 is supported: `^22.19.0 || >=24.11.0`.** The published packages, the
  bin stub's version guard and the docs now accept Node 22.19+ (22.x is maintenance LTS
  until April 2027) next to 24.11+. 22.19.0 is the bundled undici's own floor; older 22.x
  releases crash at load. 23.x and 24.0–24.10 stay refused. CI tests both line floors, and
  the typecheck now uses the Node 22 library and `@types/node` 22, so code that needs a
  Node-24-only API (such as `Promise.try` or `Error.isError`) fails the typecheck.

- **Request bodies with `minProperties`/`maxProperties` are now a single `body` field
  (kaisers-io/openapi-mcp-archive#71).** These operations used to be omitted. They are now
  generated, and the body is not flattened into top-level fields, so the property-count
  constraint can be enforced. The common case is a PATCH body with `minProperties: 1`: its
  tool takes `{ "body": { … } }` instead of flattened fields. The change is visible in
  `tools/list`.

- **Upstream connections are reused (kaisers-io/openapi-mcp-archive#51).** Tool calls share
  a bounded pool of pinned keep-alive connections per origin and trust policy instead of
  opening a new TCP/TLS connection per call. DNS is still validated for every new socket; an
  idle connection is closed after 30 s and every pooled agent is re-resolved after 5 min.

- **Parallel tool calls queue instead of failing (kaisers-io/openapi-mcp-archive#64).** A
  call past `--max-concurrency` (new flag, default `16`) waits in a bounded FIFO queue (4 ×
  the limit). The queue wait and the upstream request share one time budget: the wait takes
  at most half of it. A refused call (`overloaded`, or over the new `--rate-limit`, default
  `120/1m`) is a tool error whose `_meta` carries `openapi-mcp/error` and
  `openapi-mcp/retryAfterMs`.

- **New `--request-timeout` for upstream API calls (kaisers-io/openapi-mcp-archive#68).**
  `--timeout` no longer applies to API calls; it covers the spec fetch (and, with
  `--http-auth oauth`, the metadata and JWKS fetches). **Upgrading:** if you raised
  `--timeout` to make slow API calls work, set `--request-timeout` instead (default `30s`); it
  is the per-call budget, queue wait included.
- **HTTP client fixes (kaisers-io/openapi-mcp-archive#68).** `Accept` is derived from the
  operation's declared 2xx media types (a spec `Accept` header parameter is ignored, per
  OpenAPI; `--header Accept:` overrides). A redirect that stays on the trusted `--base-url`
  origin keeps its trust. A 303 after a write is followed as a GET without a body. An
  unfollowed 3xx is a tool error, not a success.

- **Large structured results are scanned once and their text copy is capped
  (kaisers-io/openapi-mcp-archive#62).** For a tool with an output schema, `content[0].text`
  is now an 8 KB serialization with a `…[truncated]` marker; `structuredContent` still
  carries the complete data. A host that forwards only `content[]` to the model sees the
  first 8 KB, as it already did for unstructured results.

- **Selected upstream response headers reach the tool result
  (kaisers-io/openapi-mcp-archive#73).** `Location` (same-origin, as a path), `ETag`,
  `Last-Modified`, `Retry-After`, `X-Total-Count` and rate-limit headers appear under an
  optional `headers` property of the structured result, or as a trailing `headers:` block of
  a text result. A header whose name or value contains a registered secret is dropped. On a
  429/503, `Retry-After` is reported as `_meta["openapi-mcp/upstreamRetryAfterMs"]`.

- **Next-page hints for paginated tools (kaisers-io/openapi-mcp-archive#61).** A `GET` with
  a page or cursor parameter (`cursor`, `page_token`, `after`, `starting_after`, `page`) or
  a declared `Link` header returns `pagination.next`: the arguments for the next call (never
  a URL), decoded to the tool's own parameter types, or `null` when no next page is known
  (not proof that the data is exhausted). Its output schema gains an optional `pagination`
  property.

- **Next-page hints for JSON:API and `deepObject`/delimited query parameters
  (kaisers-io/openapi-mcp-archive#145).** A JSON:API response (`application/vnd.api+json`,
  or a schema declaring `links.next`) now gets `pagination.next` from its body `links.next`,
  under the same rules as a `Link` header (same origin and path, every parameter maps, the
  tool's input schema accepts it); a `Link` header still wins when both are sent. Next URLs
  using `page[number]=2&page[size]=10`, `page[after]=…` or `filter[status]=x` map back onto
  the tool's `deepObject` parameters (declared keys only), and space- or pipe-delimited
  array values are split on their delimiter. Before, all of these gave `next: null`.
  Anything ambiguous (an undeclared or nested key, a repeated key, a name that is both a
  literal parameter and a `deepObject` key) still gives `null`.

- **Opt-in retries for retry-safe requests (kaisers-io/openapi-mcp-archive#82).**
  `--retries <n>` (0–3, default `0`) retries 429/502/503/504 and connection errors before
  any response for GET, HEAD, PUT and DELETE (DELETE not after a connection error), and for
  POST/PATCH only when the operation declares an `Idempotency-Key` header. The key used is
  returned as `_meta["openapi-mcp/idempotencyKey"]`. Retries stay within
  `--request-timeout`.

- **MCP protocol polish (kaisers-io/openapi-mcp-archive#77).** Tools carry a `title` from
  the operation summary, and `tools/list` is sorted by name after the status tool (the order
  changes once for specs not already alphabetical). A call with `_meta.progressToken` gets
  progress notifications. `tools/list` is not paged unless `--tools-page-size <n>` is set;
  set it only for hosts that follow `nextCursor`.
- **Trace propagation is on by default (kaisers-io/openapi-mcp-archive#77).** A valid W3C
  `traceparent`/`tracestate` from a `tools/call`'s `_meta` (also through `call_operation`)
  is sent to the upstream on same-origin hops. For third-party APIs you do not operate, pass
  `--no-trace-propagation`.

- **Opt-in call log and call counters (kaisers-io/openapi-mcp-archive#78).** `--log json`
  writes one JSON line per tool call to stderr (never arguments, header values or bodies).
  `openapi_mcp_status` reports process-local counters under `calls` (visible to every client
  of the server). Outcomes include `secret_withheld` and `refused`.
- **A result withheld for containing a registered secret now says what happened
  (kaisers-io/openapi-mcp-archive#78).** When the upstream call succeeded, the message says
  so and warns not to retry blindly, instead of "tool execution result could not be returned
  safely".
- **`openapi_mcp_status` returns `cacheLock`** when start-up could not record the spec
  revalidation (kaisers-io/openapi-mcp-archive#65); it was declared in the output schema but
  missing from the result.

- **Opt-in response projection (kaisers-io/openapi-mcp-archive#44).** With
  `serve --response-projection`, tools with a JSON response accept an optional `_fields`
  argument (up to 32 JSON Pointers, `*` maps over an array; also through `call_operation`)
  and return only the selected values under `projection`. Off by default because it grows
  `tools/list` by about 30%.

- **JWT access-token verifier in core (kaisers-io/openapi-mcp-archive#70).** `verifyJwt` and
  `parseJwks` check an RFC 9068 access token against a kid-indexed JWKS: asymmetric
  algorithms only (RS/PS/ES/EdDSA), `kid` required, canonical base64url, exact `iss`, `aud`
  bound to the resource URI, `exp` required, 60 s clock skew. Library only; the HTTP
  resource-server wiring follows.

- **OAuth resource-server mode for `--http` (kaisers-io/openapi-mcp-archive#70).**
  `--http-auth oauth` with `--oauth-issuer`, `--oauth-audience` and optional
  `--oauth-required-scope` validates JWT access tokens locally against the issuer's JWKS,
  serves RFC 9728 Protected Resource Metadata and answers with `401`/`403` challenges. Every
  MCP request is checked at the transport, `call_operation` included. Only this mode may
  bind a non-loopback `--http-host` (with an `https` audience). The JWKS is refreshed
  stale-while-revalidate, at most once per 30 s; a failed refresh keeps the last good set
  for up to an hour, an empty set revokes every key. Static `--http-token-env` stays the
  default.

- **Security-scheme hints (kaisers-io/openapi-mcp-archive#55).** `tools` prints one `auth:`
  line per `securitySchemes` entry an exposed operation references, naming the flag that
  supplies it (`tools --json`: `data.security`), and `serve` warns at startup when no
  configured header satisfies an exposed operation's `security` requirement (alternatives
  joined with `OR`, schemes needed together with `AND`). Query-string API keys,
  challenge/response `http` schemes and mutual TLS are reported as unsupported. Requests are
  built as before.

- **Upstream OAuth2 client credentials (kaisers-io/openapi-mcp-archive#55).** `serve` can
  obtain the upstream API's access token itself: `--upstream-oauth-client-id-env` and
  `--upstream-oauth-client-secret-env` (plus optional `--upstream-oauth-scheme`,
  `--upstream-oauth-scope`, `--upstream-oauth-token-url`, `--upstream-oauth-client-auth`)
  run the client-credentials grant against the spec's `tokenUrl` through the same egress
  policy as API calls. Tokens are cached in memory, refreshed before expiry and registered
  with the redactor as they are issued; the token request is bounded by `--request-timeout`.
  An upstream `401` replays the request once with a fresh token; that replay is separate from
  `--retries`. A call whose token could not be obtained is logged with the new outcome
  `token_error`.

### Documentation

- **READMEs match the current CLI.** The host examples no longer pass `--allow "read*"` (an
  operationId glob that is not "read operations" and matches nothing on many specs); they keep
  the read-only default. The READMEs now describe tool naming, the egress policy, trace
  propagation being on by default, the newer serve options, the compile cache and the exit
  codes, and list the `--header` deny-list as the code enforces it. The npm README no longer
  links to the source repository. `serve --help` now describes `--allow-private-network` as
  also covering API requests, and `--http-host` as accepted only with `--http-auth oauth`.

### Performance

- **Faster starts after the first run, slower first run
  (kaisers-io/openapi-mcp-archive#76).** The OpenAPI meta-schema validators are precompiled,
  and the CLI now enables Node's V8 compile cache in
  `~/.kaisers-io/openapi-mcp/compile-cache/` (created `0700`). Every later start is faster,
  e.g. `--version` 220 → 149 ms and `tools --spec petstore.json` 413 → 199 ms. The **first**
  run per user writes the cache and is slower (`--version` about 191 → 237 ms). MCP hosts
  that start the server in a fresh container or CI job, with no persistent home directory,
  pay that first-run cost on every start. `NODE_DISABLE_COMPILE_CACHE=1` turns the cache
  off.

- **An unchanged spec is not parsed again (kaisers-io/openapi-mcp-archive#76).** A local spec
  file is still read and hashed on every start. While its bytes match the accepted baseline,
  the server now uses the cached, already validated document instead of parsing and
  validating the file again. The same applies to a URL that answers `200` with identical
  bytes. The DigitalOcean spec (1.6 MB YAML) as a local file starts in 508 ms instead of
  1,204 ms from the second start on, with 131 MB peak RSS instead of 247 MB. The tools are
  still generated on every start, so every flag takes effect immediately. A validation rule
  added by a newer release is not applied to an unchanged file until the file changes (or
  `openapi-mcp cache clear`); before, such a file was served as the last known good baseline
  with a warning.

### Development

- **Every pull request is tested on Linux, macOS and Windows.** The `check` matrix runs on macOS
  as well as Ubuntu, the Windows test job runs without an opt-in label, and the smoke test of the
  packed and globally installed CLI runs on all three platforms, which exercises npm's `.cmd` shim
  on Windows. CI no longer restores a pnpm dependency cache: a fresh install takes seconds, and a
  failed cache restore had stalled macOS jobs for about ten minutes.
- **The release workflow refuses more mistakes and needs an approval outside the tagged tree.**
  `verify` refuses a tag whose version is not strictly newer than the version npm serves as
  `latest`, refuses prerelease versions, and stops when the registry lookup fails (only a
  "not found" answer counts as a first publication). `publish` runs in the `npm-publish`
  GitHub Environment, refuses to run unless the repository is public, and publishes with
  `--provenance` instead of relying on npm's automatic attestation, which is skipped without
  an error from a private repository. A new `announce` job creates the GitHub release from
  the version's changelog section, refuses an empty one, and marks it Latest only when it is
  newer than the current Latest release. `CONTRIBUTING.md` ("Releasing")
  lists the two settings outside the repository that the release depends on: the
  environment's required reviewer and the npm Trusted Publisher entry that names it.
- **Security policy, contribution guide and templates for the public repository.**
  `SECURITY.md` asks for private vulnerability reports through GitHub's advisory form and
  lists what is in and out of scope; `CONTRIBUTING.md` takes over the README's Development,
  Releasing and Benchmarks sections (now naming the post-GC live heap, not peak RSS, as the
  gated memory metric) and describes what CI runs and what fails review; `CODE_OF_CONDUCT.md`
  adopts the Contributor Covenant 2.1; issue and pull request templates ask for the details a
  report needs and the checks a change needs. The npm package now ships this changelog
  (`packages/cli/CHANGELOG.md`, a byte-identical copy: `pnpm versions --set` rewrites both
  copies and `pnpm versions --check` fails when they differ) and declares `keywords`,
  `homepage` and `bugs`.
- **A version bump is one command: `pnpm versions --set <version>`.** It writes the version to
  `packages/cli/package.json`, every `@kaisers-io/openapi-mcp@<version>` pin in the READMEs and
  `docs/`, and the `--json doctor` example, and turns `## [Unreleased]` into
  `## [<version>] - <date>` under a fresh `## [Unreleased]`. It refuses a version that is not
  newer than the current one, and writes nothing if any file cannot be updated. `pnpm versions --check` fails on any site that differs from
  `packages/cli/package.json`, and on a pin that is not an exact version (`latest`, `^1.2.3`).
  It runs in a new `versions` CI job and in the release workflow, which also requires a
  changelog heading for the tagged version. It replaces `test/readme-pins.test.ts`
  (kaisers-io/openapi-mcp-archive#158). This changelog now follows Keep a Changelog. The
  release steps, including the Windows smoke test of the published tarball, are in
  `CONTRIBUTING.md` under "Releasing".
- **The benchmark gate checks retained memory, not peak RSS.** Peak RSS of a `serve` start
  depends on when V8 grows its young generation and collects old space. For the same build,
  flat-500's warm peak alternated between modes about 70 MB apart, which failed the gate on
  a docs-only pull request. The harness now preloads a small probe into every measured
  process, which reports the heap still in use after a full garbage collection. That value
  is gated (`liveHeapMB`, `warmLiveHeapMB`); peak RSS is still reported, but no longer fails
  the gate.
- **Issue references name the earlier tracker.** Every issue and pull request reference in code
  comments, test names, scripts, workflows and this changelog now reads
  `kaisers-io/openapi-mcp-archive#N`, so it stays unambiguous once this repository numbers its
  own issues from one again; `CONTRIBUTING.md` explains the form. Internal design-decision
  labels are gone from comments and test names; the explanations they tagged stay. No
  behaviour, tool text or `tools/list` output changes.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING

- **Generated tool names change for some specs (#67).** Tool names now use only
  `[A-Za-z0-9_-]`, the charset that OpenAI and Anthropic tool-calling APIs accept, and
  non-ASCII letters are transliterated. Hosts that store per-tool permissions or allowlists
  by tool name will see the affected tools as new tools and must approve them again.
  Affected:
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

- **Windows is supported natively (#158).** The package's `os` field and the bin stub now
  accept `win32` next to `darwin` and `linux`; Windows users are no longer sent to WSL.
  Three Windows differences, each measured on `windows-latest`, are handled: `--spec` takes
  absolute drive paths (`C:\specs\api.json`, `C:/specs/api.json`) and UNC paths instead of
  refusing them as URL scheme `c:`; the cache treats the `EPERM` that Windows returns for
  every directory fsync as "no directory barrier" (only on win32); and replacing
  `meta.json` while another process reads it retries `EPERM`/`EACCES`/`EBUSY` for at most
  2 s before failing as before. On Windows the cache's trust basis is the user profile's
  ACL instead of `0700`/`0600` modes (see [docs/security.md](docs/security.md#windows)).
  The README shows the `cmd /c npx` form for MCP hosts that start servers without a
  shell. Linux and macOS behave exactly as before. A `windows-latest` CI job runs the
  test suite on main and on PRs labelled `ci:windows`.
- **Node.js 22 is supported: `^22.19.0 || >=24.11.0`.** The published packages, the
  bin stub's version guard and the docs now accept Node 22.19+ (22.x is maintenance LTS
  until April 2027) next to 24.11+. 22.19.0 is the bundled undici's own floor; older 22.x
  releases crash at load. 23.x and 24.0–24.10 stay refused. CI tests both line floors, and
  the typecheck now uses the Node 22 library and `@types/node` 22, so code that needs a
  Node-24-only API (such as `Promise.try` or `Error.isError`) fails the typecheck.

- **Request bodies with `minProperties`/`maxProperties` are now a single `body` field (#71).**
  These operations used to be omitted. They are now generated, and the body is not flattened
  into top-level fields, so the property-count constraint can be enforced. The common case
  is a PATCH body with `minProperties: 1`: its tool takes `{ "body": { … } }` instead of
  flattened fields. The change is visible in `tools/list`.

- **Upstream connections are reused (#51).** Tool calls share a bounded pool of pinned
  keep-alive connections per origin and trust policy instead of opening a new TCP/TLS
  connection per call. DNS is still validated for every new socket; an idle connection is
  closed after 30 s and every pooled agent is re-resolved after 5 min.

- **Parallel tool calls queue instead of failing (#64).** A call past `--max-concurrency`
  (new flag, default `16`) waits in a bounded FIFO queue (4 × the limit). The queue wait
  and the upstream request share one time budget: the wait takes at most half of it. A
  refused call (`overloaded`, or over the new `--rate-limit`, default `120/1m`) is a tool
  error whose `_meta` carries `openapi-mcp/error` and `openapi-mcp/retryAfterMs`.

- **New `--request-timeout` for upstream API calls (#68).** `--timeout` no longer applies to
  API calls; it covers the spec fetch (and, with `--http-auth oauth`, the metadata and JWKS
  fetches). **Upgrading:** if you raised `--timeout` to make slow API calls work, set
  `--request-timeout` instead (default `30s`); it is the per-call budget, queue wait included.
- **HTTP client fixes (#68).** `Accept` is derived from the operation's declared 2xx media
  types (a spec `Accept` header parameter is ignored, per OpenAPI; `--header Accept:`
  overrides). A redirect that stays on the trusted `--base-url` origin keeps its trust. A
  303 after a write is followed as a GET without a body. An unfollowed 3xx is a tool error,
  not a success.

- **Large structured results are scanned once and their text copy is capped (#62).** For a
  tool with an output schema, `content[0].text` is now an 8 KB serialization with a
  `…[truncated]` marker; `structuredContent` still carries the complete data. A host that
  forwards only `content[]` to the model sees the first 8 KB, as it already did for
  unstructured results.

- **Selected upstream response headers reach the tool result (#73).** `Location` (same-origin,
  as a path), `ETag`, `Last-Modified`, `Retry-After`, `X-Total-Count` and rate-limit headers
  appear under an optional `headers` property of the structured result, or as a trailing
  `headers:` block of a text result. A header whose name or value contains a registered
  secret is dropped. On a 429/503, `Retry-After` is reported as
  `_meta["openapi-mcp/upstreamRetryAfterMs"]`.

- **Next-page hints for paginated tools (#61).** A `GET` with a page or cursor parameter
  (`cursor`, `page_token`, `after`, `starting_after`, `page`) or a declared `Link` header
  returns `pagination.next`: the arguments for the next call (never a URL), decoded to the
  tool's own parameter types, or `null` when no next page is known (not proof that the data
  is exhausted). Its output schema gains an optional `pagination` property.

- **Next-page hints for JSON:API and `deepObject`/delimited query parameters (#145).** A
  JSON:API response (`application/vnd.api+json`, or a schema declaring `links.next`) now
  gets `pagination.next` from its body `links.next`, under the same rules as a `Link`
  header (same origin and path, every parameter maps, the tool's input schema accepts it);
  a `Link` header still wins when both are sent. Next URLs using `page[number]=2&page[size]=10`,
  `page[after]=…` or `filter[status]=x` map back onto the tool's `deepObject` parameters
  (declared keys only), and space- or pipe-delimited array values are split on their
  delimiter. Before, all of these gave `next: null`. Anything ambiguous (an undeclared or
  nested key, a repeated key, a name that is both a literal parameter and a `deepObject`
  key) still gives `null`.

- **Opt-in retries for retry-safe requests (#82).** `--retries <n>` (0–3, default `0`)
  retries 429/502/503/504 and connection errors before any response for GET, HEAD, PUT and
  DELETE (DELETE not after a connection error), and for POST/PATCH only when the operation
  declares an `Idempotency-Key` header. The key used is returned as
  `_meta["openapi-mcp/idempotencyKey"]`. Retries stay within `--request-timeout`.

- **MCP protocol polish (#77).** Tools carry a `title` from the operation summary, and
  `tools/list` is sorted by name after the status tool (the order changes once for specs
  not already alphabetical). A call with `_meta.progressToken` gets progress notifications.
  `tools/list` is not paged unless `--tools-page-size <n>` is set; set it only for hosts that
  follow `nextCursor`.
- **Trace propagation is on by default (#77).** A valid W3C `traceparent`/`tracestate` from a
  `tools/call`'s `_meta` (also through `call_operation`) is sent to the upstream on
  same-origin hops. For third-party APIs you do not operate, pass `--no-trace-propagation`.

- **Opt-in call log and call counters (#78).** `--log json` writes one JSON line per tool call
  to stderr (never arguments, header values or bodies). `openapi_mcp_status` reports
  process-local counters under `calls` (visible to every client of the server). Outcomes
  include `secret_withheld` and `refused`.
- **A result withheld for containing a registered secret now says what happened (#78).** When
  the upstream call succeeded, the message says so and warns not to retry blindly, instead of
  "tool execution result could not be returned safely".
- **`openapi_mcp_status` returns `cacheLock`** when start-up could not record the spec
  revalidation (#65); it was declared in the output schema but missing from the result.

- **Opt-in response projection (#44).** With `serve --response-projection`, tools with a JSON
  response accept an optional `_fields` argument (up to 32 JSON Pointers, `*` maps over an
  array; also through `call_operation`) and return only the selected values under
  `projection`. Off by default because it grows `tools/list` by about 30%.

- **JWT access-token verifier in core (#70).** `verifyJwt` and `parseJwks` check an RFC 9068
  access token against a kid-indexed JWKS: asymmetric algorithms only (RS/PS/ES/EdDSA), `kid`
  required, canonical base64url, exact `iss`, `aud` bound to the resource URI, `exp` required,
  60 s clock skew. Library only; the HTTP resource-server wiring follows.

- **OAuth resource-server mode for `--http` (#70).** `--http-auth oauth` with `--oauth-issuer`,
  `--oauth-audience` and optional `--oauth-required-scope` validates JWT access tokens locally
  against the issuer's JWKS, serves RFC 9728 Protected Resource Metadata and answers with
  `401`/`403` challenges. Every MCP request is checked at the transport, `call_operation`
  included. Only this mode may bind a non-loopback `--http-host` (with an `https` audience).
  The JWKS is refreshed stale-while-revalidate, at most once per 30 s; a failed refresh keeps
  the last good set for up to an hour, an empty set revokes every key. Static `--http-token-env`
  stays the default.

- **Security-scheme hints (#55).** `tools` prints one `auth:` line per `securitySchemes` entry
  an exposed operation references, naming the flag that supplies it (`tools --json`:
  `data.security`), and `serve` warns at startup when no configured header satisfies an exposed
  operation's `security` requirement (alternatives joined with `OR`, schemes needed together
  with `AND`). Query-string API keys, challenge/response `http` schemes and mutual TLS are
  reported as unsupported. Requests are built as before.

- **Upstream OAuth2 client credentials (#55).** `serve` can obtain the upstream API's access
  token itself: `--upstream-oauth-client-id-env` and `--upstream-oauth-client-secret-env`
  (plus optional `--upstream-oauth-scheme`, `--upstream-oauth-scope`,
  `--upstream-oauth-token-url`, `--upstream-oauth-client-auth`) run the client-credentials
  grant against the spec's `tokenUrl` through the same egress policy as API calls. Tokens are
  cached in memory, refreshed before expiry and registered with the redactor as they are
  issued; the token request is bounded by `--request-timeout`. An upstream `401` replays the
  request once with a fresh token; that replay is separate from `--retries`. A call whose token
  could not be obtained is logged with the new outcome `token_error`.

### Documentation

- **READMEs match the current CLI.** The host examples no longer pass `--allow "read*"` (an
  operationId glob that is not "read operations" and matches nothing on many specs); they keep
  the read-only default. The READMEs now describe tool naming, the egress policy, trace
  propagation being on by default, the newer serve options, the compile cache and the exit
  codes, and list the `--header` deny-list as the code enforces it. The npm README no longer
  links to the source repository. `serve --help` now describes `--allow-private-network` as
  also covering API requests, and `--http-host` as accepted only with `--http-auth oauth`.

### Performance

- **Faster starts after the first run, slower first run (#76).** The OpenAPI meta-schema
  validators are precompiled, and the CLI now enables Node's V8 compile cache in
  `~/.kaisers-io/openapi-mcp/compile-cache/` (created `0700`). Every later start is faster,
  e.g. `--version` 220 → 149 ms and `tools --spec petstore.json` 413 → 199 ms. The **first**
  run per user writes the cache and is slower (`--version` about 191 → 237 ms). MCP hosts
  that start the server in a fresh container or CI job, with no persistent home directory,
  pay that first-run cost on every start. `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off.

- **An unchanged spec is not parsed again (#76).** A local spec file is still read and hashed
  on every start. While its bytes match the accepted baseline, the server now uses the
  cached, already validated document instead of parsing and validating the file again. The
  same applies to a URL that answers `200` with identical bytes. The DigitalOcean spec (1.6 MB
  YAML) as a local file starts in 508 ms instead of 1,204 ms from the second start on, with
  131 MB peak RSS instead of 247 MB. The tools are still generated on every start, so every
  flag takes effect immediately. A validation rule added by a newer release is not applied to
  an unchanged file until the file changes (or `openapi-mcp cache clear`); before, such a file
  was served as the last known good baseline with a warning.

### Development

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
  changelog heading for the tagged version. It replaces `test/readme-pins.test.ts` (#158).
  This changelog now follows Keep a Changelog. The release steps, including the Windows smoke
  test of the published tarball, are in `CONTRIBUTING.md` under "Releasing".
- **The benchmark gate checks retained memory, not peak RSS.** Peak RSS of a `serve` start
  depends on when V8 grows its young generation and collects old space. For the same build,
  flat-500's warm peak alternated between modes about 70 MB apart, which failed the gate on
  a docs-only pull request. The harness now preloads a small probe into every measured
  process, which reports the heap still in use after a full garbage collection. That value
  is gated (`liveHeapMB`, `warmLiveHeapMB`); peak RSS is still reported, but no longer fails
  the gate.

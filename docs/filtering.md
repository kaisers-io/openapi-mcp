# Filtering

`--allow` and `--deny` decide which operations of a spec become tools. This page explains the
pattern syntax, the order in which the server decides, what it reports, and recipes for common
goals. Read it before you expose write operations. `--omit-output-schema` and
`--omit-unsupported-parameters` use the same patterns to pick from the exposed operations.

Every pattern names what it selects, so a configuration reads as what it does:

```bash
openapi-mcp serve --spec ./shop.json \
  --allow "tag:Orders" \
  --deny "method:delete"
```

Without any `--allow`, the server exposes only reads: `GET`, `HEAD` and the OpenAPI 3.2
`QUERY` method, which is a read with a request body.

## Selectors

Every pattern starts with one selector:

| Selector | Selects | Example |
|---|---|---|
| `method:<METHOD>` | every operation with this method | `method:delete` |
| `path:<glob>` | every method on matching paths | `path:/orders/**` |
| `route:<METHOD> <glob>` | method and path together | `route:GET /orders/**` |
| `operationId:<glob>` | the spec's `operationId` | `operationId:*delete*` |
| `name:<glob>` | the tool name the agent sees (see [Tool names](#tool-names)) | `name:get_reports` |
| `tag:<glob>` | the spec's tags | `tag:Orders` |

The rules:

- Letter case does not matter anywhere: not in the selector, the method, paths (also in
  `route:`), operationIds, tool names or tags. `method:DELETE`, `method:delete` and
  `Method:Delete` are the same pattern, and `tag:orders` selects `Orders`. The server compares
  values with JavaScript's Unicode lower-casing, without Unicode normalization.
- The first colon ends the selector. `tag:Customer Support` and `operationId:orders:read*`
  work as written.
- In a path, `*` matches within one segment and `**` matches across segments. In an
  operationId, tool name or tag, `*` matches any characters, `/` included. There is no escape
  for a literal `*`.
- `method:` takes one method and no wildcard. A method other than the standard ones must be
  declared by the spec (OpenAPI 3.2 `additionalOperations`). `OPTIONS`, `TRACE`, `CONNECT` and
  `TRACK` are never exposed and cannot be named.
- `route:` is the method, exactly one space, and a path glob.
- A path glob starts with `/` or `*`. It matches the spec's path template as written
  (`/orders/{orderId}`), not the URL of a request.
- `/orders/**` does not match `/orders`, because the slash before `**` is literal. Use
  `path:/orders` and `path:/orders/**` together, or `path:/orders**`, which also matches
  `/orders-archive`.
- Several patterns of one flag add up: the server allows an operation when any `--allow`
  pattern matches it. There is no AND beyond `route:`.
- A pattern without a selector is an error. The error names the explicit form, for example
  `write "operationId:read*"` for `read*`, or `write "route:GET /orders"` for `GET /orders`.
- A selector never adds an alias, so the MCP client sees the exact tool names.

## How a decision is made

The server goes through these steps for each operation of the spec, in this order:

1. While it loads the spec, the server omits unsupported operations, each with a reason, for
   example a cookie parameter or a per-operation `servers` override.
2. The server excludes an operation that any `--deny` pattern matches. Deny always wins.
3. When at least one `--allow` is given, an operation must match one of them. `--allow`
   replaces the read-only default entirely, so write operations that match are exposed too.
   Without any `--allow`, the read-only default applies: `GET`, `HEAD` and `QUERY` operations,
   minus the denied ones.
4. Tool generation can still omit an operation whose schema it cannot represent. With
   `--omit-unsupported-parameters`, an operation omitted only for optional parameters becomes a
   tool without them (see
   [below](#operations-omitted-for-an-optional-parameter)).
5. While a changed spec waits for `openapi-mcp cache promote`, the server withholds every
   operation the new version removed.
6. At call time the server checks every request a tool sends, and every redirect, against
   these decisions. A tool's arguments or a redirect never reach an excluded operation (see
   [request authorization](security.md#request-authorization)).

A `HEAD` request counts as a `GET` at call time, because a server may answer `HEAD` with its
GET handler and so return what that `GET` returns. A `HEAD` call is therefore refused when its URL
also matches a `GET` that is not a tool. When that holds for every URL a `HEAD` operation can
send, the `HEAD` is left out with the decision `head-without-get`. Examples:
`--allow 'route:HEAD /orders/{id}'` alone, or `--deny method:get`, or a `GET` omitted as not
supported. Add the `GET` as well to keep the `HEAD`. A `HEAD` stays a tool as soon as one of its
URLs can pass, for example when an exposed `GET` on a concrete path such as `/orders/latest`
lies inside its template. Its other URLs are refused, and the startup warning about
overlapping paths names them.

## Tool names

A tool name is the operationId reduced to the characters `[A-Za-z0-9_-]`, at most 64 of them:

- `repos.get` becomes `repos_get`. Each run of other characters becomes one underscore, and
  runs at the start or end are dropped.
- Accented letters become their base letter (`Ünïcödé` becomes `Unicode`), and a few letters
  without one are spelled out (`ß` becomes `ss`, `ø` becomes `o`).
- Without a usable operationId (none, or one with no ASCII letter or digit left, such as a
  Chinese one), the name comes from method and path: `GET /users/{id}` becomes
  `get_users_by_id`.
- When even method and path leave no letter or digit, the name is `operation_<hash>`.
- When two names collide, the server adds a stable hash suffix, computed from method and path,
  so names do not change when the spec is reordered. An operationId that is already a valid
  tool name keeps it, and the reduced or method-and-path name that lands on it gets the suffix.
  Two identical operationIds both get a suffix.

`name:` matches these tool names. `operationId:`, `path:` and `tag:` match the spec's own
values.

## What is reported where

| What | Startup (stderr) | `openapi-mcp --json tools` | `openapi_mcp_status` |
|---|---|---|---|
| Operations that are not tools | one summary line with counts | `notExposed`: each with `decision` and `reason` | `notExposedCounts` |
| Unsupported operations | one line each | `omitted` | `omittedCount`, `omittedReasons` |
| Operations omitted only for optional parameters | one line naming them and the flag | `notExposed[].omittableParameters` | not reported |
| Parameters `--omit-unsupported-parameters` left out | one line naming the tools | `tools[].leftOutParameters` | not reported |
| Patterns that match nothing | one line each, with a suggestion | `deadPatterns` | `deadPatternCount` |
| Patterns that match values differing only by case | one line each | `caseCollisions` | not reported |
| Tools whose path overlaps one that is not exposed | one line each | `overlaps` | not reported |

A dead pattern is one that matches no operation of the spec. When it names only an operation
that is omitted as unsupported, the warning says so instead of suggesting another operation.

### Strict filters

A dead pattern, a case collision and an overlap are warnings. Pass `--strict-filters` to make
each of them stop the start instead, with exit code 3. This also applies to an overlap check
that ran out of its work budget (`overlapCheckComplete` is `false` in `--json tools`), and to
dead `--omit-output-schema` and `--omit-unsupported-parameters` patterns. Turn it on once a filter set is stable, so that a spec
change that makes a pattern stale fails at startup instead of passing with a warning.

## Operations omitted for an optional parameter

The server omits an operation when one of its parameters is something it cannot send. Some of
those parameters are optional. Stripe's `expand`, for example, is a `deepObject` over an array,
which OpenAPI leaves undefined, so every Stripe read is omitted, and the read-only default
exposes nothing. `--json tools` names such parameters under `notExposed[].omittableParameters`,
and the startup prints one line with the operations and the flag that builds them.

`--omit-unsupported-parameters <pattern>` builds the exposed operations the pattern matches
without those optional parameters. The agent then cannot set them: the tool refuses them as
arguments and never sends them. Its description starts with
`[Parameters not available here: expand.]`, and `--json tools` lists each one under
`leftOutParameters` with its reason. Leaving one out can take a filter or a dry run away from
the agent, so it is never the default: the flag names the operations where the user accepts
that.

| A parameter the server cannot send | Without the flag | With the flag |
|---|---|---|
| optional, in the query or a header | the operation is omitted | the tool has no such argument |
| required, or in the path | the operation is omitted | the operation is omitted |
| a header the operator sets with `--header` or `--header-env`, or one the HTTP client sends by itself (`Accept-Language`, `User-Agent`, `Accept-Encoding`, `Sec-Fetch-Mode`) | the operation is omitted | the operation is omitted |
| optional, when another query parameter could send its name | the operation is omitted | the operation is omitted |

Another query parameter could send the name when it is an object sent as separate keys
(`style: form`, `explode: true`), a `deepObject` such as `filter` next to a left-out
`filter[dryRun]`, or a name that a server reads as part of it, such as `expand[]` next to a
left-out `expand`. Names are compared without letter case, as some servers read them.

The flag never exposes an operation. `--deny` and the read-only default decide first. A pattern
that matches no exposed operation is a dead pattern. One that matches only operations that send
every parameter changes nothing, and the startup says so.

```bash
openapi-mcp serve --spec https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json \
  --omit-unsupported-parameters "method:get"
```

## Examples

An invented shop API:

| Method and path | `operationId` | Tag |
|---|---|---|
| `GET /orders` | `listOrders` | Orders |
| `POST /orders` | `createOrder` | Orders |
| `GET /orders/{orderId}` | `getOrder` | Orders |
| `DELETE /orders/{orderId}` | `deleteOrder` | Orders |
| `POST /orders/{orderId}/cancel` | `cancelOrder` | Orders |
| `GET /orders/{orderId}/items` | `listOrderItems` | Orders |
| `GET /orders/{orderId}/{section}` | `getOrderSection` | Orders |
| `GET /customers` | `listCustomers` | Customers |
| `DELETE /customers/{customerId}` | `removeCustomer` | Customers |
| `POST /customers/{customerId}/delete` | `customerDelete` | Customers |
| `GET /reports` | (none; the tool is `get_reports`) | Reports |

| Configuration | Tools | Why |
|---|---|---|
| (none) | `listOrders`, `getOrder`, `listOrderItems`, `getOrderSection`, `listCustomers`, `get_reports` | the read-only default |
| `--allow "tag:Orders"` | every Orders operation, `deleteOrder` included | `--allow` replaces the default, writes included |
| `--allow "tag:Orders" --deny "method:delete"` | the same without `deleteOrder` | deny wins |
| `--allow "method:get" --allow "operationId:createOrder"` | the reads and `createOrder` | patterns of one flag add up |
| `--allow "route:GET /orders/**"` | `getOrder`, `listOrderItems`, `getOrderSection` | `/orders/**` does not match `/orders` |
| `--allow "operationId:*"` | every operation except `get_reports` | `GET /reports` has no operationId |
| `--allow "path:/**"` | every operation | every path matches |

### Never delete

```bash
--allow "path:/**" \
--deny "method:delete" \
--deny "path:**delete**" \
--deny "operationId:*delete*"
```

| Pattern | Excludes |
|---|---|
| `method:delete` | `deleteOrder`, `removeCustomer`: every `DELETE`, whatever its name |
| `path:**delete**` | `customerDelete`: every path that contains "delete" |
| `operationId:*delete*` | `deleteOrder`, `customerDelete`: every operationId that contains "delete" |

`cancelOrder` stays exposed. A pattern cannot tell what an operation does. An operation that
deletes without `DELETE`, and without "delete" in its path or operationId, has to be named, for
example `--deny "operationId:cancelOrder"`. `method:delete` is the only pattern that does not
depend on how the spec names things.

Name patterns alone are weak here. `operationId:delete*` does not match `customerDelete`, and
no name pattern matches a `DELETE` called `removeCustomer`.

### Case collisions

Selectors ignore case, so `path:/orders/**` matches `/orders/{orderId}` and `/Orders/export`
alike. When a pattern matches values that differ only by case, startup names them:

```
--allow "path:/orders/**" matches values that differ only by case: "/orders/export", "/Orders/export" (GET /orders/export, GET /Orders/export)
```

You may have meant only one of them. Spell out the operation you want, or exclude the other
one. The server does not report a pattern that takes every spelling as written anyway, such as
`path:/**`, because ignoring case adds nothing there.

## Overlapping paths

Request authorization (see [security](security.md#request-authorization)) resolves each request
against every operation of the spec. A concrete path wins over a template, as OpenAPI defines.
Two templates are not ranked against each other. So when an exposed template and one that is
not exposed match the same URL, the server refuses that request.

| Configuration | `GET /orders/{orderId}/items` | `GET /orders/{orderId}/{section}` | What happens |
|---|---|---|---|
| `--allow "route:GET /orders/*/items"` | exposed | excluded | `listOrderItems` is refused: `/orders/42/items` also matches `{section}` |
| `--allow "route:GET /orders/**"` | exposed | exposed | both work |
| `--allow "route:GET /orders/**" --deny "route:GET /orders/*/{section}"` | exposed | excluded | refused, as in the first row |
| `--allow "route:GET /orders/**" --deny "operationId:getOrderSection" --deny "operationId:listOrderItems"` | excluded | excluded | neither is a tool |

### Why the server refuses

OpenAPI ranks only concrete paths before templates. Servers that route in declaration order,
such as [Starlette](https://starlette.dev/routing/#route-priority),
[FastAPI](https://fastapi.tiangolo.com/tutorial/path-params/#order-matters) and
[Rails](https://guides.rubyonrails.org/routing.html#crud-verbs-and-actions), could send
`/orders/42/items` to the `{section}` handler, which the configuration excludes.

### How you learn about it

Startup names each such tool and the operation it overlaps:

```
tool listOrderItems (GET /orders/{orderId}/items): a request that also matches GET /orders/{orderId}/{section}, which is not exposed, is refused; review --allow, --deny and the spec
```

`openapi-mcp --json tools` lists every pair under `overlaps`. With `--strict-filters` an
overlap stops the start. The error of a refused call says that its URL also matches an
operation this server does not expose.

### What to do

Exclude both operations. Or, if you intend to expose the other one, allow both. Allowing both
widens what an agent can do, so decide it deliberately.

### What is not an overlap

An excluded concrete path inside an exposed template, such as `GET /items/export` under
`GET /items/{id}`, is not reported. That one URL is the other operation: the server refuses
`getItem` with `id: "export"`, and every other id works.

## Migrating from the earlier syntax

Up to version 0.4, a bare word was an operationId glob, `METHOD /path` selected by method and
path, and matching was case-sensitive. These patterns are now an error that names the
replacement:

| Before | Now |
|---|---|
| `--deny "DELETE /**"` | `--deny "method:delete"` (or `route:DELETE /**`) |
| `--allow "GET /orders/**"` | `--allow "route:GET /orders/**"` |
| `--allow "**"` | `--allow "operationId:*"` for the same operations, or `--allow "path:/**"` to include operations without an operationId |
| `--allow "read*"` | `--allow "operationId:read*"`, or `--allow "method:get"` if a method was meant |
| `--allow "tag:Orders"` | unchanged |

## How the filters are tested

Every pull request runs the filters end to end, through the real CLI over MCP stdio, on Linux,
macOS and Windows, in both tool modes, against a local API that records every request.

`packages/cli/test/serve-filter-matrix.test.ts` covers every selector, letter case, glob
boundaries (`/orders/**` against `/orders**`), a tag with a space, an operationId with `/`,
generated tool names, Unicode without normalization (`tag:STRASSE` does not select `Straße`),
deny over allow, the read-only default, and arguments that try to leave their operation. The
expected tools for each configuration are written by hand. The test checks that exactly those
are offered, that every other operation is refused by name and by a case variant with zero
requests sent, and that every offered one reaches the API with its own method and path.

`packages/cli/test/filters-real-specs.test.ts` does the same against the GitHub, Stripe and
DigitalOcean specs. There the expectation is a predicate over the raw spec, never the filter
code. An operation that the predicate expects but the server does not offer must be one that
startup reports as omitted. The test pins those by count and hash.

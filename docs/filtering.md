# Filtering

`--allow` and `--deny` decide which operations of a spec become tools. `--omit-output-schema`
uses the same patterns to pick exposed tools. Every pattern names what it selects, so a
configuration reads as what it does:

```bash
openapi-mcp serve --spec ./shop.json \
  --allow "tag:Orders" \
  --deny "method:delete"
```

Without any `--allow`, only reads are exposed: `GET`, `HEAD` and the OpenAPI 3.2 `QUERY`.

## Selectors

Every pattern starts with one selector:

| Selector | Selects | Example |
|---|---|---|
| `method:<METHOD>` | every operation with this method | `method:delete` |
| `path:<glob>` | every method on matching paths | `path:/orders/**` |
| `route:<METHOD> <glob>` | method and path together | `route:GET /orders/**` |
| `operationId:<glob>` | the spec's `operationId` | `operationId:*delete*` |
| `name:<glob>` | the tool name the agent sees | `name:get_reports` |
| `tag:<glob>` | the spec's tags | `tag:Orders` |

Rules:

- **Letter case does not matter**, anywhere: the selector, the method, paths (also in
  `route:`), operationIds, tool names and tags. `method:DELETE`, `method:delete` and
  `Method:Delete` are the same pattern, and `tag:orders` selects `Orders`. Values are compared
  with JavaScript's Unicode lower-casing, without Unicode normalization.
- **The first colon ends the selector.** `tag:Customer Support` and `operationId:orders:read*`
  work as written.
- **Wildcards:** in a path, `*` matches within one segment and `**` across segments. In an
  operationId, tool name or tag, `*` matches any characters, `/` included. There is no escape
  for a literal `*`.
- **`method:`** takes one method, no wildcard. A method other than the standard ones must be
  declared by the spec (OpenAPI 3.2 `additionalOperations`). `OPTIONS`, `TRACE`, `CONNECT` and
  `TRACK` are never exposed and cannot be named.
- **`route:`** is the method, exactly one space, and a path glob.
- **A path glob** starts with `/` or `*`, and matches the spec's path template as written
  (`/orders/{orderId}`), not the URL of a request.
- **`/orders/**` does not match `/orders`**: the slash before `**` is literal. Use
  `path:/orders` and `path:/orders/**` together, or `path:/orders**`, which also matches
  `/orders-archive`.
- **Several patterns of one flag add up**: an operation is allowed when any `--allow` pattern
  matches it. There is no AND beyond `route:`.
- **A pattern without a selector is an error** that names the explicit form, for example
  `write "operationId:read*"` for `read*`, or `write "route:GET /orders"` for `GET /orders`.
- Tool names stay exact for the MCP client: a selector never adds an alias.

## How a decision is made

For each operation of the spec, in this order:

1. **Unsupported operations are omitted** while the spec is loaded, each with a reason (for
   example a cookie parameter or a per-operation `servers` override).
2. **`--deny`:** an operation that any `--deny` pattern matches is excluded. Deny always wins.
3. **`--allow`:** when at least one `--allow` is given, an operation must match one of them.
   Without any `--allow`, the read-only default applies.
4. **Tool generation** can still omit an operation whose schema cannot be represented.
5. **Withholding:** while a changed spec waits for `openapi-mcp cache promote`, an operation it
   removed is withheld.
6. **At call time**, every request a tool sends, and every redirect, is checked against these
   decisions. An excluded operation is never reached through a tool's arguments or a redirect
   (see [request authorization](security.md#request-authorization)).

## What is reported where

| What | Startup (stderr) | `openapi-mcp --json tools` | `openapi_mcp_status` |
|---|---|---|---|
| Operations that are not tools | one summary line with counts | `notExposed`: each with `decision` and `reason` | `notExposedCounts` |
| Unsupported operations | one line each | `omitted` | `omittedCount`, `omittedReasons` |
| Patterns that match nothing | one line each, with a suggestion | `deadPatterns` | `deadPatternCount` |
| Patterns that match values differing only by case | one line each | `caseCollisions` | — |
| Tools whose path overlaps one that is not exposed | one line each | `overlaps` | — |

A dead pattern, a case collision and an overlap are warnings. With `--strict-filters` each one
stops the start instead.

A dead pattern is one that matches no operation of the spec. When it names only an operation
that is omitted as not supported, the warning says so instead of suggesting another operation.

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

`cancelOrder` stays exposed. A pattern cannot tell what an operation does: one that deletes
without `DELETE`, and without "delete" in its path or operationId, has to be named, for example
`--deny "operationId:cancelOrder"`. `method:delete` is the only pattern that does not depend on
how the spec names things.

Name patterns alone are weak here: `operationId:delete*` does not match `customerDelete`, and
no name pattern matches a `DELETE` called `removeCustomer`.

### Case collisions

Selectors ignore case, so `path:/orders/**` matches `/orders/{orderId}` and `/Orders/export`
alike. When a pattern matches values that differ only by case, startup names them:

```
--allow "path:/orders/**" matches values that differ only by case: "/orders/export", "/Orders/export" (GET /orders/export, GET /Orders/export)
```

The operator may have meant only one of them. Spell out the operation you want, or exclude the
other one. A pattern that takes every spelling as written anyway, such as `path:/**`, is not
reported: ignoring case adds nothing there.

## Overlapping paths

Request authorization (see [security](security.md#request-authorization)) resolves each request
against every operation of the spec. A concrete path wins over a template, as OpenAPI defines.
Two templates are not ranked against each other, so when an exposed template and one that is
not exposed match the same URL, that request is refused.

| Configuration | `GET /orders/{orderId}/items` | `GET /orders/{orderId}/{section}` | What happens |
|---|---|---|---|
| `--allow "route:GET /orders/*/items"` | exposed | excluded | `listOrderItems` is refused: `/orders/42/items` also matches `{section}` |
| `--allow "route:GET /orders/**"` | exposed | exposed | both work |
| `--allow "route:GET /orders/**" --deny "route:GET /orders/*/{section}"` | exposed | excluded | refused, as in the first row |
| `--allow "route:GET /orders/**" --deny "operationId:getOrderSection" --deny "operationId:listOrderItems"` | excluded | excluded | neither is a tool |

**Why it is refused.** OpenAPI ranks only concrete paths before templates. Servers that route
in declaration order, such as
[Starlette](https://starlette.dev/routing/#route-priority),
[FastAPI](https://fastapi.tiangolo.com/tutorial/path-params/#order-matters) and
[Rails](https://guides.rubyonrails.org/routing.html#crud-verbs-and-actions), could send
`/orders/42/items` to the `{section}` handler, which the configuration excludes.

**How you learn about it.** Startup names each such tool and the operation it overlaps:

```
tool listOrderItems (GET /orders/{orderId}/items): a request that also matches GET /orders/{orderId}/{section}, which is not exposed, is refused; review --allow, --deny and the spec
```

`openapi-mcp --json tools` lists every pair under `overlaps`. With `--strict-filters` an
overlap stops the start. A call that is refused says that its URL also matches an operation
this server does not expose.

**What to do.** Exclude both operations, or, if exposing the other one is intended, allow both.
Allowing both widens what an agent can do, so decide it deliberately.

**Not an overlap.** An excluded concrete path inside an exposed template, such as
`GET /items/export` under `GET /items/{id}`, is not reported. That one URL is the other
operation: `getItem` with `id: "export"` is refused, and every other id works.

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

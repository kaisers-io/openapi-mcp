# Filtering

Turn what the user wants into `--allow` and `--deny` patterns, and show the result as a table.
Details: [docs/filtering.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/filtering.md#selectors).

## Contents

- [Selectors](#selectors)
- [How a decision is made](#how-a-decision-is-made)
- [From intent to patterns](#from-intent-to-patterns)
- [Recipes](#recipes)
- [Checking the patterns](#checking-the-patterns)
- [Comparing the result](#comparing-the-result)
- [The table](#the-table)

## Selectors

Every pattern names its selector. Letter case never matters.

| Selector | Matches | Example |
|---|---|---|
| `method:` | the HTTP method | `method:delete` |
| `path:` | the path; `*` is one segment, `**` any number | `path:/orders/**` |
| `route:` | method and path | `route:POST /orders` |
| `operationId:` | the operationId; `*` matches any characters | `operationId:createOrder` |
| `name:` | the generated tool name | `name:get_reports` |
| `tag:` | a tag of the operation | `tag:Orders` |

`/orders/**` does not match `/orders` itself. An operation without an operationId has a tool
name built from method and path, such as `get_reports`.

A pattern has at most 256 characters and 10 wildcards, and each flag takes at most 128. The
start fails on a pattern without a selector (`needs a selector; write ...` names the
replacement), an unknown selector, `method:` or `route:` without a method the spec uses,
`path:` or `route:` without a leading `/` or `*`, and a selector without a value. `method:`
takes `get`, `put`, `post`, `delete`, `patch`, `head`, `query`, or a method the spec declares
under `additionalOperations`; `OPTIONS` and `TRACE` never become tools.

## How a decision is made

1. A `--deny` that matches wins.
2. With any `--allow`, an operation is exposed only if an `--allow` matches. Reads are not
   kept by default then.
3. Without `--allow`, reads (GET, HEAD, QUERY) are exposed and nothing else. To keep them next
   to an `--allow`, name each of these methods the spec uses: `tools` without filters lists
   the reads as tools. `--strict-filters` rejects a `method:` pattern that matches nothing.

## From intent to patterns

Prefer one `route:` or `operationId:` pattern per operation the user named. Broad patterns
expose operations nobody looked at.

| The user says | Patterns |
|---|---|
| only look things up | none (the read-only default) |
| look things up and create orders | `--allow "method:get" --allow "operationId:createOrder"`, plus `method:head` and `method:query` when the spec has such operations |
| everything about orders, never delete | `--allow "tag:Orders" --deny "method:delete"`, then check every remaining write in the table |
| change anything, but never delete | `--allow "path:/**" --deny "method:delete"`, plus a `--deny` for each operation whose path or name deletes, such as `--deny "route:POST /customers/*/delete"`; every other write stays allowed, so list them in the table |

A pattern cannot tell what an operation does. `POST /orders/{orderId}/cancel` changes data
without being a DELETE. The table makes such operations visible, so the user decides on each.

## Recipes

These run in CI against the shop example of the docs (`packages/cli/test/fixtures/shop-filtering.json`).
Each block lists the arguments and the tools they expose.

<!-- recipe: read-only -->
```
args:
tools: get_reports getOrder getOrderSection listCustomers listOrderItems listOrders
```

<!-- recipe: reads-and-create -->
```
args: --allow method:get --allow operationId:createOrder
tools: createOrder get_reports getOrder getOrderSection listCustomers listOrderItems listOrders
```

<!-- recipe: orders-without-delete -->
```
args: --allow tag:Orders --deny method:delete
tools: cancelOrder createOrder getOrder getOrderSection listOrderItems listOrders
```

<!-- recipe: all-but-delete -->
```
args: --allow path:/** --deny method:delete --deny path:**delete** --deny operationId:*delete*
tools: cancelOrder createOrder get_reports getOrder getOrderSection listCustomers listOrderItems listOrders
```

## Checking the patterns

Run `tools` with the patterns and `--strict-filters`. It fails on:

- a pattern that matches nothing (`deadPatterns`, with the closest match)
- a pattern that matches values that differ only by case (`caseCollisions`)
- an exposed path that can match the same URL as an excluded one (`overlaps`)

Without `--strict-filters` these are warnings: `matches no operation` (with `closest:` when a
name is near), `matches values that differ only by case`, and `which is not exposed, is
refused`. A pattern that names only operations omitted as not supported says so. Fix each
one. `notExposed` lists every operation that is not a tool, with its `decision` and `summary`:
use it for the blocked rows of the table.

`--omit-output-schema` and `--omit-unsupported-parameters` take the same selectors. A pattern
of theirs that has no effect warns `so it changes nothing`.

At most 512 tools under `per-operation` (4,096 under `discover`): more fail with
`exceeds the 512-tool budget`. A spec with more than 4,096 operations fails whatever the
filters.

## Comparing the result

After every `tools` run, compare what the server delivers with what the user wants:

1. Expected: the operations the user confirmed in the table. Count them.
2. Delivered: `data.toolCount` and the names in `data.tools`. Count them.
3. Every expected operation that is not a tool has a row in `data.notExposed`. Every tool the
   user did not want is a gap too.

Report the two numbers and each gap in one line, with its cause and the fix you propose:

| `notExposed` says | Cause | Fix to propose |
|---|---|---|
| `decision: denied` | a `--deny` pattern matches it (`pattern`) | narrow that deny, if the user wants the operation |
| `decision: not-allowed` | no `--allow` matches it | add a `route:` or `operationId:` pattern for it |
| `decision: read-only-default` | it is a write and there is no `--allow` | add `--allow` for it, and for the reads |
| `decision: omitted` with `omittableParameters` | only optional parameters the server cannot send keep it out, such as Stripe's `expand` | `--omit-unsupported-parameters "operationId:<id>"` for each such operation the user wants; tell the user which parameters the agent then cannot set (rule 9) |
| `decision: omitted` without them | the operation uses something the server does not support (`reason`) | explain the reason; it needs a changed spec |
| `decision: head-without-get` | its `GET` is not exposed, so every call would be refused | add the `GET`, or drop the `HEAD` |
| `decision: withheld` | a changed spec waits and removed it | the user reviews it: `openapi-mcp cache promote` |
| a tool the user did not want | a pattern is too broad | narrow it, or add a `--deny` |

A startup line `N operations are omitted only for optional parameters ...` lists the operations
the flag would build. `data.counts` gives the counts per decision. Run `tools` again after each
change, until the numbers match or the user accepts each remaining gap.

## The table

| Allowed | Operation | What it does | Method and path |
|---|---|---|---|
| yes | createOrder | Creates an order for a customer | POST /orders |
| no | deleteOrder | Deletes an order | DELETE /orders/{orderId} |

Write "What it does" from `summary`, or from the first sentence of `description`. Say when an
operation has neither. Mark operations that change data, and ask about each of them.

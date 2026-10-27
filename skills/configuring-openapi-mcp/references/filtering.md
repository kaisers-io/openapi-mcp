# Filtering

Turn what the user wants into `--allow` and `--deny` patterns, and show the result as a table.
Details: [docs/filtering.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/filtering.md#selectors).

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
| never delete anything | `--deny "method:delete"`, plus a `--deny` for each operation whose path or name deletes, such as `--deny "route:POST /customers/*/delete"` |

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

<!-- recipe: never-delete -->
```
args: --allow path:/** --deny method:delete --deny path:**delete** --deny operationId:*delete*
tools: cancelOrder createOrder get_reports getOrder getOrderSection listCustomers listOrderItems listOrders
```

## Checking the patterns

Run `tools` with the patterns and `--strict-filters`. It fails on:

- a pattern that matches nothing (`deadPatterns`, with the closest match)
- a pattern that matches values that differ only by case (`caseCollisions`)
- an exposed path that can match the same URL as an excluded one (`overlaps`)

Fix each one. `notExposed` lists every operation that is not a tool, with its `decision` and
`summary`: use it for the blocked rows of the table.

## The table

| Allowed | Operation | What it does | Method and path |
|---|---|---|---|
| yes | createOrder | Creates an order for a customer | POST /orders |
| no | deleteOrder | Deletes an order | DELETE /orders/{orderId} |

Write "What it does" from `summary`, or from the first sentence of `description`. Say when an
operation has neither. Mark operations that change data, and ask about each of them.

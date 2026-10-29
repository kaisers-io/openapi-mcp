# Large APIs and tool modes

This page explains how the server hands the operations of an API to the model, and what to do
when an API is too large to list as one tool per operation. Read it if your spec has more than a
few dozen operations, if `tools/list` is large, or if `serve` refuses to start because of the
tool budget. Every flag named here is listed in the [configuration reference](configuration.md).

## Why large APIs need a different mode

By default, every exposed operation is its own MCP tool. An exposed operation is one that the
`--allow`/`--deny` filters and the read-only default let through (see
[filtering](filtering.md)). The host sends every tool's name, description and schemas to the
model up front, before the model has done anything. For DigitalOcean's read-only operations
that is about 30k tokens.

With `--tool-mode discover`, the server lists a few fixed tools instead: `search_operations`,
`describe_operation`, `call_operation` and `execute_code`. `tools/list` then stays at about 6 KB
however many operations are exposed, up to 4096. The filters, argument validation and redaction work
exactly as they do for a direct call. `--tool-mode auto` picks `discover` when more than 64
operations are exposed, or when the tool definitions take more than 40,000 bytes.

## The three modes

`--tool-mode` decides how the exposed operations reach the model. The default is
`per-operation`.

| Mode | What `tools/list` carries | Most operations exposed |
|---|---|---|
| `per-operation` | `openapi_mcp_status`, `execute_code` and one tool per exposed operation, each with its full input schema, output schema and description | 512 |
| `discover` | `openapi_mcp_status`, the three discovery tools and `execute_code`, whatever the number of operations | 4096 |
| `auto` | Whatever the mode it picks carries | 4096 |

### `per-operation`

The server lists one MCP tool per exposed operation. The model sees every operation and can
call it in one step. At most 512 operations may be exposed in this mode.

### `discover`

The server lists `openapi_mcp_status`, three discovery tools and `execute_code`. The model
finds an operation with `search_operations`, reads its definition with `describe_operation`,
and calls it with `call_operation`, or with a program in `execute_code`.

`search_operations` takes `{ query?, tags?, method?, limit?, detail? }`. It ranks the exposed
operations by keyword, matching the operation name, path, tags, parameter names, summary and
description. The search runs locally and gives the same result every time. It uses no
embeddings and no network. The arguments work like this:

- `query` holds the keywords. A query longer than 500 characters is an invalid argument. Of a
  longer list of terms, the search uses the first 32 distinct ones. Without a query, the
  operations come back by name.
- `tags` keeps only operations that have at least one of these tags.
- `method` keeps only operations with this HTTP method.
- `limit` is the most results to return, from 1 to 25. The default is 10.
- `detail` is `"names"` for operation names only, or `"summary"`, the default, for the method,
  path, summary and tags as well.
- With [several APIs](several-apis.md) in one server, `api` keeps only the operations of that
  API.

`describe_operation` takes `{ name, include_output_schema? }`. It returns the operation's
definition as `per-operation` mode would list it, but without its `outputSchema` by default.
Output schemas are most of a definition, and the model needs only the `inputSchema` to call
an operation. The server marks an omitted output schema with `outputSchemaOmitted: true`, and
`include_output_schema: true` returns it.

An operation that accepts `_fields` (with `--response-projection`, see
[requests and responses](requests-and-responses.md)) lists its result fields instead, as
`outputFields`. That list has one entry per success response, each with up to 150
`<pointer>: <type>` lines. Every top-level field comes before a nested one, the list goes two
levels deep, and an entry that was cut says `truncated: true`. For the GitHub REST
description, a whole describe response is 12 to 20 KB instead of 44 to 154 KB.
`include_output_schema: false` leaves the field list out too. The server validates every
result against the output schema either way.

`call_operation` takes `{ name, arguments }` and calls the operation. The server validates
`arguments` with that operation's own schema, so you get the same error messages, rate limit,
redaction and upstream request as with a direct call. Omit `arguments` for an operation
without inputs. The server rejects `null` with `arguments: invalid_type`.

Up to 4096 operations may be exposed in `discover` mode.

### `auto`

`auto` picks `discover` when either rule below holds, and `per-operation` otherwise:

- More than 64 operations are exposed after filtering.
- The tool definitions a model sees take more than 40,000 bytes. A definition here is the
  tool's name, description and input schema, without the output schema.

`serve` prints which rule picked `discover`. The size rule catches small specs with very large
schemas. Over 194 public specs, a median definition takes 646 bytes, so 64 operations take
about 40 KB. Of 278 configurations with at most 64 operations, 20 took more, up to 439 KB.

Since `auto` can pick `discover`, it allows up to 4096 exposed operations, like `discover`.

## Scripts: `execute_code`

### What it is

`execute_code` is a tool that runs a short JavaScript program the model writes. In the
program, `api.call(name, args)` calls one of the API's operations. The program can page
through a list, follow ids from one operation to another, filter, count and sum, and then
return only what the task needs. The responses on the way stay inside the program; the model
sees only the result.

Without it, the model makes every call itself and reads every response. A question such as
"what did all customers in Austria spend" can take 40 calls, and all 40 responses go through
the model's context. With `execute_code`, the model writes one program instead:

```js
const customers = [];
for (let page = 1; ; page += 1) {
  const result = await api.call('listCustomers', { country: 'AT', page });
  customers.push(...result.data.items);
  if (page >= result.data.totalPages) break;
}
const orders = await Promise.all(
  customers.map((customer) => api.call('listCustomerOrders', { customerId: customer.id })),
);
return orders.flatMap((result) => result.data.items).reduce((sum, order) => sum + order.total, 0);
```

The tool returns the program's result and every call it made:

```json
{ "result": 15390, "calls": [{ "name": "listCustomers", "status": "ok" }, ...] }
```

A program reads only: it can call the `GET`, `HEAD` and `QUERY` operations the filters expose,
and nothing else. The model makes a write with its own tool call, as before.

### When it is offered

`execute_code` is in `tools/list` in every tool mode. Under `discover`, a program names an
operation the way `call_operation` does. Under `per-operation`, it uses the operation's tool
name. With [several APIs](several-apis.md) in one server, one program can read from all of
them. `--no-execute` leaves the tool out.

An operation of the spec can itself be named `execute_code`. Under `per-operation`, that
operation keeps the name, the server lists no program tool, and `serve` says so at startup.
Under `discover` both exist, because operations are not tool names there.

### How a program works

`execute_code` takes `{ code }`, the body of an async function of at most 20,000 characters.
`await api.call(name, args)` returns the operation's result, with the response body in
`data`. For an operation with an output schema, the result also has `status` and
`contentType`, and `headers` and `pagination` when the response has them. For an operation
without one, the result has `data`, `headers` and `pagination` only, and `data` holds the body
parsed as JSON, or as text when it is not JSON. An operation that returns an image fails in a
program; the model calls it directly. A failed call throws an error with the
text a direct call would return. `return` gives the tool's result, which must be JSON;
`console.log` output comes back too.

A call's status in `calls` is `ok`, `error` or `cancelled`. `cancelled` means the program ended
while the call waited or ran. A call that a limit stopped before it was sent is not in the
list. The list is complete also when the program fails, so the model knows what ran.

### What a program can do

A program can call the `GET`, `HEAD` and `QUERY` operations the filters expose. It cannot call
any other operation. The server refuses such a call before it sends anything, and the model
makes the write with `call_operation` or the operation's own tool, so every write keeps its own
tool call and its own approval.

Each `api.call()` goes through the same checks as a direct call of that operation: the filters,
the argument validation, `--rate-limit`, the egress rules and the redaction. `--log json`
writes one line for each call. The program itself has no network, file, timer, environment or
module access. The [security model](security.md#scripts-execute_code) explains the sandbox.

Every call in a program counts against `--rate-limit` (120 calls a minute by default). A task
that reads more than 100 items one by one can reach it. Raise `--rate-limit` for such tasks.

### Limits

| Limit | Value |
|---|---|
| `api.call()` per program | 50 |
| Calls in flight at once | 4 |
| Run time, calls included | 30 s |
| Memory of the program | 48 MB, inside a WebAssembly memory of at most 80 MB |
| Arguments of one call | 100 KB of JSON |
| Call results one program receives | 8 MB of JSON together |
| Result | 50 KB of JSON |
| `console.log` output | 10 KB |
| Programs running at once in one server | 4 |

A call past the call limit, the argument limit or the received-data limit fails with an error that
names the limit, and the program can catch it and go on. A program past the time or memory limit
ends. A result past 50 KB fails the whole program. The server cuts an error text to 8,192 characters
and a call's name in `calls` to 128 characters. The values are fixed.

The limit of four programs at once holds for the whole server. Over HTTP, programs of all
clients count together, and a fifth program gets an error that asks to try again.

### What it costs

Each program starts a fresh worker with its own engine, which takes about 50 ms. The server
loads the engine only when a program runs, so a server that never runs one starts as fast as
before. `execute_code` adds about 1.5 KB to `tools/list`.

A call in a program gets the whole response body, up to the 8 MB limit. A direct call cuts a
text result at 8 KB, because the model reads it. A program can parse the whole body, and the
model reads only the program's result.

### Why it is on by default

We measured every tool mode with and without `execute_code`, with two coding agents, on a test
API and on two public APIs. Each task ran in English and in German. The test API is a local
shop with customers, orders, stock and tickets (`scripts/evals`). On GitHub and PokeAPI, the
harness reads the right answers from the API when a run starts.

With `execute_code`, every tool mode answered as many tasks correctly or more, and the agents
needed fewer tool calls. The one exception is a run in which agent 2 answered from memory
without calling the API, which counts as wrong. Agent 1 cost less in every measurement, between
20% and 80% less. Agent 2 sends a large prompt of its own with every task, so its token counts
moved less. They fell in every measurement but one.

Cost of all runs of agent 1:

| API | Operations | `per-operation` | with `execute_code` | `discover` | with `execute_code` |
|---|---|---|---|---|---|
| Test API, 9 tasks | 36 | $0.51 | $0.41 | not measured | not measured |
| Test API as two specs, 13 tasks | 36 | $1.10 | $0.67 | $1.42 | $0.81 |
| Test API, 6 tasks | 261 | $1.80 | not measured | $1.63 | $0.78 |
| GitHub, 6 tasks | 185 | $2.08 | $0.53 | $1.29 | $0.33 |
| GitHub, 6 tasks | 655 | does not start | does not start | $1.29 | $0.35 |
| PokeAPI, 5 tasks | 102 | $1.57 | $0.31 | $1.13 | $0.32 |

Input tokens of agent 2, median per run:

| API | Operations | `per-operation` | with `execute_code` | `discover` | with `execute_code` |
|---|---|---|---|---|---|
| Test API | 36 | 88k | 74k | not measured | not measured |
| Test API as two specs | 36 | 89k | 88k | 193k | 159k |
| Test API | 261 | 159k | not measured | 165k | 160k |
| GitHub | 185 | 107k | 97k | 102k | 118k |
| GitHub | 655 | does not start | does not start | 185k | 115k |
| PokeAPI | 102 | 102k | 92k | not usable | not usable |

The exception is GitHub with 185 operations under `discover`, where agent 2 used 118k tokens
with `execute_code` and 102k without it. Under `discover`, agent 2 answered most PokeAPI tasks
from memory, without calling the API, so those runs count as wrong and give no token numbers.

The gain grows with the number of calls a task needs. On the test API with 261 operations,
summing the orders of all customers in one country takes about 40 calls. Under `discover`,
agent 1 needed 58k input tokens and 17 s for it with `execute_code`, and 102k tokens and 40 s
without. A task that needs one call costs about the
same either way. `per-operation` cannot serve more than 512 operations at all, which is why
GitHub's 655 reads do not start in that mode.

`--no-execute` leaves the tool out. Use it for an API whose `GET` operations change data, or
when a host should list exactly one tool per operation.

## Filters still decide what the model can reach

`--allow`, `--deny` and the read-only default work the same way in every mode. An operation
they exclude can be neither found nor called. `call_operation` reports it as an unknown
operation.

## What `discover` costs

A model usually needs a search and a describe before it calls a new operation, so a task
takes more tool calls.

`discover` also changes how a host asks you for approval. One `call_operation` tool stands
for every exposed operation, so it carries the least safe annotations among them. It has
`readOnlyHint: true` only when every exposed operation is a `GET`, `HEAD` or `QUERY`, which
the read-only default ensures. Otherwise it has `destructiveHint: true` when any exposed
operation is destructive.

A host that asks for approval per tool, or decides from annotations, sees one tool for all
operations. Approving `call_operation` once approves every exposed operation, writes
included. `serve` warns at startup when `discover` exposes any operation that is not
read-only. If that matters to you, narrow the exposed set with `--allow`/`--deny`, or use
`--tool-mode per-operation` to approve each operation on its own. The
[security model](security.md#discovery-tool-mode) explains this in more detail.

## Startup cost

In `per-operation` mode, `serve` compiles one output validator per exposed operation before it
answers `initialize`. An output schema the validator cannot compile therefore stops `serve`
at startup. Operations with identical output schemas share one validator.

In `discover` mode, which can expose thousands of operations, the server builds an
operation's output schema, description and validator on its first `describe_operation` or
`call_operation`, before it sends any request. An output schema that cannot be built or
compiled then fails that operation's calls with a tool error, and `serve` names the operation
once on stderr. With `--omit-output-schema`, the server builds every output schema at startup,
because the warnings about its patterns depend on them.

Measured on a development machine with a warm spec cache, for the GitHub REST description
(1,241 operations exposed with `--allow 'operationId:*'`): `initialize` answers after about
0.5 s in `discover` mode. A session that describes or calls nearly every operation ends up a
few MB above a build that does everything at startup (about 3 MB of live heap after
describing all of GitHub's operations), because the server completes each operation on its
own.

## Measured `tools/list` sizes

Measured on 2026-10-24 as the whole stdio response line, before `execute_code` existed. It adds
about 1.5 KB to each column. Tokens are estimated as bytes / 4.

| Spec | Exposed | `per-operation` | `discover` |
|---|---|---|---|
| 400 generated `GET` operations | 400 | 334,616 bytes (~84k tokens) | 4,955 bytes (~1.2k tokens) |
| DigitalOcean (read-only default) | 146 | 127,186 bytes (~32k tokens) | 4,955 bytes |
| DigitalOcean (`--allow 'operationId:*'`) | 265 | 355,045 bytes (~89k tokens) | 5,002 bytes |

## Size limits

The server checks two limits on a spec:

- A spec may document at most 4096 operations. This is a hard stop before anything is cached,
  whatever the filters. A spec with more operations has to be split.
- After `--allow`/`--deny` filtering, at most 512 tools may be exposed in
  `per-operation` mode (the server lists `openapi_mcp_status` next to them), and at most 4096
  in `discover` and `auto` mode. An operation omitted as not supported is no tool and does not
  count. Above the limit,
  `serve` and `check` stop with an error such as
  `N tools would be exposed after filtering — exceeds the 512-tool budget; narrow the set with --allow or --deny`.

To serve a larger API, use `--tool-mode discover` or `auto`, or narrow the exposed set with
`--allow`/`--deny`.

The `tools` command does not take `--tool-mode`. It always applies the 512-operation limit
of `per-operation` mode, so it fails for an exposed set above 512 that `serve --tool-mode
discover` would accept. Use `check --tool-mode discover` to inspect such a set.

When the server stores a refreshed spec as a candidate that would expose more operations than
the current mode allows under the current filters, it warns. After `cache promote`, the
server would refuse to start. See [spec updates and the cache](spec-updates.md) for
candidates.

## Paging `tools/list`

Paging of `tools/list` is off by default, so every tool comes in one response. In
`per-operation` mode that is at most 514 tools, the 512 operations plus `openapi_mcp_status`
and `execute_code`, and in `discover` mode it is five. Several MCP
hosts call `tools/list` once and never follow `nextCursor`, so on those hosts paging would
hide every tool after the first page without any error.

Set `--tools-page-size <n>` only when your host follows `nextCursor`. The value is an integer
from 1 to 512. A cursor is bound to the spec being served, and the server rejects a cursor
from another spec version with Invalid Params.

## Output schema form

The server derives output schemas from the dereferenced spec. A component schema that the
spec uses in several places is therefore written out in full each time, and output schemas
make up most of `tools/list`.

With `--output-schema defs`, each tool's output schema lists a repeated subschema once under
its own `$defs` and refers to it with a local `$ref` elsewhere. Tools share nothing, so every
schema still stands alone. The envelope branches and their `status` and `contentType` stay
inline. Validation does not change: the two forms accept exactly the same values, so a
response passes or fails the same way whichever form the server compiles.

In `per-operation` mode, the form applies to `tools/list`. In `discover` mode, it applies to
the output schemas that `describe_operation` returns. The server computes those when it first
describes an operation, so startup does not pay for the form.

MCP requires JSON Schema 2020-12, which includes local `$ref`/`$defs`, but a host that does
not resolve them would see an incomplete schema. That is why the default stays `inline`.

Measured for the GitHub REST description with `--allow tag:repos` (201 tools): the whole
`tools/list` stdio response shrinks from 1,977,625 to 1,541,314 bytes (−22%), and its output
schemas by 28%. How much a spec gains depends on how often its schemas repeat inside one
response.

### Leaving out field descriptions

`--no-output-schema-descriptions` leaves out the `description` keyword of every output schema,
in `tools/list` and in `describe_operation`. Field descriptions, and the examples folded into
them, are about half of an output schema. The GitHub `tools/list` above shrinks from 1,935,526
to 1,180,515 bytes (−39%). Only the keyword goes. A field named `description` stays, and
validation does not change.

The option helps only when the client shows output schemas to the model. The model then no
longer sees what a result field means, so the option is off by default. It combines with
`--output-schema defs`.

### The `$schema` keyword

When the client negotiated MCP revision 2025-11-25 or later, every listed schema leaves out
its `$schema` keyword, because that revision makes JSON Schema 2020-12 the default dialect.
An earlier revision defines no default, so the keyword stays.

## Memory for large specs

For a large spec, Node's young generation decides the peak memory of `serve` more than the
spec does. With a spec the size of GitHub's REST description, set
`NODE_OPTIONS=--max-semi-space-size=8` in the environment of the server entry, for example:

```json
"env": { "NODE_OPTIONS": "--max-semi-space-size=8" }
```

Measured with Node 24 and a warm cache (issue #59). Peak memory is the resident set size,
shown as default → 8 MB:

| Scenario | Peak memory, macOS | Peak memory, Linux | Startup | Per call |
|---|---|---|---|---|
| GitHub, `discover` | 297 → 189 MB | 215 → 169 MB | unchanged (macOS), −6% to −9% (Linux) | unchanged |
| GitHub, `--allow tag:repos` | 292 → 227 MB | 296 → 227 MB | +5% (macOS), −6% (Linux) | unchanged |
| DigitalOcean, default | 108 → 102 MB | 112 → 105 MB | unchanged | unchanged |
| 1 MB results, 8 in flight | 550 → 465 MB | not measured | | −4% throughput (macOS) |

Per call, the median latency for 1 KB, 50 KB and 1 MB results and the throughput of 1 KB
results stay within noise. Below 4 MB, startup of large specs gets slower (+8% at 2 MB, +22%
at 1 MB on Linux).

The server does not set the option itself. Node reads it only at process start, and a restart
with the flag would cost 30 to 70 ms on every start while saving only 4 to 7 MB for small and
medium specs.

For the memory each in-flight call needs, see
[requests and responses](requests-and-responses.md).

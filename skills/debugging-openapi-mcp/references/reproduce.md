# Reproducing outside the host

Use this when `check`, `tools` and the host log do not explain the problem.

## The request without sending it

`CLI --json call <tool> --dry-run --args-json '<arguments>' <the entry's arguments>` builds the
request a call would send and sends nothing, writes included. It reports the method, origin,
path, the names of query parameters and headers (`"credential": "set"`, never a value), the
body size, and `checks` for `route`, `egress` and `budgets`: `allowed`, `refused` with a
`reason`, or `not evaluated`. Redirects, the response and the OAuth token stay unchecked
(`notEvaluated`). Exit 3 means a check refused the call or the arguments are invalid (code
`tool_error`, the same text a host gets). Its own errors: `call needs --dry-run`,
`--args-json is not valid JSON`, `no exposed operation is named "x"` (under `discover`, pass the
operation name; with `--api`, the name with the API in front).

`CLI --json doctor` shows the CLI and Node versions and where the app and cache folders are.

## A read call through the MCP Inspector

The [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector) starts the server like
a host and makes one call. Use the entry's command and arguments, and a read operation the user
picks:

```sh
npx -y @modelcontextprotocol/inspector@2.12.0 --cli --format json \
  npx -y @kaisers-io/openapi-mcp@X.Y.Z serve <the entry's arguments> \
  --method tools/list
```

```sh
npx -y @modelcontextprotocol/inspector@2.12.0 --cli --format json \
  npx -y @kaisers-io/openapi-mcp@X.Y.Z serve <the entry's arguments> \
  --method tools/call --tool-name <tool> --tool-args-json '{"id":"example"}'
```

- Run it in a terminal where the variables are set. Do not pass secrets with the Inspector's
  `-e` option: they would appear in the command line.
- Under `--tool-mode discover`, call `describe_operation` and then `call_operation`.
- Exit code 5 means the tool returned an error; its text is in the output.
- Never call a write to test it.

## When the host behaves differently

If the Inspector call works and the host call does not, the difference is the host's
environment: `PATH`, variables, working directory or timeouts. Compare them with the host file.

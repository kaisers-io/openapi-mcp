# Correcting a spec with an OpenAPI Overlay

This page shows how to fix one detail of a spec you cannot change, and how to check the
result before you serve it. You need it when a tool fails because the spec is wrong, or when a
description is too poor for a model to pick the right tool.

Sometimes one detail of an API description is wrong or unhelpful. A property the API returns
as `null` may be declared as `string`, or an operation description may be too short for a model
to pick the right tool. `openapi-mcp` serves the spec as it is and validates strictly against
it, so the fix belongs in the spec.

When you cannot change the upstream spec, an
[OpenAPI Overlay](https://spec.openapis.org/overlay/v1.2.0.html) describes the fix as a
separate document you can review. An overlay is a list of ordered actions, each with a JSONPath
`target`. An external tool applies it and writes a new spec file, which `openapi-mcp` then
loads like any other. `openapi-mcp` itself does not read overlays. The flow has three steps:

1. You write an overlay for the original spec.
2. `vacuum apply-overlay` writes a corrected spec.
3. You run `openapi-mcp tools` or `openapi-mcp serve` on the corrected spec.

If the problem is only nullability, try `--nullable-response-fields` first (see
[Requests and responses](requests-and-responses.md)). It admits `null` in response properties
without changing the spec. Use an overlay when the fix must be narrower than that flag, or is
not about `null`.

## Tool

The recipes use [vacuum](https://quobix.com/vacuum/) 0.35.1, which applies Overlay 1.2.0
documents, including reusable actions. Pin the version: the commands and the behaviour on this
page were checked against it.

```sh
npx @quobix/vacuum@0.35.1 apply-overlay --help
```

vacuum declares Node.js 24.16 or newer. Its documentation also lists standalone installs.
What vacuum checks, and what it does not:

- An action whose `target` matches nothing is a warning. `--fail-on-warnings` turns it into
  exit code 2. The Overlay specification allows an empty match, so without that flag a typo in
  a target goes unnoticed.
- An update that does not fit the target, for example a string replaced by an array, is an
  error, as Overlay 1.2 requires.
- vacuum does not report how many nodes a target matched. A target broader than intended
  (`$..note`) succeeds and changes every match. The diff in step 2 of
  [Checking the result](#checking-the-result) is how you catch it.
- vacuum still writes the output file when it fails. Discard the output whenever the exit code
  is not 0.
- vacuum accepts any `overlay: 1.x` version. Declare `overlay: 1.2.0` and use only 1.2
  features.

The output keeps the input's JSON formatting: 2-space indentation, and the key order except
for keys an action removes and sets again. A plain `diff` therefore shows only the changed
lines, plus the last line, because vacuum does not end the file with a newline. vacuum
re-indents YAML input, so compare YAML with `diff -w`.

## Recipes

The example files are in [`docs/overlays/`](overlays/). `shop-3.1.json` and `shop-3.0.json`
describe the same small API in OpenAPI 3.1 and 3.0. The spec declares `Order.note` as a
required `string`, but the API returns `null` when the customer left no note, so `getOrder`
fails with an output validation error. Run the commands from `docs/overlays/`.

### 1. A clearer operation description

[`describe-get-order.overlay.yaml`](overlays/describe-get-order.overlay.yaml):

```yaml
overlay: 1.2.0
info:
  title: Shop — clearer getOrder description
  version: 1.0.0
actions:
  - target: $.paths['/orders/{id}'].get
    description: Replace the one-word description the model sees for getOrder.
    update:
      description: Get one order by its ID. `note` is the customer's free-text note.
```

```sh
npx @quobix/vacuum@0.35.1 apply-overlay --fail-on-warnings --no-style shop-3.1.json describe-get-order.overlay.yaml shop-3.1.described.json
```

### 2. One response property that can be `null`

Target the property itself, not a pattern. `Order` appears only in responses, while the
request body of `createOrder` uses `OrderInput`, which also has a `note`. A target such as
`$..properties.note` would also make `null` valid as input, and would loosen `Customer.note`.

OpenAPI 3.1 writes nullability as a type array. An overlay update cannot replace the string
`"string"` with an array, so the first action removes the old `type` and the second sets the
new one. Actions run in order. In the other order, the update fails.
[`nullable-order-note-3.1.overlay.yaml`](overlays/nullable-order-note-3.1.overlay.yaml):

```yaml
overlay: 1.2.0
info:
  title: Shop — Order.note can be null (OpenAPI 3.1)
  version: 1.0.0
actions:
  - target: $.components.schemas.Order.properties.note.type
    remove: true
  - target: $.components.schemas.Order.properties.note
    update:
      type: [string, 'null']
```

```sh
npx @quobix/vacuum@0.35.1 apply-overlay --fail-on-warnings --no-style shop-3.1.json nullable-order-note-3.1.overlay.yaml shop-3.1.nullable-note.json
```

OpenAPI 3.0 has `nullable: true` instead, which a single update adds.
[`nullable-order-note-3.0.overlay.yaml`](overlays/nullable-order-note-3.0.overlay.yaml):

```yaml
overlay: 1.2.0
info:
  title: Shop — Order.note can be null (OpenAPI 3.0)
  version: 1.0.0
actions:
  - target: $.components.schemas.Order.properties.note
    update:
      nullable: true
```

```sh
npx @quobix/vacuum@0.35.1 apply-overlay --fail-on-warnings --no-style shop-3.0.json nullable-order-note-3.0.overlay.yaml shop-3.0.nullable-note.json
```

The repository contains the corrected specs these commands produce, next to the inputs, so
you can compare your output with them.

## Checking the result

1. **Exit code.** Any exit code other than 0 means the overlay did not apply as written.
   Delete the output and fix the overlay.
2. **Diff.** Only the lines you meant to change may differ, apart from the missing newline at
   the end:

   ```sh
   diff -u shop-3.1.json shop-3.1.nullable-note.json
   ```

   For recipe 2 that is the `note` property of `Order`, nothing else. A change in a request
   schema, a security requirement, a server URL or another property means the target was
   too broad.

3. **Inventory.** The corrected spec must expose the same operations, with the same
   authentication hints, as the original. Run `tools` with a throwaway cache. Against your
   real cache, `tools` would accept a new file without review, or keep listing the older
   version of a file it accepted before (see below). `openapi-mcp` keeps its cache under the
   home directory, so a temporary `HOME` gives it an empty one. On Windows, set `USERPROFILE`
   instead:

   ```sh
   REVIEW_HOME="$(mktemp -d)"
   HOME="$REVIEW_HOME" openapi-mcp --json tools --spec shop-3.1.json --allow 'operationId:*'
   HOME="$REVIEW_HOME" openapi-mcp --json tools --spec shop-3.1.nullable-note.json --allow 'operationId:*'
   ```

   Both outputs must be the same, apart from `source`, `contentHash` and the `summary` and
   `description` texts the overlay meant to change. Delete `$REVIEW_HOME` afterwards.

4. **Validation.** `tools` and `serve` validate the corrected spec as strictly as any other.
   An overlay cannot switch that off.

## Serving the corrected spec

Point `--spec` at the corrected file. Keep the original and the overlay next to it under
version control, so the change stays reviewable. Record where each came from with the
`sha256sum` of the original, the overlay and the corrected file. In the throwaway-cache run of
step 3, `contentHash` is the same SHA-256 of the corrected file.

`openapi-mcp` treats the corrected file like any spec source: the first `serve` or `tools` run
accepts it. When you regenerate the file and its content changes, both commands keep using the
accepted version and store the new one as a candidate, unless you pass `--trust-spec-updates`.
Until you promote the candidate, `tools` still lists the accepted inventory, and its
`contentHash` is the accepted file's SHA-256. `candidateContentHash` names the pending version
in the cache; it is not a file checksum. Review the new file with steps 1 to 3, throwaway cache
included. Then accept it with the candidate hash that `openapi-mcp cache list` shows (see
[Spec updates and the cache](spec-updates.md)):

```sh
openapi-mcp cache list
openapi-mcp cache promote --spec shop-3.1.nullable-note.json --hash <candidate hash>
```

## Limits

- `openapi-mcp` rejects a `$ref` to another document, so the corrected spec must be a single
  document. vacuum's output is a single document when its input is.
- `openapi-mcp` does not check an overlay or spec that vacuum fetches from a URL. vacuum
  fetches it without `openapi-mcp`'s egress checks. Review overlays like code.

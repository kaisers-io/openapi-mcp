# Correcting a spec with an OpenAPI Overlay

Sometimes one detail of an API description is wrong or unhelpful: a property the API returns
as `null` although the schema says `string`, or an operation description too short for a
model to pick the right tool. `openapi-mcp` serves the spec as it is and validates strictly
against it, so the fix belongs in the spec.

When you cannot change the upstream spec, an
[OpenAPI Overlay](https://spec.openapis.org/overlay/v1.2.0.html) describes the fix as a
separate, reviewable document: ordered actions, each with a JSONPath `target`. An external
tool applies it and writes a new spec file, which `openapi-mcp` then loads like any other.
`openapi-mcp` itself does not read overlays.

```
original spec + overlay ──(vacuum apply-overlay)──▶ corrected spec ──▶ openapi-mcp tools / serve
```

Before you write an overlay for nullability: `--nullable-response-fields` (see
[configuration](configuration.md)) admits `null` in response properties without changing the
spec. Use an overlay when the fix must be narrower than that flag, or is not about `null`.

## Tool

The recipes use [vacuum](https://quobix.com/vacuum/) **0.35.1**, which applies Overlay
**1.2.0** documents, including reusable actions. Pin the version: the commands and the
behaviour described here were checked against it.

```sh
npx @quobix/vacuum@0.35.1 apply-overlay --help
```

vacuum declares Node.js 24.16 or newer; its documentation also lists standalone installs.
What it does and does not check:

- An action whose `target` matches nothing is a warning. `--fail-on-warnings` turns it into
  exit code 2. The spec allows an empty match, so without that flag a typo in a target goes
  unnoticed.
- An update that does not fit the target (for example a string replaced by an array) is an
  error, as Overlay 1.2 requires.
- It does **not** report how many nodes a target matched. A target broader than intended
  (`$..note`) succeeds and changes every match. The diff in step 2 is how you catch it.
- When it fails it still writes the output file. Discard the output whenever the exit code is
  not 0.
- It accepts any `overlay: 1.x` version. Declare `overlay: 1.2.0` and use only 1.2 features.

The output keeps the input's JSON formatting (2-space indentation, key order except for keys
an action removes and sets again), so a plain `diff` shows only the changed lines, plus the
last line: vacuum does not end the file with a newline. YAML input is re-indented, so compare
YAML with `diff -w`.

## Recipes

The example files are in [`docs/overlays/`](overlays/). `shop-3.1.json` and `shop-3.0.json`
describe the same small API in OpenAPI 3.1 and 3.0. `Order.note` is declared as a required
`string`, but the API returns `null` when the customer left no note, so `getOrder` fails with
an output validation error. Run the commands from `docs/overlays/`.

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

Target the property itself, not a pattern: `Order` is used only in responses, while the
request body of `createOrder` uses `OrderInput`, which also has a `note`. A target such as
`$..properties.note` would also make `null` valid as input, and loosen `Customer.note`.

OpenAPI 3.1 writes nullability as a type array. An overlay update cannot replace the string
`"string"` with an array, so the first action removes the old `type` and the second sets the
new one. Actions run in order; swapped, the update fails.
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

OpenAPI 3.0 has `nullable: true` instead, which one update adds.
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

The corrected specs these commands produce are committed next to the inputs, so you can
compare your output with them.

## Checking the result

1. **Exit code.** Anything but 0 means the overlay did not apply as written: delete the output
   and fix the overlay.
2. **Diff.** Only the lines you meant to change may differ, besides the missing newline at
   the end:

   ```sh
   diff -u shop-3.1.json shop-3.1.nullable-note.json
   ```

   For recipe 2 that is the `note` property of `Order`, nothing else. A change in a request
   schema, a security requirement, a server URL or another property means the target was
   too broad.

3. **Inventory.** The corrected spec must expose the same operations, with the same
   authentication hints, as the original. Run `tools` with a throwaway cache: against your
   real cache, `tools` would accept a new file unreviewed, or, for a file it accepted
   before, keep listing that older version (see below). `openapi-mcp` keeps its cache under
   the home directory, so a temporary `HOME` gives it an empty one (on Windows, set
   `USERPROFILE` instead):

   ```sh
   REVIEW_HOME="$(mktemp -d)"
   HOME="$REVIEW_HOME" openapi-mcp --json tools --spec shop-3.1.json --allow 'operationId:*'
   HOME="$REVIEW_HOME" openapi-mcp --json tools --spec shop-3.1.nullable-note.json --allow 'operationId:*'
   ```

   Apart from `source`, `contentHash` and the `summary` and `description` texts an overlay
   meant to change, both outputs must be the same. Delete
   `$REVIEW_HOME` afterwards.

4. **Validation.** `tools` and `serve` validate the corrected spec as strictly as any other;
   an overlay cannot switch that off.

## Serving the corrected spec

Point `--spec` at the corrected file and keep the original and the overlay under version
control next to it, so the change stays reviewable. Record where each came from with
`sha256sum` of the original, the overlay and the corrected file. In the throwaway-cache run
of step 3, `contentHash` is the same SHA-256 of the corrected file.

`openapi-mcp` treats the corrected file like any spec source: the first `serve` or `tools`
run accepts it. When you regenerate it and the content changes, both keep using the accepted
version and store the new one as a candidate (unless you pass `--trust-spec-updates`). Until
it is promoted, `tools` still lists the accepted inventory, and its `contentHash` is the
accepted file's SHA-256; `candidateContentHash` names the pending version in the cache, not a
file checksum. Review the new file with steps 1 to 3, throwaway cache included, then accept it
with the candidate hash that `openapi-mcp cache list` shows:

```sh
openapi-mcp cache list
openapi-mcp cache promote --spec shop-3.1.nullable-note.json --hash <candidate hash>
```

Limits:

- `openapi-mcp` rejects `$ref`s to other documents, so the corrected spec must be a single
  document; vacuum's output is one when its input is.
- An overlay or spec fetched from a URL is outside `openapi-mcp`'s trust boundary: vacuum
  fetches it without `openapi-mcp`'s egress checks. Review overlays like code.

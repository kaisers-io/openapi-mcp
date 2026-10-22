# Changelog

## Unreleased

### Changed

- **Request bodies with `minProperties`/`maxProperties` are now a single `body` field (#71).**
  These operations used to be omitted. They are now generated, and the body is not flattened
  into top-level fields, so the property-count constraint can be enforced. The common case
  is a PATCH body with `minProperties: 1`: its tool takes `{ "body": { … } }` instead of
  flattened fields. The change is visible in `tools/list`.

- **Upstream connections are reused (#51).** Tool calls share a bounded pool of pinned
  keep-alive connections per origin and trust policy instead of opening a new TCP/TLS
  connection per call. DNS is still validated for every new socket; an idle connection is
  closed after 30 s and every pooled agent is re-resolved after 5 min.

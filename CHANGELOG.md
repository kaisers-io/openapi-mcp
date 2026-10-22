# Changelog

## Unreleased

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

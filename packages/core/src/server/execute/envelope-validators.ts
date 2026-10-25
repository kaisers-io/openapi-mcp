import { createHash } from 'node:crypto';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Options, ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// The per-tool output validators the executor checks every response envelope
// against (see mapResponse in response.ts).

// CJS interop mirror of spec/validate.ts's unwrapDefault/AjvConstructor
// pattern: TypeScript under nodenext types these CJS default imports as
// namespaces without construct/call signatures, while at runtime the binding
// (and its .default) is the class/function in every module system in play.
// Kept as a LOCAL mirror rather than a shared import: envelope compilation
// stays executor-local, not entangled with spec/validate.ts's
// meta-schema-validator cache — an unrelated cache key (the two official
// OpenAPI meta-schemas vs. one compiled validator per tool outputSchema).
type AjvInstance = {
  compile: (schema: object) => ValidateFunction;
};
type AjvConstructor = new (opts: Options) => AjvInstance;

const unwrapDefault = <Unwrapped>(moduleValue: unknown): Unwrapped => {
  const withDefault = moduleValue as { default?: Unwrapped };
  return withDefault.default ?? (moduleValue as Unwrapped);
};

const Ajv2020 = unwrapDefault<AjvConstructor>(Ajv2020Module);
const addFormats = unwrapDefault<(ajv: AjvInstance) => unknown>(addFormatsModule);

export type EnvelopeValidator = (envelope: unknown) => boolean;

export type EnvelopeCompiler = (
  outputSchema: Record<string, unknown> | undefined,
) => EnvelopeValidator | undefined;

// One compiler context for a whole server snapshot (issue
// kaisers-io/openapi-mcp-archive#42). A fresh Ajv instance per tool compiled
// the draft 2020-12 META-schema again for every tool (Ajv compiles it lazily,
// the first time an instance validates a schema against it): about 85% of the
// per-tool cost, 5.9 s for 500 tools. Sharing one instance pays that once.
//
// Scoped, not global: the caller creates one per snapshot, so the compiled
// validators it retains live exactly as long as the server that uses them and
// two servers never share state. `addUsedSchema: false` keeps compiled
// schemas out of the instance's id registry, so two tools whose schemas carry
// the same `$id` cannot collide (Ajv throws on a duplicate id otherwise). The
// options are otherwise those of the per-tool instance, so validation results
// are identical.
//
// `code.optimize: false` skips Ajv's pass over the generated code, which only
// removes unused variables and empty blocks: validation results are
// unchanged and a validation costs at most about 1 µs more, but the pass took
// about 60% of compile time on the GitHub REST description (issue #6). Ajv
// documents the option for exactly this case, "when schema compilation time
// is more important".
//
// Identical schemas share one compiled validator (issue #7). Many operations
// return the same envelope (for GitHub `--allow tag:repos`, 100 distinct
// schemas among 138 tools), but Ajv's own cache is keyed by object identity
// and every tool has its own schema object. The key is a SHA-256 of the
// serialized schema, so the serialization itself is not kept in memory.
// Ajv's result depends only on the schema and this instance's options, and a
// validator keeps no state between calls that a caller here reads (only the
// boolean result is used).
//
// Each call compiles eagerly, so an incompatible outputSchema throws AT the
// call. `undefined` in, `undefined` out: a tool with no outputSchema has
// nothing to validate against.
export const createEnvelopeCompiler = (): EnvelopeCompiler => {
  const ajv = new Ajv2020({ strict: false, addUsedSchema: false, code: { optimize: false } });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();
  return (outputSchema): EnvelopeValidator | undefined => {
    if (outputSchema === undefined) {
      return undefined;
    }
    const key = createHash('sha256').update(JSON.stringify(outputSchema)).digest('base64');
    let validate = compiled.get(key);
    if (validate === undefined) {
      validate = ajv.compile(outputSchema);
      compiled.set(key, validate);
    }
    const shared = validate;
    return (envelope: unknown): boolean => shared(envelope) === true;
  };
};

// The per-tool validator lookup the executor uses: `has` says whether a tool
// is registered at all (fail-closed, see executor.ts), `get` returns its
// validator, `undefined` for a tool without an outputSchema. `get` may throw
// when the validator is compiled on demand (lazyEnvelopeValidators); the
// executor calls it before it sends anything upstream.
export type EnvelopeValidators = {
  has: (toolName: string) => boolean;
  get: (toolName: string) => EnvelopeValidator | undefined;
};

// Compiles each tool's validator on first use instead of at startup (issue
// #8). In `--tool-mode discover` a server can expose up to 4,096 operations,
// and compiling all of them before `initialize` took longer than common host
// start-up timeouts, while a session usually calls a handful. The result of
// the first compile, validator or error, is kept, so a schema Ajv refuses
// fails the same way on every call and is never compiled twice. `onError`
// sees that error once, for the operator's log.
export const lazyEnvelopeValidators = (
  compile: EnvelopeCompiler,
  outputSchemas: ReadonlyMap<string, Record<string, unknown> | undefined>,
  onError?: (toolName: string, error: unknown) => void,
): EnvelopeValidators => {
  const settled = new Map<
    string,
    { validator: EnvelopeValidator | undefined } | { error: unknown }
  >();
  return {
    has: (toolName) => outputSchemas.has(toolName),
    get: (toolName) => {
      let entry = settled.get(toolName);
      if (entry === undefined) {
        try {
          entry = { validator: compile(outputSchemas.get(toolName)) };
        } catch (error) {
          entry = { error };
          onError?.(toolName, error);
        }
        settled.set(toolName, entry);
      }
      if ('error' in entry) {
        throw entry.error;
      }
      return entry.validator;
    },
  };
};

// A single validator with a context of its own. Prefer createEnvelopeCompiler
// for more than one tool.
export const compileEnvelopeValidator = (
  outputSchema: Record<string, unknown> | undefined,
): EnvelopeValidator | undefined => createEnvelopeCompiler()(outputSchema);

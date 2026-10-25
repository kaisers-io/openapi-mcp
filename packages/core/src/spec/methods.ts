// `query` (OpenAPI 3.2, RFC 10008) last, so specs without it keep their order
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'query'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// OPTIONS and TRACE operations are never exposed
export const NEVER_EXPOSED_METHODS = ['options', 'trace'] as const;

// A method from OpenAPI 3.2 `additionalOperations` (issue #33), sent exactly
// as declared. Only upper-case names are mapped, so every place that shows,
// filters or sends `method.toUpperCase()` sees the declared name unchanged.
export type AdditionalMethod = Uppercase<string>;
export type OperationMethod = HttpMethod | AdditionalMethod;

// Methods `additionalOperations` may not declare: those with their own Path
// Item field (OAS 3.2.1 §4.9.1), and the never-exposed ones. CONNECT opens a
// tunnel and TRACK echoes the request like TRACE; fetch refuses all three.
const RESERVED_ADDITIONAL_METHODS: ReadonlySet<string> = new Set([
  ...HTTP_METHODS.map((method) => method.toUpperCase()),
  ...NEVER_EXPOSED_METHODS.map((method) => method.toUpperCase()),
]);
const NEVER_EXPOSED_ADDITIONAL_METHODS: ReadonlySet<string> = new Set(['CONNECT', 'TRACK']);

// RFC 9110 §9.1: a method is a token (1*tchar)
const METHOD_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

// A method name from `additionalOperations` is spec text, shown in omissions
export const METHOD_NAME_MAX_LENGTH = 32;

// Why an `additionalOperations` key is not mapped, or undefined when it is.
// The official meta-schema checks the token and the fixed-field names, but a
// cached document is not revalidated, so both are checked here as well.
export const additionalMethodProblem = (name: string): string | undefined => {
  if (!METHOD_TOKEN_RE.test(name)) {
    return 'additionalOperations key is not a valid HTTP method name';
  }
  // Every registered method is far shorter (IANA HTTP Method Registry)
  if (name.length > METHOD_NAME_MAX_LENGTH) {
    return `additionalOperations method names longer than ${METHOD_NAME_MAX_LENGTH} characters are not supported`;
  }
  const upper = name.toUpperCase();
  if (NEVER_EXPOSED_ADDITIONAL_METHODS.has(upper)) {
    return `${upper} operations are never exposed`;
  }
  if (name !== upper) {
    return 'additionalOperations methods that are not upper case are not supported';
  }
  if (RESERVED_ADDITIONAL_METHODS.has(upper)) {
    return `${upper} must be declared by its own Path Item field, not in additionalOperations`;
  }
  return undefined;
};

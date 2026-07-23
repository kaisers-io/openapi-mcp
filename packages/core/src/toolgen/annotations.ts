import type { HttpMethod } from '../spec/normalize.ts';

// SDK-neutral tool annotations (mirrors MCP's ToolAnnotations hint fields).
// This module never imports the SDK; server/sdk-v1/protocol.ts casts these
// to the SDK's own type at the one boundary that needs it. All fields are
// advisory HINTS, not an enforcement mechanism — filtering is the enforcement
// layer (README); a client MUST NOT make authorization decisions from them.
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Our own HTTP-method heuristic — the spec defines no method->annotation
// mapping. GET/HEAD are read-only, so `idempotentHint` is omitted rather than
// set true: it is meaningful only when `readOnlyHint` is false (per the MCP
// ToolAnnotations JSDoc). PUT/DELETE are destructive AND idempotent (repeating
// the same call has no additional effect). POST/PATCH are destructive but NOT
// assumed idempotent. `openWorldHint` is always true: every generated tool
// calls an external HTTP API.
export const deriveAnnotations = (method: HttpMethod): ToolAnnotations => {
  switch (method) {
    case 'get':
    case 'head': {
      return { readOnlyHint: true, openWorldHint: true };
    }
    case 'put':
    case 'delete': {
      return { destructiveHint: true, idempotentHint: true, openWorldHint: true };
    }
    case 'post':
    case 'patch': {
      return { destructiveHint: true, openWorldHint: true };
    }
  }
};

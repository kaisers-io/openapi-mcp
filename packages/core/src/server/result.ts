import type { CallEffect } from './effect.ts';

// SDK-neutral domain result type. Mirrors the shape MCP's CallToolResult
// needs WITHOUT importing the SDK — server/sdk/protocol.ts is the only
// place that ever imports the SDK's own CallToolResult type and maps this
// onto it.
export type TextBlock = { type: 'text'; text: string };
// An image an upstream returned (#14): base64 bytes and their media type.
// Only ever after a text block, so code that reads or amends the first
// block always meets text.
export type ImageBlock = { type: 'image'; data: string; mimeType: string; text?: undefined };
export type ContentBlock = TextBlock | ImageBlock;

export type ToolCallOutcome = {
  isError: boolean;
  content: readonly ContentBlock[];
  structuredContent?: Record<string, unknown>;
  // Result metadata, mapped onto CallToolResult `_meta`. Used for
  // machine-readable details of an ERROR result: structuredContent must
  // conform to the tool's outputSchema when one is declared (MCP tools spec,
  // "Output Schema"), and an error detail never does.
  meta?: Record<string, unknown>;
  // Server-internal facts about a call's effect (issue #25, server/effect.ts).
  // Plain data, so every `{ ...outcome }` copy keeps it; never sent: the
  // protocol adapter maps only the fields above.
  effectNote?: EffectNote;
};

export type EffectNote = {
  // The text already carries the warning against a blind retry
  warned?: true;
  // The text claims a reported success; use this one if the effect is unknown
  uncertainText?: string;
  // A success's effect, for a boundary that may still withhold it
  successEffect?: CallEffect;
};

// Structured results that an executor has ALREADY scanned for secrets in
// full, keyed by the redactor that scanned them. The dispatch boundary skips
// its own (identical) tree scan only for an object scanned by the very same
// redactor instance, so the defense-in-depth scan still runs for every other
// executor, and for a different secret set. A WeakMap holds no reference
// that outlives the result.
const scannedBy = new WeakMap<object, unknown>();

export const markSecretScanned = (value: object, redactor: unknown): void => {
  scannedBy.set(value, redactor);
};

export const wasSecretScanned = (value: object, redactor: unknown): boolean =>
  scannedBy.get(value) === redactor;

export const textOutcome = (text: string, isError = false): ToolCallOutcome => ({
  isError,
  content: [{ type: 'text', text }],
});

export const structuredOutcome = (
  text: string,
  structuredContent: Record<string, unknown>,
): ToolCallOutcome => ({
  isError: false,
  content: [{ type: 'text', text }],
  structuredContent,
});

// A machine-readable refusal a client can act on: `error` is a small closed
// code and `retryAfterMs` says when a retry can succeed. Only ever used for
// LOCAL admission refusals (rate limit, overload) — values this server
// computes itself, never upstream-derived text. Carried in `_meta` under
// this server's own key prefix (MCP `_meta` key grammar: `<prefix>/<name>`),
// never in structuredContent — see ToolCallOutcome.meta above.
export type RetryableError = {
  error: 'rate_limited' | 'overloaded';
  retryAfterMs: number;
};

// The text appends "; retry after <n>s" in whole seconds, never "0s": a
// sub-second wait still reads as "1s" (the exact value is in retryAfterMs).
export const retryableErrorOutcome = (
  message: string,
  detail: RetryableError,
): ToolCallOutcome => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: `${message}; retry after ${Math.max(1, Math.ceil(detail.retryAfterMs / 1000))}s`,
    },
  ],
  meta: {
    'openapi-mcp/error': detail.error,
    'openapi-mcp/retryAfterMs': detail.retryAfterMs,
  },
});

// The lookup step's own outcome: an unknown tool name is a PROTOCOL error
// (InvalidParams — the tool NAME is what's invalid, not the tools/call
// METHOD, which exists and dispatched fine), never a ToolCallOutcome — the
// protocol adapter maps `unknown-tool` to McpError and everything else to
// CallToolResult.
export type DispatchResult =
  | { kind: 'outcome'; outcome: ToolCallOutcome }
  | { kind: 'unknown-tool'; name: string };

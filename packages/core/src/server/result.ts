// SDK-neutral domain result type. Mirrors the shape MCP's CallToolResult
// needs WITHOUT importing the SDK — server/sdk/protocol.ts is the only
// place that ever imports the SDK's own CallToolResult type and maps this
// onto it.
export type ToolCallOutcome = {
  isError: boolean;
  content: readonly { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
};

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

// A machine-readable refusal a client (or the model) can act on: `error` is
// a small closed code and `retryAfterMs` says when a retry can succeed. Only
// ever used for LOCAL admission refusals (rate limit, overload) — values
// this server computes itself, never upstream-derived text.
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
  structuredContent: { ...detail },
});

// The lookup step's own outcome: an unknown tool name is a PROTOCOL error
// (InvalidParams — the tool NAME is what's invalid, not the tools/call
// METHOD, which exists and dispatched fine), never a ToolCallOutcome — the
// protocol adapter maps `unknown-tool` to McpError and everything else to
// CallToolResult.
export type DispatchResult =
  | { kind: 'outcome'; outcome: ToolCallOutcome }
  | { kind: 'unknown-tool'; name: string };

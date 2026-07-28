// SDK-neutral domain result type. Mirrors the shape MCP's CallToolResult
// needs WITHOUT importing the SDK — server/sdk-v1/protocol.ts is the only
// place that ever imports the SDK's own CallToolResult type and maps this
// onto it.
export interface ToolCallOutcome {
  isError: boolean;
  content: readonly { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
}

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

// The lookup step's own outcome: an unknown tool name is a PROTOCOL error
// (InvalidParams — the tool NAME is what's invalid, not the tools/call
// METHOD, which exists and dispatched fine), never a ToolCallOutcome — the
// protocol adapter maps `unknown-tool` to McpError and everything else to
// CallToolResult.
export type DispatchResult =
  | { kind: 'outcome'; outcome: ToolCallOutcome }
  | { kind: 'unknown-tool'; name: string };

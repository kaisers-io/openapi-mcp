// W3C Trace Context carried in a request's `_meta` (MCP reserves the bare
// `traceparent` / `tracestate` keys for OpenTelemetry propagation) and
// forwarded to the upstream API as the same-named headers, so an operator
// can follow one tool call into the API it wraps.
//
// Both values come from the MCP client, so they are validated strictly
// before they can become outbound header values: anything malformed is
// dropped (W3C: a vendor receiving an invalid traceparent must not
// propagate it), and an invalid tracestate is dropped on its own.

export type TraceContext = {
  readonly traceparent?: string;
  readonly tracestate?: string;
};

// Version "00" only: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`,
// lowercase, with an all-zero trace-id or parent-id being invalid.
const TRACEPARENT_RE = /^00-(?<traceId>[\da-f]{32})-(?<parentId>[\da-f]{16})-[\da-f]{2}$/u;
const ALL_ZERO_RE = /^0+$/u;

// A tracestate list-member: `key=value`; key is a simple key or a
// tenant@system multi-tenant key, value is 1-256 printable ASCII chars
// other than `,` and `=`, not ending in a space. At most 32 members.
const TRACESTATE_MEMBER_RE =
  /^(?:[a-z][\d_a-z*/-]{0,255}|[\da-z][\d_a-z*/-]{0,240}@[a-z][\d_a-z*/-]{0,13})=[ -+--<>-~]{0,255}[!-+--<>-~]$/u;
const MAX_TRACESTATE_MEMBERS = 32;
const MAX_TRACESTATE_LENGTH = 512;

const validTraceparent = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const groups = TRACEPARENT_RE.exec(value)?.groups;
  if (
    groups === undefined ||
    ALL_ZERO_RE.test(groups['traceId'] ?? '') ||
    ALL_ZERO_RE.test(groups['parentId'] ?? '')
  ) {
    return undefined;
  }
  return value;
};

const validTracestate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > MAX_TRACESTATE_LENGTH) {
    return undefined;
  }
  const members = value
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member !== '');
  if (
    members.length === 0 ||
    members.length > MAX_TRACESTATE_MEMBERS ||
    !members.every((member) => TRACESTATE_MEMBER_RE.test(member))
  ) {
    return undefined;
  }
  return members.join(',');
};

// A tracestate is meaningful only alongside a valid traceparent.
export const traceContextFromMeta = (meta: unknown): TraceContext => {
  if (meta === null || typeof meta !== 'object') {
    return {};
  }
  const { traceparent, tracestate } = meta as Record<string, unknown>;
  const parent = validTraceparent(traceparent);
  if (parent === undefined) {
    return {};
  }
  const state = validTracestate(tracestate);
  return state === undefined ? { traceparent: parent } : { traceparent: parent, tracestate: state };
};

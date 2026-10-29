import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { sanitizeSpecText } from '../../spec/sanitize.ts';
import type { CallRequest, DispatcherDeps } from '../dispatch.ts';
import {
  CALL_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  lookupOperation,
  unknownOperationOutcome,
} from '../discovery.ts';
import {
  EXECUTE_INPUT_SCHEMA,
  EXECUTE_OUTPUT_SCHEMA,
  REFLECTED_NAME_MAX,
} from '../discovery-schemas.ts';
import type { ExecuteInput } from '../discovery-schemas.ts';
import { structuredOutcome, textOutcome } from '../result.ts';
import type { DispatchResult, ToolCallOutcome } from '../result.ts';
import type { SnapshotTool, ToolMode } from '../types.ts';
import { runScript, SCRIPT_LIMITS } from './run.ts';
import type { NestedCall } from './run.ts';

// The execute_code tool (issue #60). Its descriptions are the ones the tool
// was measured with in the evaluation (scripts/evals), so a change to them
// is a change to measure again. Under `per-operation` a script names an
// operation by its tool name; under `discover` by its call_operation name.
const executeDescription = (toolMode: ToolMode): string =>
  `Run JavaScript to combine several read-only operation calls in one step, for example paging, following ids, filtering or summing, so only the final answer comes back. \`code\` is the body of an async function. \`await api.call(name, args)\` calls one operation (${toolMode === 'discover' ? 'the same name and arguments as call_operation' : "an operation tool's name and the arguments that tool takes"}) and returns its result \`{ data, status?, contentType?, headers?, pagination? }\`, with the response body in \`data\`; it throws on an error. Use \`return\` to give back a JSON value, which becomes this tool's result; console.log output is returned too. Only read-only operations can be called; ${toolMode === 'discover' ? 'use call_operation for writes' : 'call write tools directly'}. No network, files, timers or modules. Limits: ${String(SCRIPT_LIMITS.calls)} api.call() per script, ${String(SCRIPT_LIMITS.ms / 1000)} s, a result of at most ${String(SCRIPT_LIMITS.resultBytes / 1000)} KB.`;

export const executeTool = (toolMode: ToolMode): SnapshotTool => ({
  kind: 'discovery',
  name: EXECUTE_TOOL_NAME,
  discovery: 'execute',
  inputSchema: EXECUTE_INPUT_SCHEMA,
  wireTool: {
    name: EXECUTE_TOOL_NAME,
    description: executeDescription(toolMode),
    inputSchema: z.toJSONSchema(EXECUTE_INPUT_SCHEMA),
    outputSchema: EXECUTE_OUTPUT_SCHEMA,
    // A script can only call read-only operations (executeCode below)
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
});

// The wait a rate-limited call names, or undefined for any other result
const retryAfter = (result: DispatchResult): number | undefined => {
  if (result.kind !== 'outcome' || result.outcome.meta?.['openapi-mcp/error'] !== 'rate_limited') {
    return undefined;
  }
  const wait = result.outcome.meta['openapi-mcp/retryAfterMs'];
  return typeof wait === 'number' ? Math.max(wait, 1) : 1000;
};

const jsonOrText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

// A result without an output schema is text: the body, then optional
// `headers:` and `pagination:` blocks (decorateTextOutcome). A script gets
// them in the shape of a structured result, the body in `data`, as the tool
// description promises.
// An image result (--image-responses inline) has no text a program could
// read, so it is undefined here and the call fails. Its first block is a
// text line about the image, so the image block is what tells it apart.
const textEnvelope = (outcome: ToolCallOutcome): Record<string, unknown> | undefined => {
  const [first, ...rest] = outcome.content;
  if (first?.type !== 'text' || rest.some((block) => block.type === 'image')) {
    return undefined;
  }
  const envelope: Record<string, unknown> = { data: jsonOrText(first.text) };
  for (const block of rest) {
    if (block.type !== 'text') {
      continue;
    }
    if (block.text.startsWith('headers:\n')) {
      envelope['headers'] = Object.fromEntries(
        block.text
          .slice('headers:\n'.length)
          .split('\n')
          .filter((line) => line.includes(': '))
          .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
      );
    } else if (block.text.startsWith('pagination: ')) {
      envelope['pagination'] = jsonOrText(block.text.slice('pagination: '.length));
    }
  }
  return envelope;
};

// The execute_code tool (issue #60). Every api.call() of the script is a whole
// tool call through the dispatcher (deps.dispatch): call_operation under
// `discover`, the operation's own tool under `per-operation`. The filters'
// exposed set, argument validation, the shared rate limit, the executor's
// egress and size rules and the dispatcher's final redaction apply to each
// one, and the script only ever sees a result that passed all of them. Only
// an exposed operation can be named, and one that is not read-only is
// refused before anything is sent.
export const executeCode = async (
  deps: DispatcherDeps,
  data: unknown,
  request: CallRequest,
): Promise<ToolCallOutcome> => {
  const { dispatch } = deps;
  if (dispatch === undefined) {
    return textOutcome('tool execution failed unexpectedly', true);
  }
  const discover = deps.snapshot.toolMode === 'discover';
  const nested: NestedCall = async (name, args, signal) => {
    const entry = lookupOperation(deps.snapshot.operationsByName, name);
    if (entry === undefined) {
      return {
        ok: false,
        error: discover
          ? (unknownOperationOutcome(name).content[0]?.text ?? '')
          : `unknown operation "${sanitizeSpecText(name, REFLECTED_NAME_MAX)}" — use the name of an operation tool`,
      };
    }
    if (entry.annotations.readOnlyHint !== true) {
      return {
        ok: false,
        error: `${entry.name} is not read-only: execute_code calls read-only operations only; ${discover ? 'use call_operation for it' : 'call its tool directly'}`,
      };
    }
    const target = args === undefined ? {} : { arguments: args };
    const send = () =>
      dispatch({
        ...(discover
          ? { name: CALL_TOOL_NAME, arguments: { name: entry.name, ...target } }
          : { name: entry.name, arguments: args ?? {} }),
        signal,
        textBytes: SCRIPT_LIMITS.receivedBytes,
        ...(request.trace === undefined ? {} : { trace: request.trace }),
      });
    let result = await send();
    // A call the rate limit stops waits for the time the limiter names and
    // goes again, so a program that reads many items slows down instead of
    // failing. The limiter still decides every call, and the program's own
    // deadline ends the wait (the signal).
    for (
      let wait = retryAfter(result);
      wait !== undefined && !signal.aborted;
      wait = retryAfter(result)
    ) {
      try {
        await sleep(wait, undefined, { signal });
      } catch {
        return { ok: false, error: 'cancelled' };
      }
      result = await send();
    }
    if (result.kind !== 'outcome') {
      return { ok: false, error: 'the call failed unexpectedly' };
    }
    const { outcome } = result;
    const text = outcome.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    if (outcome.isError === true) {
      return { ok: false, error: text };
    }
    const value = outcome.structuredContent ?? textEnvelope(outcome);
    return value === undefined
      ? {
          ok: false,
          error: `${entry.name} returned an image, which a program cannot read; call it directly`,
        }
      : { ok: true, value };
  };
  const report = await runScript((data as ExecuteInput).code, nested, request.signal);
  const { ok, ...payload } = report;
  return ok
    ? structuredOutcome(JSON.stringify(payload), payload)
    : textOutcome(JSON.stringify(payload), true);
};

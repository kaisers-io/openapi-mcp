import type { MetaExecutor } from './dispatch.ts';
import { structuredOutcome } from './result.ts';
import type { CallStats } from './telemetry.ts';

// The read-only `openapi_mcp_status` tool: the accepted spec and tool
// inventory, plus — when the server collects them — process-local call
// counters (reset on restart; see server/telemetry.ts).
export const createMetaExecutor =
  (options: { stats?: Pick<CallStats, 'summary'> } = {}): MetaExecutor =>
  (snapshot) => {
    const { meta } = snapshot;
    const payload = {
      specTitle: meta.specTitle,
      specVersion: meta.specVersion,
      displaySource: meta.displaySource,
      toolCount: meta.toolCount,
      omittedCount: meta.omittedCount,
      omittedReasons: meta.omittedReasons,
      acceptedContentHash: meta.acceptedContentHash,
      deadPatternCount: meta.deadPatternCount,
      ...(options.stats === undefined ? {} : { calls: options.stats.summary() }),
    };
    return Promise.resolve(structuredOutcome(JSON.stringify(payload), payload));
  };

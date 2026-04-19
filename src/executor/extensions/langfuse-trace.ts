/**
 * Langfuse trace propagation extension — stamps a2a.trace metadata on
 * outbound A2A dispatches so downstream agents (Quinn, etc.) can link
 * their Langfuse traces back to the originating workstacean invocation.
 *
 * The correlationId serves as the trace ID (it's the unique identifier
 * for the entire skill dispatch chain). The extension stamps it into
 * `params.metadata["a2a.trace"]` which Quinn reads on the receiving end
 * to set `caller_trace_id` in her Langfuse trace metadata.
 *
 * Extension URI: https://proto-labs.ai/a2a/ext/trace-v1
 */

import type { ExtensionInterceptor, ExtensionContext } from "../extension-registry.ts";
import { defaultExtensionRegistry } from "../extension-registry.ts";

const TRACE_URI = "https://proto-labs.ai/a2a/ext/trace-v1";

export function registerLangfuseTraceExtension(): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      ctx.metadata["a2a.trace"] = {
        traceId: ctx.correlationId,
        callerAgent: ctx.agentName,
        skill: ctx.skill,
        project: "protolabs",
      };
    },
  };

  defaultExtensionRegistry.register({
    uri: TRACE_URI,
    interceptor,
    description:
      "Trace v1: stamps Langfuse trace context on outbound A2A calls for cross-agent trace linking",
  });
}

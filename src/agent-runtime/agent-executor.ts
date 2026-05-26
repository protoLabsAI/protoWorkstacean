/**
 * AgentExecutor — runs a single agent invocation via @protolabsai/sdk.
 *
 * Each call to run() invokes the SDK's `query()` (which spawns the protoCLI
 * runtime), streams the response, and returns the final text result.
 *
 * Used by ProtoSdkExecutor, which wraps this for the IExecutor contract.
 * This is the lower layer — pure SDK-driven turn loop, no bus, no
 * SkillRequest shape.
 *
 * Gateway routing:
 *   All LLM calls go through the protoLabs gateway (LiteLLM Proxy).
 *   baseURL is set to process.env.LLM_GATEWAY_URL (default: http://gateway:4000/v1).
 *   The gateway maps model aliases (e.g. "claude-opus-4-6") to the actual provider.
 *
 * LangFuse tracing:
 *   correlationId from the BusMessage becomes the SDK session ID so every
 *   tool call and turn appears under the same trace in LangFuse.
 *
 * Tools:
 *   v1 ships with no workstacean-provided MCP tools — proto uses protoCLI's
 *   native built-ins (read/write/edit/shell/grep/glob/web_fetch) which are
 *   bundled into the SDK. Future iterations can re-introduce an embedded
 *   MCP server with workstacean-specific tools by reviving the
 *   createSdkMcpServer call removed in the GOAP cleanup.
 */

import { query, isSDKResultMessage } from "@protolabsai/sdk";
import type { SDKResultMessageSuccess, SDKResultMessageError, ExtendedUsage } from "@protolabsai/sdk";
import type { AgentDefinition } from "./types.ts";

export interface SkillProgressEvent {
  /** Discriminates between tool invocations and assistant text chunks. */
  eventType: "tool_call" | "text";
  /** Propagated trace ID from the originating bus message. */
  correlationId: string;
  /** Tool name — present when eventType === 'tool_call'. */
  toolName?: string;
  /** Text content — present when eventType === 'text'. */
  text?: string;
}

export interface AgentRunOptions {
  /** The prompt / task to send to the agent. */
  prompt: string;
  /** correlationId from the originating BusMessage — used as the session ID for tracing. */
  correlationId: string;
  /** Working directory for the agent's file operations. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * SDK session ID to resume from a previous run.
   * When set, the query() call passes this as `resume` to continue conversation context.
   */
  resume?: string;
  /** Optional callback invoked for each tool_use block and assistant text block in the stream. */
  onProgress?: (event: SkillProgressEvent) => void;
}

export interface AgentRunResult {
  /** Extracted text from the final result message. Empty string if no text found. */
  text: string;
  /** True if the SDK reported an error result. */
  isError: boolean;
  /** Raw stop reason from the SDK result message. */
  stopReason?: string;
  /** Token usage reported by the SDK. */
  usage?: ExtendedUsage;
  /** Number of agentic turns taken. */
  numTurns?: number;
  /**
   * SDK session ID from this run — use as `resume` on the next call to continue
   * the conversation within the same session context.
   */
  sessionId?: string;
}

/** Configuration for AgentExecutor shared across all agent runs. */
export interface AgentExecutorConfig {
  /** LLM gateway base URL (OpenAI-compat /v1 path). Default: process.env.LLM_GATEWAY_URL */
  gatewayUrl?: string;
  /** API key for the gateway. Default: process.env.OPENAI_API_KEY */
  gatewayApiKey?: string;
}

export class AgentExecutor {
  private readonly gatewayUrl: string | undefined;
  private readonly gatewayApiKey: string | undefined;

  constructor(
    private readonly agentDef: AgentDefinition,
    config: AgentExecutorConfig = {},
  ) {
    // If neither config nor env provides a gateway URL, leave undefined so the
    // SDK falls back to native Anthropic mode (ANTHROPIC_API_KEY). Avoids
    // hardwiring a container hostname that only exists in the homelab network.
    this.gatewayUrl = config.gatewayUrl ?? process.env.LLM_GATEWAY_URL;
    this.gatewayApiKey = config.gatewayApiKey ?? process.env.OPENAI_API_KEY;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, correlationId, cwd, resume, onProgress } = opts;

    const env: Record<string, string> = {};
    if (this.gatewayUrl) env.OPENAI_BASE_URL = this.gatewayUrl;
    if (this.gatewayApiKey) env.OPENAI_API_KEY = this.gatewayApiKey;

    const session = query({
      prompt,
      options: {
        model: this.agentDef.model,
        authType: this.gatewayUrl ? "openai" : "anthropic",
        permissionMode: "yolo",
        systemPrompt: this.agentDef.systemPrompt,
        maxSessionTurns: this.agentDef.maxTurns,
        // When resuming, the session ID comes from the previous run. Otherwise
        // use correlationId so LangFuse traces stay grouped under the same ID.
        ...(resume ? { resume } : { sessionId: correlationId }),
        cwd: cwd ?? process.cwd(),
        stderr: (line: string) => console.error(`[agent:${this.agentDef.name}:stderr]`, line),
        ...(this.agentDef.allowedTools?.length ? { allowedTools: this.agentDef.allowedTools } : {}),
        ...(this.agentDef.excludeTools?.length ? { excludeTools: this.agentDef.excludeTools } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    });

    let resultText = "";
    let isError = false;
    let stopReason: string | undefined;
    let usage: ExtendedUsage | undefined;
    let numTurns: number | undefined;

    for await (const message of session) {
      if (isSDKResultMessage(message)) {
        if (message.type === "result") {
          if ("result" in message) {
            const success = message as SDKResultMessageSuccess;
            resultText = success.result ?? "";
            const rawStopReason = (success as Record<string, unknown>).stop_reason;
            stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;
            usage = success.usage;
            numTurns = success.num_turns;
          } else if ("error" in message) {
            const errMsg = message as SDKResultMessageError;
            isError = true;
            resultText = String((errMsg as { error: unknown }).error ?? "Unknown error");
            usage = errMsg.usage;
            numTurns = errMsg.num_turns;
          }
          break;
        }
      }
      // Stream assistant content blocks for logging and progress events
      if (
        message.type === "assistant" &&
        "message" in message &&
        Array.isArray(message.message.content)
      ) {
        for (const block of message.message.content) {
          if (typeof block === "object" && block !== null && "type" in block) {
            if (block.type === "text" && "text" in block) {
              process.stdout.write(".");
              onProgress?.({ eventType: "text", correlationId, text: String((block as { text: unknown }).text) });
            } else if (block.type === "tool_use" && "name" in block) {
              onProgress?.({ eventType: "tool_call", correlationId, toolName: String((block as { name: unknown }).name) });
            }
          }
        }
      }
    }

    if (resultText.length > 0) process.stdout.write("\n");

    const sessionId = session.getSessionId();
    return { text: resultText, isError, stopReason, usage, numTurns, sessionId };
  }
}

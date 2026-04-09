/**
 * AgentExecutor — runs a single agent invocation via @protolabsai/sdk.
 *
 * Each call to run() spawns a proto CLI subprocess, passes the agent's
 * whitelisted tools as an embedded MCP server, streams the response, and
 * returns the final text result.
 *
 * Gateway routing:
 *   All LLM calls go through the protoLabs gateway (LiteLLM Proxy).
 *   baseURL is set to process.env.LLM_GATEWAY_URL (default: http://gateway:4000/v1).
 *   The gateway maps model aliases (e.g. "claude-opus-4-6") to the actual provider.
 *
 * LangFuse tracing:
 *   correlationId from the BusMessage becomes the proto CLI session ID so every
 *   tool call and turn appears under the same trace in LangFuse.
 */

import { query, createSdkMcpServer, isSDKResultMessage } from "@protolabsai/sdk";
import type { SDKResultMessageSuccess } from "@protolabsai/sdk";
import type { AgentDefinition } from "./types.ts";
import type { ToolRegistry } from "./tool-registry.ts";

export interface AgentRunOptions {
  /** The prompt / task to send to the agent. */
  prompt: string;
  /** correlationId from the originating BusMessage — used as the session ID for tracing. */
  correlationId: string;
  /** Working directory for the agent's file operations. Defaults to process.cwd(). */
  cwd?: string;
}

export interface AgentRunResult {
  /** Extracted text from the final result message. Empty string if no text found. */
  text: string;
  /** True if the SDK reported an error result. */
  isError: boolean;
  /** Raw stop reason from the SDK result message. */
  stopReason?: string;
}

/**
 * Configuration for AgentExecutor shared across all agent runs.
 */
export interface AgentExecutorConfig {
  /** LLM gateway base URL (OpenAI-compat /v1 path). Default: process.env.LLM_GATEWAY_URL */
  gatewayUrl?: string;
  /** API key for the gateway. Default: process.env.OPENAI_API_KEY */
  gatewayApiKey?: string;
}

export class AgentExecutor {
  private readonly gatewayUrl: string;
  private readonly gatewayApiKey: string | undefined;

  constructor(
    private readonly agentDef: AgentDefinition,
    private readonly toolRegistry: ToolRegistry,
    config: AgentExecutorConfig = {},
  ) {
    // If neither config nor env provides a gateway URL, leave undefined so the
    // SDK falls back to native Anthropic mode (ANTHROPIC_API_KEY). Avoids
    // hardwiring a container hostname that only exists in the homelab network.
    this.gatewayUrl =
      config.gatewayUrl ?? process.env.LLM_GATEWAY_URL;
    this.gatewayApiKey =
      config.gatewayApiKey ?? process.env.OPENAI_API_KEY;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, correlationId, cwd } = opts;
    const agentTools = this.toolRegistry.forAgent(this.agentDef.tools);

    // Build the embedded MCP server with this agent's whitelisted tools.
    // Only included if the agent has any tools — avoids registering an empty server.
    const mcpServers =
      agentTools.length > 0
        ? {
            workstacean: createSdkMcpServer({
              name: `workstacean-${this.agentDef.name}`,
              tools: agentTools,
            }),
          }
        : undefined;

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
        sessionId: correlationId,
        cwd: cwd ?? process.cwd(),
        stderr: (line: string) => console.error(`[agent:${this.agentDef.name}:stderr]`, line),
        ...(this.agentDef.allowedTools?.length ? { allowedTools: this.agentDef.allowedTools } : {}),
        ...(this.agentDef.excludeTools?.length ? { excludeTools: this.agentDef.excludeTools } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    });

    let resultText = "";
    let isError = false;
    let stopReason: string | undefined;

    for await (const message of session) {
      if (isSDKResultMessage(message)) {
        if (message.type === "result") {
          if ("result" in message) {
            // SDKResultMessageSuccess
            const success = message as SDKResultMessageSuccess;
            resultText = success.result ?? "";
            const rawStopReason = (success as Record<string, unknown>).stop_reason;
            stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;
          } else if ("error" in message) {
            // SDKResultMessageError
            isError = true;
            resultText = String((message as { error: unknown }).error ?? "Unknown error");
          }
        }
      }
      // Stream text blocks for logging / debugging
      if (
        message.type === "assistant" &&
        "message" in message &&
        Array.isArray(message.message.content)
      ) {
        for (const block of message.message.content) {
          if (typeof block === "object" && block !== null && "type" in block) {
            if (block.type === "text" && "text" in block) {
              // Progress visible in logs when running
              process.stdout.write(".");
            }
          }
        }
      }
    }

    if (resultText.length > 0) process.stdout.write("\n");

    return { text: resultText, isError, stopReason };
  }
}

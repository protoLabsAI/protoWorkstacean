/**
 * ProtoSdkExecutor — runs an in-process agent via @protolabsai/sdk.
 *
 * Wraps AgentExecutor. One instance per agent definition.
 * Registered by AgentRuntimePlugin during install().
 */

import { AgentExecutor } from "../../agent-runtime/agent-executor.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { ToolRegistry } from "../../agent-runtime/tool-registry.ts";
import type { AgentExecutorConfig } from "../../agent-runtime/agent-executor.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

export class ProtoSdkExecutor implements IExecutor {
  readonly type = "proto-sdk";

  private readonly executor: AgentExecutor;

  constructor(
    agentDef: AgentDefinition,
    toolRegistry: ToolRegistry,
    config: AgentExecutorConfig = {},
  ) {
    this.executor = new AgentExecutor(agentDef, toolRegistry, config);
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);

    const result = await this.executor.run({
      prompt,
      correlationId: req.correlationId,
    });

    const { cleanText, deltas } = this._extractWorldstateDeltas(result.text);

    return {
      text: cleanText,
      isError: result.isError,
      correlationId: req.correlationId,
      data: {
        usage: result.usage,
        numTurns: result.numTurns,
        stopReason: result.stopReason,
        ...(deltas.length > 0 ? { "x-effect-domain": { delta: deltas } } : {}),
      },
    };
  }

  /**
   * Extract <worldstate-delta> JSON blocks from agent text.
   *
   * Agents emit these blocks when they know they've changed system state:
   *   <worldstate-delta>
   *   [{"domain":"ci","path":"data.blockedPRs","delta":-1,"confidence":0.8}]
   *   </worldstate-delta>
   *
   * Returns the cleaned text (blocks stripped) and the parsed delta array.
   * Malformed JSON blocks are silently ignored.
   */
  private _extractWorldstateDeltas(text: string): {
    cleanText: string;
    deltas: Array<{ domain: string; path: string; delta: number; confidence: number }>;
  } {
    const pattern = /<worldstate-delta>([\s\S]*?)<\/worldstate-delta>/gi;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return { cleanText: text, deltas: [] };

    const deltas: Array<{ domain: string; path: string; delta: number; confidence: number }> = [];
    let cleanText = text;

    for (const match of matches) {
      try {
        const parsed: unknown = JSON.parse(match[1].trim());
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as Record<string, unknown>).domain === "string" &&
            typeof (entry as Record<string, unknown>).path === "string" &&
            typeof (entry as Record<string, unknown>).delta === "number" &&
            typeof (entry as Record<string, unknown>).confidence === "number"
          ) {
            deltas.push(entry as { domain: string; path: string; delta: number; confidence: number });
          }
        }
      } catch {
        // Malformed JSON — skip silently
      }
      cleanText = cleanText.replace(match[0], "").trim();
    }

    return { cleanText, deltas };
  }

  private _buildPrompt(req: SkillRequest): string {
    const lines = [`Execute skill: ${req.skill}`];
    const ctx = Object.entries(req.payload)
      .filter(([k]) => !["skill", "replyTopic", "correlationId", "parentId"].includes(k))
      .map(([k, v]) => {
          if (typeof v !== "object") return `${k}: ${String(v)}`;
          try { return `${k}: ${JSON.stringify(v)}`; } catch { return `${k}: [unserializable]`; }
        });
    if (ctx.length > 0) lines.push("", "Context:", ...ctx);
    return lines.join("\n");
  }
}

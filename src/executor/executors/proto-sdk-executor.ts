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
import type { EventBus } from "../../../lib/types.ts";

export class ProtoSdkExecutor implements IExecutor {
  readonly type = "proto-sdk";

  private readonly executor: AgentExecutor;
  private readonly bus?: EventBus;

  constructor(
    agentDef: AgentDefinition,
    toolRegistry: ToolRegistry,
    config: AgentExecutorConfig = {},
    bus?: EventBus,
  ) {
    this.executor = new AgentExecutor(agentDef, toolRegistry, config);
    this.bus = bus;
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);
    const { bus } = this;
    const { correlationId } = req;

    const result = await this.executor.run({
      prompt,
      correlationId,
      resume: req.resume,
      onProgress: bus
        ? (event) => {
            bus.publish("skill.progress", {
              id: crypto.randomUUID(),
              correlationId,
              topic: "skill.progress",
              timestamp: Date.now(),
              payload: event,
            });
          }
        : undefined,
    });

    return {
      text: result.text,
      isError: result.isError,
      correlationId: req.correlationId,
      data: {
        usage: result.usage,
        numTurns: result.numTurns,
        stopReason: result.stopReason,
        sessionId: result.sessionId,
      },
    };
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

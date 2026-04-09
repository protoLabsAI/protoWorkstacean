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

    return {
      text: result.text,
      isError: result.isError,
      correlationId: req.correlationId,
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

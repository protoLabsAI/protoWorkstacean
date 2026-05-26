/**
 * ProtoSdkExecutor — runs an in-process agent via @protolabsai/sdk.
 *
 * Wraps AgentExecutor as an IExecutor so SkillDispatcherPlugin can dispatch
 * to it like any other executor. One instance per agent definition.
 * Registered by AgentRuntimePlugin during install() for agents whose yaml
 * declares `runtime: proto-sdk`.
 *
 * Why a separate runtime from DeepAgentExecutor: protoCLI is itself a full
 * coding agent with its own tool loop. Wrapping it inside a LangGraph ReAct
 * outer loop (DeepAgent) would be nested-agents with no integration win.
 * The SDK's `query()` call IS the agent runtime; this class just adapts
 * the SkillRequest → AgentExecutor.run() contract and publishes the
 * activity + progress events that the rest of workstacean expects.
 *
 * Bus events emitted:
 *   - `skill.progress.{correlationId}` (text chunks + tool-use markers from SDK stream)
 *   - `agent.runtime.activity.tool.call` (per tool_use, for /system dashboard)
 *
 * skill.start / skill.complete / skill.error are emitted by SkillDispatcherPlugin
 * around every executor call uniformly — not here.
 */

import { AgentExecutor } from "../../agent-runtime/agent-executor.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { AgentExecutorConfig } from "../../agent-runtime/agent-executor.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import type { EventBus } from "../../../lib/types.ts";

export interface ProtoSdkExecutorOptions extends AgentExecutorConfig {
  /**
   * Optional tool-call telemetry hook. Fired once per tool_use block in the
   * SDK stream — same callback shape AgentRuntimePlugin uses for DeepAgent,
   * so /system dashboard animation works uniformly across runtimes.
   */
  onToolCall?: (event: {
    agentName: string;
    correlationId: string;
    skill: string;
    toolNames: string[];
  }) => void;
}

export class ProtoSdkExecutor implements IExecutor {
  readonly type = "proto-sdk";

  private readonly executor: AgentExecutor;
  private readonly bus?: EventBus;
  private readonly onToolCall?: ProtoSdkExecutorOptions["onToolCall"];
  private readonly agentName: string;

  constructor(
    agentDef: AgentDefinition,
    options: ProtoSdkExecutorOptions = {},
    bus?: EventBus,
  ) {
    this.executor = new AgentExecutor(agentDef, options);
    this.bus = bus;
    this.onToolCall = options.onToolCall;
    this.agentName = agentDef.name;
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);
    const { bus, onToolCall, agentName } = this;
    const { correlationId, skill } = req;
    // Allow the dispatched payload to override the working directory. The
    // protoCLI session uses this as its `cwd` for shell/edit/read tools.
    const cwd = typeof req.payload?.cwd === "string" ? req.payload.cwd : undefined;
    // Per-call model override — escalate to Opus / downshift to Haiku
    // without editing agent yaml. Falls back to agentDef.model in
    // AgentExecutor.run() when unset.
    const model = typeof req.payload?.model === "string" ? req.payload.model : undefined;

    const result = await this.executor.run({
      prompt,
      correlationId,
      cwd,
      ...(model ? { model } : {}),
      onProgress: (event) => {
        // Per-event progress publish — feeds the /trace timeline + any
        // A2A peer streaming our results back over JSON-RPC.
        if (bus) {
          try {
            const topic = `agent.skill.progress.${correlationId}`;
            bus.publish(topic, {
              id: crypto.randomUUID(),
              correlationId,
              topic,
              timestamp: Date.now(),
              payload: event,
            });
          } catch {
            // Progress is best-effort — never break the run on a bus hiccup.
          }
        }
        // Surface tool_use as activity for the dashboard.
        if (event.eventType === "tool_call" && event.toolName && onToolCall) {
          try {
            onToolCall({
              agentName,
              correlationId,
              skill: skill ?? "(unknown)",
              toolNames: [event.toolName],
            });
          } catch {
            // Same — best-effort.
          }
        }
      },
    });

    return {
      text: result.text,
      isError: result.isError,
      correlationId: req.correlationId,
      data: {
        usage: result.usage,
        numTurns: result.numTurns,
        stopReason: result.stopReason,
      },
    };
  }

  /**
   * Build a default prompt when neither `content` nor `prompt` is set on the
   * request — happens for cron/ceremony dispatches that route by skill name
   * with structured `payload` instead of a natural-language brief. Renders
   * the payload as "key: value" lines so the agent has something to act on.
   */
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

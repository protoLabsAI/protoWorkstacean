import type { ExtendedUsage } from "@protolabsai/sdk";

/**
 * Executor layer types — the contract between SkillDispatcherPlugin and all executor implementations.
 *
 * An IExecutor knows how to run one kind of skill: in-process agent, A2A HTTP call,
 * plain function, or workflow sequence. The registry maps skill names to executors.
 * SkillDispatcherPlugin is the sole subscriber to agent.skill.request — it resolves
 * the right executor and delegates.
 *
 * Tracing:
 *   correlationId = trace ID (never changes within a flow, set at message entry)
 *   parentId      = parent span ID (the bus message ID that triggered this request)
 */

import type { AgentSkillRequestPayload } from "../event-bus/payloads.ts";

// ── Request / Result ──────────────────────────────────────────────────────────

export interface SkillRequest {
  /** The skill name to execute (e.g. "lead_engineer_execute", "daily_standup"). */
  skill: string;
  /** Natural language content or task description — preferred over prompt when both present. */
  content?: string;
  /** Explicit prompt override. */
  prompt?: string;
  /** Trace ID — propagated unchanged from the originating bus message. */
  correlationId: string;
  /** Parent span ID — the bus message ID that produced this request. */
  parentId?: string;
  /** A2A context ID for multi-turn conversations. When set, A2AExecutor uses
   *  this instead of correlationId, enabling conversation continuity across turns. */
  contextId?: string;
  /** Topic to publish the response on. */
  replyTopic: string;
  /** Full original bus message payload — typed with known agent.skill.request fields. */
  payload: AgentSkillRequestPayload;
}

export interface SkillResult {
  /** Output text from the executor. Empty string on error. */
  text: string;
  /** True if execution failed. */
  isError: boolean;
  /** Propagated trace ID. */
  correlationId: string;
  /** Optional structured metrics returned by executors. */
  data?: {
    usage?: ExtendedUsage;
    numTurns?: number;
    stopReason?: string;
    /** A2A task ID — thread on follow-up turns for multi-turn continuity. */
    taskId?: string;
    /** A2A context ID — groups related tasks in a conversation. */
    contextId?: string;
    /** A2A task lifecycle state: working, input-required, completed, failed, etc. */
    taskState?: string;
    /**
     * World-state deltas extracted from the agent's response. Populated by
     * ProtoSdkExecutor when the agent emits a <worldstate-delta> block.
     * Read by SkillDispatcherPlugin to publish world.state.delta events.
     */
    "x-effect-domain"?: { delta: Array<{ domain: string; path: string; delta: number; confidence: number }> };
    [key: string]: unknown;
  };
}

// ── Executor interface ────────────────────────────────────────────────────────

export interface IExecutor {
  /** Identifies the executor type for logging and diagnostics. */
  readonly type: string;
  execute(req: SkillRequest): Promise<SkillResult>;
}

// ── Registry types ────────────────────────────────────────────────────────────

export interface ExecutorRegistration {
  /** Skill name this registration handles. null = default (catch-all). */
  skill: string | null;
  executor: IExecutor;
  /** Agent name for target-based resolution (e.g. "ava", "protomaker", "quinn"). */
  agentName?: string;
  /** Higher priority wins when multiple registrations match the same skill. */
  priority: number;
}

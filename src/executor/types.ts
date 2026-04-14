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
  /**
   * SDK session ID to resume from a previous ProtoSdkExecutor run.
   * Set by SkillDispatcherPlugin when a prior session exists for this
   * correlationId+agentName pair. Only consumed by ProtoSdkExecutor.
   */
  resume?: string;
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
    /** Raw A2A artifacts from the terminal task — used by TaskTracker for worldstate-delta extraction. */
    artifacts?: unknown[];
    /**
     * SDK session ID from a completed ProtoSdkExecutor run.
     * SkillDispatcherPlugin stores this in SessionStore so the next invocation
     * for the same correlationId+agentName can resume the session.
     */
    sessionId?: string;
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

/**
 * A single entry in the effect-based secondary index.
 * Maps a world-state (domain, path) target to the skill that can produce it.
 */
export interface EffectRegistration {
  /** Skill name that produces this effect. */
  skill: string;
  /** Agent name for target-based routing (optional). */
  agentName?: string;
  /** World-state domain (e.g. "ci", "plane"). */
  domain: string;
  /** Dot-separated path into the domain's data object (e.g. "data.blockedPRs"). */
  path: string;
  /** Expected signed numeric change applied to the value at `path`. */
  expectedDelta: number;
  /** Planner weight in [0.0, 1.0]. */
  confidence: number;
}

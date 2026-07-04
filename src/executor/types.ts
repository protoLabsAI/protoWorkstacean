/** Token usage reported by an executor, in the shape every executor publishes today. */
export interface ExtendedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

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
    /** Raw A2A artifacts from the terminal task — used by TaskTracker for worldstate-delta extraction. */
    artifacts?: unknown[];
    /** Wall-clock duration, from a cost-v1 DataPart. */
    durationMs?: number;
    /** Dollar cost, from a cost-v1 DataPart. */
    costUsd?: number;
    /** Explicit success flag from cost-v1 / confidence-v1 DataParts. */
    success?: boolean;
    /** Self-reported confidence in [0, 1], from a confidence-v1 DataPart. */
    confidence?: number;
    /** Free-text confidence explanation, from a confidence-v1 DataPart. */
    confidenceExplanation?: string;
    /**
     * Validated structured result, when the skill declared an `outputSchema`
     * and the forced finalizer ran. Carried alongside `resultMime` (the
     * DataPart discriminator). Consumers read this by MIME instead of parsing
     * prose. Absent for schema-less (free-text) skills.
     */
    resultData?: unknown;
    /** MIME of the structured result DataPart (pairs with `resultData`). */
    resultMime?: string;
  };
}

// ── Executor interface ────────────────────────────────────────────────────────

export interface IExecutor {
  /** Identifies the executor type for logging and diagnostics. */
  readonly type: string;
  execute(req: SkillRequest): Promise<SkillResult>;
  /**
   * Optional teardown when this executor is unregistered (agent removed or
   * reloaded — ADR-0004 hot-swap). Best-effort + safe to call while a dispatch
   * is in flight: an in-flight `execute()` holds its own references, so dispose
   * only releases idle resources (caches, pooled connections). Must not abort
   * running work.
   */
  dispose?(): void | Promise<void>;
}

// ── Registry types ────────────────────────────────────────────────────────────

export interface ExecutorRegistration {
  /** Skill name this registration handles. null = default (catch-all). */
  skill: string | null;
  executor: IExecutor;
  /** Agent name for target-based resolution (e.g. "ava", "quinn"). */
  agentName?: string;
  /** Higher priority wins when multiple registrations match the same skill. */
  priority: number;
}

/**
 * Typed payload interfaces for all EventBus topics.
 *
 * These replace `Record<string, unknown>` casts at publish/subscribe sites.
 * Every BusMessage.payload should be one of these types, narrowed by topic.
 *
 * Existing action-event payloads live in ./action-events.ts and are re-exported
 * here for a single import point.
 */

// Re-export action event payloads (already defined)
export type {
  ActionDispatchPayload,
  ActionOscillationPayload,
  ActionQueueFullPayload,
  PlannerEscalatePayload,
} from "./action-events.ts";

// ── agent.skill.request ───────────────────────────────────────────────────────

/**
 * Payload for `agent.skill.request` — published by RouterPlugin,
 * ActionDispatcherPlugin, or any surface that wants to invoke an agent skill.
 *
 * Fields beyond the listed ones are forwarded transparently from the originating
 * inbound message payload (e.g. projectSlug, discordChannels, github metadata).
 */
export interface AgentSkillRequestPayload {
  /** Skill name to execute (e.g. "bug_triage", "daily_standup"). */
  skill?: string;
  /** Natural language content / task description. */
  content?: string;
  /** Explicit prompt override. */
  prompt?: string;
  /** Target agent names to route to — empty means any registered executor. */
  targets?: string[];
  /** Internal router flag: message has already been routed, skip re-dispatch. */
  _routed?: boolean;
  /** Unique per-dispatch run identifier. */
  runId?: string;
  /** Project slug for multi-project routing. */
  projectSlug?: string;
  /** Explicit skill hint set by surface plugins before inbound routing. */
  skillHint?: string;
  /** Whether this message originated from a direct message conversation. */
  isDM?: boolean;
  /** GOAP action metadata forwarded from ActionDispatcherPlugin. */
  meta?: {
    agentId?: string;
    skillHint?: string;
    topic?: string;
    context?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Allow additional forwarded payload fields from the originating message. */
  [key: string]: unknown;
}

// ── agent.skill.response.* ───────────────────────────────────────────────────

/** Payload for `agent.skill.response.*` — published by SkillDispatcherPlugin. */
export interface AgentSkillResponsePayload {
  /** Successful result text (undefined on error). */
  content?: string;
  /** Error message (undefined on success). */
  error?: string;
  /** Propagated trace ID. */
  correlationId: string;
}

// ── message.inbound.* ────────────────────────────────────────────────────────

/**
 * Common fields present on all `message.inbound.*` payloads.
 * Surface plugins (Discord, GitHub, Plane, etc.) extend this with their
 * own platform-specific fields.
 */
export interface InboundMessagePayload {
  /** Natural language content of the message. */
  content?: string;
  /** Explicit skill hint set by a surface plugin before routing. */
  skillHint?: string;
  /** True when the message came from a direct message / DM context. */
  isDM?: boolean;
  /** Internal router flag: skip re-routing if already dispatched. */
  _routed?: boolean;
  /** Project slug stamped by ProjectEnricher for GitHub messages. */
  projectSlug?: string;
  /** Discord channel IDs stamped by ProjectEnricher for GitHub messages. */
  discordChannels?: {
    general?: string;
    updates?: string;
    dev?: string;
    alerts?: string;
    releases?: string;
  };
  /** GitHub-specific metadata (present on message.inbound.github.*). */
  github?: {
    owner?: string;
    repo?: string;
    [key: string]: unknown;
  };
  /** Allow additional platform-specific fields. */
  [key: string]: unknown;
}

// ── cron.* ───────────────────────────────────────────────────────────────────

/** Payload for `cron.*` — published by SchedulerPlugin when a ceremony fires. */
export interface CronPayload {
  /** Optional content / prompt for the triggered ceremony. */
  content?: string;
  /** Explicit skill hint for RouterPlugin. */
  skillHint?: string;
  /** Reply channel for the scheduled action. Default: "cli". */
  channel?: string;
  /** Optional recipient for Signal/DM-style channels. */
  recipient?: string;
  /** Allow additional fields from ceremony YAML context. */
  [key: string]: unknown;
}

// ── flow.item.* ──────────────────────────────────────────────────────────────

/** Status values for flow items (Flow Framework). */
export type FlowItemStatus = "active" | "blocked" | "complete";

/** Stage labels for flow item lifecycle tracking. */
export type FlowItemStage = "dispatched" | "running" | "error" | "done";

/** Payload for `flow.item.created` / `flow.item.updated` / `flow.item.completed`. */
export interface FlowItemPayload {
  /** Unique flow item identifier. */
  id: string;
  /** Flow item type for classification. */
  type?: "feature" | "defect" | "risk" | "debt";
  /** Current lifecycle status. */
  status?: FlowItemStatus;
  /** Current pipeline stage. */
  stage?: FlowItemStage;
  /** Unix timestamp ms when item was created. */
  createdAt?: number;
  /** Unix timestamp ms when processing started. */
  startedAt?: number;
  /** Unix timestamp ms when item completed. */
  completedAt?: number;
  /** Arbitrary metadata (skill name, executor type, error messages, etc.). */
  meta?: Record<string, unknown>;
}

// ── security.incident.reported ───────────────────────────────────────────────

/** Severity level for security incidents. */
export type IncidentSeverity = "critical" | "high" | "medium" | "low";

/** Status for security incidents. */
export type IncidentStatus = "open" | "investigating" | "resolved";

/** Payload for `security.incident.reported`. */
export interface IncidentReportedPayload {
  incident: {
    id: string;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    reportedAt: string;
    description?: string;
    affectedProjects?: string[];
    assignee?: string;
  };
}

// ── ceremony.*.execute ───────────────────────────────────────────────────────

/** Payload for `ceremony.{id}.execute` — manual or scheduled ceremony trigger. */
export interface CeremonyExecutePayload {
  type: "manual.execute" | "scheduled.execute";
  triggeredBy: "api" | "scheduler";
  ceremonyId?: string;
}

// ── worktree.recovered ───────────────────────────────────────────────────────

/** Classification of a dirty-worktree recovery attempt on automaker restart. */
export type WorktreeRecoveryOutcome = 'auto_recovered' | 'unrecoverable';

/**
 * Payload for `worktree.recovered` — published by the automaker server when it
 * encounters a dirty worktree on restart and attempts self-healing.
 *
 * `outcome: 'auto_recovered'` → WIP was committed to a recovery/ branch; the
 *   feature will be resumed automatically.
 * `outcome: 'unrecoverable'` → merge conflicts or no branch; HITL intervention
 *   is required.
 */
export interface WorktreeRecoveredPayload {
  /** Feature ID that owned the dirty worktree. */
  featureId: string;
  /** Absolute path to the project root. */
  projectPath: string;
  /** Absolute path to the affected worktree (if known). */
  worktreePath?: string;
  /** Recovery outcome classification. */
  outcome: WorktreeRecoveryOutcome;
  /** Human-readable description of what happened. */
  reason: string;
  /** The `recovery/<id>-<ts>` branch where WIP was committed (auto_recovered only). */
  recoveryBranch?: string;
  /** ISO 8601 timestamp when the recovery event occurred. */
  recoveredAt: string;
}

// ── autonomous.outcome.* ─────────────────────────────────────────────────────

/**
 * Payload for `autonomous.outcome.{systemActor}.{skill}` — published by
 * SkillDispatcherPlugin after every task reaches terminal state, whether via
 * direct executor return or TaskTracker polling.
 *
 * Replaces the split between `world.action.outcome` and per-reply-topic
 * responses so OutcomeAnalysis sees a single unified stream.
 *
 * effectDelta is reserved for Arc 4/5 — leave undefined for now.
 */
export interface AutonomousOutcomePayload {
  /** Trace ID propagated from the originating bus message. */
  correlationId: string;
  /** Parent span ID — the bus message ID that triggered the skill request. */
  parentId?: string;
  /** Autonomous subsystem actor (e.g. "goap", "ceremony", "pr-remediator") or "user". */
  systemActor: string;
  /** Skill name that was executed. */
  skill: string;
  /** GOAP action id when the outcome came from a planned action — optional,
   *  unset for ad-hoc or ceremony dispatches. Kept distinct from `skill` so
   *  the planner's loop-detector can reason about action identity even when
   *  the skill name is shared across actions. */
  actionId?: string;
  /** Goal id that triggered this outcome (when originating from GOAP). */
  goalId?: string;
  /** True if the task completed without error. */
  success: boolean;
  /** Error message when success is false. */
  error?: string;
  /** Final A2A task lifecycle state (completed, failed, canceled, etc.). */
  taskState?: string;
  /** First 500 chars of the result text — for quick inspection. */
  textPreview?: string;
  /** Token usage reported by the executor. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Wall-clock time from dispatch to terminal state (ms). */
  durationMs: number;
  /** World-state delta produced by this task — populated in Arc 4/5. */
  effectDelta?: Record<string, unknown>;
}

// ── world.state.delta (worldstate-delta-v1) ──────────────────────────────────

/**
 * Payload for `world.state.delta` published by TaskTracker when a terminal task
 * contains artifacts tagged with the x-protolabs/worldstate-delta-v1 extension.
 *
 * Each message represents a single domain mutation observed or declared by an agent.
 * Idempotent: sourceTaskId is unique per task so consumers can deduplicate.
 */
export interface WorldStateDeltaV1Payload {
  /** World-state domain (e.g. "ci", "plane"). */
  domain: string;
  /** Dot-separated path into the domain's data object (e.g. "data.blockedPRs"). */
  path: string;
  /** Mutation operation (e.g. "set", "add", "remove"). */
  op: string;
  /** New value to apply at `path`. */
  value: unknown;
  /** A2A task ID — used as idempotency key by consumers. */
  sourceTaskId: string;
  /** Agent that produced this delta. */
  sourceAgent: string;
}

// ── world.goal.violated ──────────────────────────────────────────────────────
// Defined in src/types/events.ts — re-exported here for convenience.
export type { GoalViolatedEventPayload } from "../types/events.ts";

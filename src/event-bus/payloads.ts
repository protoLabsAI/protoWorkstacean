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
  ActionOutcomePayload,
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

// ── world.goal.violated ──────────────────────────────────────────────────────
// Defined in src/types/events.ts — re-exported here for convenience.
export type { GoalViolatedEventPayload } from "../types/events.ts";

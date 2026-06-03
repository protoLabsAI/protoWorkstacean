/**
 * Typed payload interfaces for all EventBus topics.
 *
 * These replace `Record<string, unknown>` casts at publish/subscribe sites.
 * Every BusMessage.payload should be one of these types, narrowed by topic.
 */

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
  /** Conversation/context id for multi-turn continuity. The dispatcher
   *  propagates this onto SkillRequest.contextId so executors keep one
   *  conversation across turns instead of starting fresh each correlationId. */
  contextId?: string;
  /** Explicit skill hint set by surface plugins before inbound routing. */
  skillHint?: string;
  /** Whether this message originated from a direct message conversation. */
  isDM?: boolean;
  /** Optional action metadata stamped by the caller (cron, ceremony, alert handler). */
  meta?: {
    agentId?: string;
    skillHint?: string;
    topic?: string;
    context?: Record<string, unknown>;
    /**
     * Name of the agent that dispatched this skill request (if any). Set when
     * an agent tool like `chat_with_agent` or `delegate_task` fires the
     * request. Carries through the A2A lifecycle so `TaskTracker` can route
     * `input-required` prompts back to the dispatcher instead of directly to
     * the human renderer.
     */
    dispatcherAgent?: string;
    [key: string]: unknown;
  };
  /** Allow additional forwarded payload fields from the originating message. */
  [key: string]: unknown;
}

// ── agent.skill.response.* ───────────────────────────────────────────────────

/** Payload for `agent.skill.response.*` — published by SkillDispatcherPlugin
 * (inline-complete executors) and TaskTracker (long-running A2A tasks). Both
 * sites populate the same shape so a reply-topic subscriber sees the full
 * executor result regardless of which path produced it. */
export interface AgentSkillResponsePayload {
  /** Successful result text (undefined on error). */
  content?: string;
  /** Error message (undefined on success). */
  error?: string;
  /** Propagated trace ID. */
  correlationId: string;
  /** Terminal A2A task state ("completed" | "failed" | "canceled" | "rejected"),
   *  or "completed"/"failed" inferred for non-task executors. */
  taskState?: string;
  /** Remote A2A task id, when the executor created one. */
  taskId?: string;
  /** Conversation/context id for multi-turn continuity. */
  contextId?: string;
  /** Token usage, when the sub-agent emitted it. */
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  /** Delegation cost in USD (cost-v1 extension), when emitted. */
  costUsd?: number;
  /** Sub-agent self-reported confidence 0..1 (confidence-v1 extension), when emitted. */
  confidence?: number;
  /** Free-text rationale for the confidence score, when emitted. */
  confidenceExplanation?: string;
  /**
   * Validated structured result, when the skill declared an `output_schema`
   * and emitted a structured-result DataPart. Carried alongside `resultMime`
   * (the DataPart discriminator). Consumers match on the MIME and read this
   * object instead of parsing the free-text `content`.
   */
  resultData?: unknown;
  /** MIME of the structured-result DataPart (pairs with `resultData`). */
  resultMime?: string;
  /** Wall-clock execution time in ms, when known. */
  durationMs?: number;
}

// ── agent.skill.progress.* ───────────────────────────────────────────────────

/**
 * Payload for `agent.skill.progress.{correlationId}` — fire-and-forget
 * intermediate-progress events published by skill executors during long-running
 * work. BusAgentExecutor (the A2A server side) subscribes alongside the
 * reply topic and translates each event into an A2A `status-update` with
 * `state: "working"` and `final: false`.
 *
 * Every field is optional; the bus consumer surfaces whatever is set:
 *   - `text` becomes the visible message body in the streamed status update
 *   - `percent` and `step` go into status-update metadata for clients that
 *     render progress affordances
 *   - `meta` carries arbitrary extra data (tool name, model, token counts,
 *     whatever the executor wants to expose)
 *
 * Skill executors opt in by publishing — those that don't lose nothing.
 */
export interface AgentSkillProgressPayload {
  /** Human-readable progress message (rendered in the streamed status update). */
  text?: string;
  /** Optional 0-100 progress percentage. */
  percent?: number;
  /** Optional named step / phase the executor is currently in. */
  step?: string;
  /** Arbitrary structured progress metadata. */
  meta?: Record<string, unknown>;
}

// ── message.inbound.* ────────────────────────────────────────────────────────

/**
 * Common fields present on all `message.inbound.*` payloads.
 * Surface plugins (Discord, GitHub, Linear, etc.) extend this with their
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
  /** Project slug stamped by RouterPlugin for GitHub messages. */
  projectSlug?: string;
  /** Project Discord channel IDs stamped by RouterPlugin for GitHub messages. */
  discordChannels?: {
    dev?: string;
    release?: string;
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

// ── dispatch.dropped.* ───────────────────────────────────────────────────────

/** Reason for a dropped dispatch — matches the trailing segment of the topic. */
export type DispatchDropReason = "no_skill" | "target_unresolved" | "cooldown";

/**
 * Payload for `dispatch.dropped.{reason}`. Published by SkillDispatcherPlugin
 * when a skill request reaches the chokepoint but is rejected before any
 * executor runs. Subscribers (dashboard tiles, drop-rate alerts) can match
 * `dispatch.dropped.cooldown` for cooldown-only or `dispatch.dropped.#` for
 * all drops.
 *
 * Reason-specific fields are optional — uniform shape, single subscriber path.
 */
export interface DispatchDroppedPayload {
  reason: DispatchDropReason;
  correlationId: string;
  /** The dispatcher's human-readable drop message — same content as the console.warn line. */
  message: string;
  /** Skill name (absent only when reason="no_skill"). */
  skill?: string;
  /** Explicit targets from the dispatch request (empty when none specified). */
  targets?: string[];
  /** Cooldown bucket key — populated only when reason="cooldown". */
  cooldownKey?: string;
  /** Configured cooldown window in ms — populated only when reason="cooldown". */
  cooldownWindowMs?: number;
  /** Remaining cooldown in ms when the drop fired — populated only when reason="cooldown". */
  cooldownRemainingMs?: number;
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

// ── github.issue.opened ──────────────────────────────────────────────────────

/**
 * Payload for `github.issue.opened` — a GitHub issue was opened or reopened on
 * any repo the webhook covers. Additive signal published by the GitHub plugin
 * independent of the @mention / auto-triage paths. The ProtoMakerBoardBridge
 * subscribes and forwards issues on *registered project repos* into protoMaker's
 * board intake (workstacean owns the repo→project resolution).
 */
export interface GithubIssueOpenedPayload {
  owner: string;
  repo: string;
  number: number;
  /** "opened" | "reopened". */
  action: string;
  title: string;
  /** Issue body (markdown). Empty string when none. */
  body: string;
  /** Login of the issue author. */
  author: string;
  url: string;
}

// ── release.published ────────────────────────────────────────────────────────

/**
 * Payload for `release.published` — a GitHub Release was published. Sourced
 * from the native `release` webhook, so it fires regardless of how the release
 * was cut (auto-release.yml `gh release create`, release-tools, or by hand).
 * A general fleet lifecycle primitive: content surfacing, changelog
 * aggregation, deploy verification, and announce can all subscribe.
 */
export interface ReleasePublishedPayload {
  owner: string;
  repo: string;
  /** The release tag, e.g. "v1.4.0". */
  version: string;
  /** Release title; falls back to the version when GitHub leaves it null. */
  name: string;
  /** Release notes body (markdown). Empty string when none. */
  body: string;
  /** Canonical GitHub Release URL. */
  url: string;
  /** Login of the actor who published the release. */
  author: string;
  prerelease: boolean;
  /** ISO timestamp from GitHub, or publish-handling time as a fallback. */
  publishedAt: string;
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

// ── config.reload ─────────────────────────────────────────────────────────────

/** Payload for `config.reload` — triggers hot reload of goals.yaml and actions.yaml. */
export interface ConfigReloadPayload {
  /** What triggered the reload (e.g. "api", "hitl", "ava"). */
  source?: string;
  /** Optional request ID for tracing. */
  requestId?: string;
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
  /** Autonomous subsystem actor (e.g. "goap", "ceremony", "feature-remediation") or "user". */
  systemActor: string;
  /** Skill name that was executed. */
  skill: string;
  /** action id forwarded from the caller (cron / ceremony / alert handler) — optional,
   *  unset for ad-hoc or ceremony dispatches. Kept distinct from `skill` so
   *  the planner's loop-detector can reason about action identity even when
   *  the skill name is shared across actions. */
  actionId?: string;
  /** Goal id forwarded by the caller, if any. */
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
  /**
   * LLM model used for this task — captured from the dispatch payload
   * (`payload.model` per-call override, see #613). Undefined when the
   * caller didn't specify an override (in that case the executor or
   * LiteLLM gateway picked a model and we can't tell which one from
   * the dispatcher). Cost aggregation in AgentFleetHealth uses the
   * model-specific rate from `MODEL_RATES` when set; falls back to
   * the default rate otherwise.
   */
  model?: string;
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
  /** World-state domain (e.g. "ci", "github_issues"). */
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


// ── agent.runtime.activity ────────────────────────────────────────────────────

/**
 * Live agent telemetry events. Published at meaningful points in a skill
 * invocation by the SkillDispatcher (lifecycle) and by DeepAgentExecutor
 * (per-tool detail). Drives the /system dashboard's agent activity panels
 * and any future observability surface that needs "what is Quinn doing
 * RIGHT NOW".
 *
 * Topic pattern:
 *   agent.runtime.activity.skill.{start|complete|error}
 *   agent.runtime.activity.tool.call
 *
 * Designed for spectator consumption — does NOT replace
 * `agent.skill.response` (which carries the actual reply for callers).
 * Best-effort: publish failures are swallowed inside the producer.
 */
export type AgentActivityType =
  | "skill.start"
  | "tool.call"
  | "skill.complete"
  | "skill.error";

export interface AgentActivityPayload {
  type: AgentActivityType;
  /** Agent name as registered in workspace/agents/*.yaml. */
  agentName: string;
  /** Correlation id of the underlying skill request — pairs start/complete/error and the tool.call events between them. */
  correlationId: string;
  /** ms timestamp at publish time. */
  timestamp: number;
  skill?: string;
  /** For tool.call events: tool names invoked in this turn. */
  toolNames?: string[];
  /** For skill.complete: first ~120 chars of the assistant's final text, for UI preview. */
  resultPreview?: string;
  /** For skill.error: message from the thrown error. */
  errorMessage?: string;
  /** For skill.complete / skill.error: ms between start and terminal event. */
  durationMs?: number;
}

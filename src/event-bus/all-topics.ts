/**
 * Canonical bus topic constants, grouped by domain.
 *
 * All bus topic strings live here. Import from `src/event-bus/topics.ts`
 * (the TOPICS barrel) in application code.
 */

export const MESSAGE_TOPICS = {
  /** Wildcard subscription pattern — matches all inbound surface messages. */
  MESSAGE_INBOUND_ALL: "message.inbound.#",

  /** Prefix for GitHub inbound messages (used with startsWith). */
  MESSAGE_INBOUND_GITHUB_PREFIX: "message.inbound.github.",

  /** Outbound Discord alert channel. */
  MESSAGE_OUTBOUND_DISCORD_ALERT: "message.outbound.discord.alert",

  /** Base outbound Signal topic (append .{recipient} for DM, .cron for scheduled). */
  MESSAGE_OUTBOUND_SIGNAL: "message.outbound.signal",
} as const;

export const ACTION_TOPICS = {
  /** Published to invoke an agent skill (unified dispatch). */
  AGENT_SKILL_REQUEST: "agent.skill.request",

  /** Wildcard subscription pattern — matches all cron events from SchedulerPlugin. */
  CRON_ALL: "cron.#",
} as const;

export const SECURITY_TOPICS = {
  /** Published when a security incident is detected. */
  SECURITY_INCIDENT_REPORTED: "security.incident.reported",
} as const;

export const FLOW_TOPICS = {
  /** Published when a budget cost discrepancy is detected. */
  FLOW_ALERT_BUDGET: "ops.alert.budget",

  /** Published by OutcomeAnalysisPlugin when an action has chronic failures. */
  FLOW_ALERT_ACTION_QUALITY: "ops.alert.action_quality",

  /** Published by OutcomeAnalysisPlugin when repeated HITL escalations are detected. */
  FLOW_ALERT_HITL_ESCALATION: "ops.alert.hitl_escalation",
} as const;

export const WORLD_TOPICS = {
  /** Published by WorldStateCollector when a new snapshot is available. */
  WORLD_STATE_UPDATED: "world.state.updated",

  /** Published by ActionDispatcherPlugin when an action is dispatched. */
  WORLD_ACTION_DISPATCH: "world.action.dispatch",

  /** Published by ActionDispatcherPlugin when an action outcome is recorded. */
  WORLD_ACTION_OUTCOME: "world.action.outcome",

  /** Published by LoopDetector when oscillation threshold is breached. */
  WORLD_ACTION_OSCILLATION: "world.action.oscillation",

  /** Published by ActionDispatcherPlugin when WIP queue is at capacity. */
  WORLD_ACTION_QUEUE_FULL: "world.action.queue_full",

  /** Published by PlannerPluginL0 when escalation to tier_1 is needed. */
  PLANNER_ESCALATE: "world.planner.escalate",

  /** Published when a world goal violation is detected. */
  WORLD_GOAL_VIOLATED: "world.goal.violated",

  /**
   * Published by SkillDispatcherPlugin after every task reaches terminal state.
   * Full topic is `autonomous.outcome.{systemActor}.{skill}`.
   */
  AUTONOMOUS_OUTCOME_PREFIX: "autonomous.outcome",
} as const;

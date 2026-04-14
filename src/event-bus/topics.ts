/**
 * EventBus topic constants for the deterministic planner system.
 *
 * Convention: world.action.* for planner-related events.
 */

export const TOPICS = {
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

  /** Published by ActionDispatcherPlugin to invoke an agent skill (unified dispatch). */
  AGENT_SKILL_REQUEST: "agent.skill.request",

  /**
   * Published by SkillDispatcherPlugin after every task reaches terminal state.
   * Full topic is `autonomous.outcome.{systemActor}.{skill}`.
   * Use this prefix to subscribe to all outcomes.
   */
  AUTONOMOUS_OUTCOME_PREFIX: "autonomous.outcome",

  /**
   * Published by EffectDomainExtension after each skill execution that returns
   * effect-domain data. Consumed by WorldStateEngine to apply in-process deltas
   * and re-fire goal evaluation immediately.
   */
  WORLD_STATE_DELTA: "world.state.delta",
} as const;

export type TopicValue = (typeof TOPICS)[keyof typeof TOPICS];

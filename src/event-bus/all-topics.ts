/**
 * Canonical bus topic constants, grouped by domain.
 *
 * Import from `src/event-bus/topics.ts` (the TOPICS barrel) in application code.
 *
 * ## Naming convention
 *
 * `<domain>.<noun>.<verb>[.<scope>]`
 *
 * Examples:
 *   `message.inbound.discord.dm.{userId}`   — domain=message, noun=inbound, verb=discord (the sender platform), scope=dm.{userId}
 *   `agent.skill.request`                   — domain=agent, noun=skill, verb=request
 *   `ceremony.{id}.execute`                 — domain=ceremony, noun={id}, verb=execute
 *   `autonomous.outcome.{actor}.{skill}`    — domain=autonomous, noun=outcome, scope=actor/skill
 *
 * Rules:
 *   - All segments lowercase, dot-separated, no slashes or colons.
 *   - Use `#` only as a subscription wildcard suffix (matches any continuation).
 *   - Use `*` only as a single-segment subscription wildcard.
 *   - Prefer correlationId-suffixed reply topics for request/reply pairs:
 *     `<topic>.request.{correlationId}` → `<topic>.response.{correlationId}`.
 *   - Every published topic in production code should appear here.
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

  /**
   * Prefix for skill-progress events. Full topic is
   * `agent.skill.progress.{correlationId}`. Skill executors that want to
   * stream intermediate progress to a long-running A2A caller publish to
   * this topic; BusAgentExecutor translates each event into a
   * `status-update` (state=working, final=false) on the A2A `message/stream`
   * channel. Opt-in — executors that don't publish lose nothing.
   * See AgentSkillProgressPayload in src/event-bus/payloads.ts.
   */
  AGENT_SKILL_PROGRESS_PREFIX: "agent.skill.progress",

  /** Wildcard subscription pattern — matches all cron events from SchedulerPlugin. */
  CRON_ALL: "cron.#",

  /**
   * Published by SkillDispatcherPlugin after every task reaches terminal state.
   * Full topic is `autonomous.outcome.{systemActor}.{skill}`.
   */
  AUTONOMOUS_OUTCOME_PREFIX: "autonomous.outcome",
} as const;

export const SECURITY_TOPICS = {
  /** Published when a security incident is detected. */
  SECURITY_INCIDENT_REPORTED: "security.incident.reported",
} as const;

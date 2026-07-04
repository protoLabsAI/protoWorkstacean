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

  /**
   * Prefix for structured tool-call-v1 frames. Full topic is
   * `agent.skill.toolframe.{correlationId}`. The in-process runtime publishes
   * one frame per tool lifecycle event (started → completed/failed); the
   * a2a-server emits each as a streamed artifact-update DataPart for clients
   * that render a structured tool timeline. Sibling to the plain-text
   * narration on AGENT_SKILL_PROGRESS_PREFIX. Opt-in.
   */
  AGENT_SKILL_TOOLFRAME_PREFIX: "agent.skill.toolframe",

  /**
   * Prefix for human-input requests. Full topic is
   * `agent.input.request.{correlationId}`. An in-process agent's `ask_human`
   * tool (via POST /api/agent/ask-human) publishes here when it needs an answer
   * from the A2A caller; BusAgentExecutor turns it into an `input-required`
   * status-update on the caller's stream. See src/api/human-input.ts.
   */
  AGENT_INPUT_REQUEST_PREFIX: "agent.input.request",

  /**
   * Prefix for human-input answers. Full topic is
   * `agent.input.response.{requestId}`. Published when the caller answers via
   * POST /api/a2a/input; unblocks the waiting `ask_human` handler.
   */
  AGENT_INPUT_RESPONSE_PREFIX: "agent.input.response",

  /**
   * Control-plane mutations (ADR-0004 P2). The write API publishes these; the
   * ControlPlaneRegistrar is the sole subscriber + the only writer of the
   * workspace config files. Auditable in bus-history. The file write triggers
   * the agent-runtime hot-reload (P1), so the change goes live within ~5s.
   *   command.agent.upsert  — { name, file, yaml }  → atomic write
   *   command.agent.remove  — { name, file }        → delete
   */
  COMMAND_AGENT_UPSERT: "command.agent.upsert",
  COMMAND_AGENT_REMOVE: "command.agent.remove",
  /**
   * A2A-endpoint mutations (ADR-0004 P3). The registrar persists the entry to
   * workspace/agents.d/<name>.yaml; SkillBroker registers/unregisters the
   * A2AExecutor live in the same turn (no restart).
   *   command.a2a.upsert — { name, file, yaml, entry }
   *   command.a2a.remove — { name, file }
   */
  COMMAND_A2A_UPSERT: "command.a2a.upsert",
  COMMAND_A2A_REMOVE: "command.a2a.remove",

  /**
   * MCP-server mutations (ADR-0005, ADR-0004 P4). The registrar persists the
   * entry to workspace/mcp-servers.d/<name>.yaml; McpClientPlugin connects and
   * registers/unregisters one McpExecutor per discovered tool live (no restart).
   *   command.mcp.upsert — { name, file, yaml, entry }
   *   command.mcp.remove — { name, file }
   */
  COMMAND_MCP_UPSERT: "command.mcp.upsert",
  COMMAND_MCP_REMOVE: "command.mcp.remove",

  /**
   * Route (wiring) mutations (ADR-0008 P2). The registrar persists the route to
   * workspace/routes.d/<name>.yaml; RoutesPlugin hot-reloads and (un)subscribes
   * its trigger topic live (no restart).
   *   command.route.upsert — { name, file, yaml }
   *   command.route.remove — { name, file }
   */
  COMMAND_ROUTE_UPSERT: "command.route.upsert",
  COMMAND_ROUTE_REMOVE: "command.route.remove",

  /** Wildcard subscription pattern — matches all cron events from SchedulerPlugin. */
  CRON_ALL: "cron.#",

  /**
   * Published by SkillDispatcherPlugin after every task reaches terminal state.
   * Full topic is `autonomous.outcome.{systemActor}.{skill}`.
   */
  AUTONOMOUS_OUTCOME_PREFIX: "autonomous.outcome",

  /**
   * Published by SkillDispatcherPlugin after every successful skill
   * completion that came from a webhook-stamped dispatch (today: github's
   * `_handleAutoReview`). Structured form of the existing
   * `[skill-latency]` log line — dashboard tiles + downstream alerting
   * can subscribe and accumulate without parsing stdout.
   *
   * Payload shape: { skill, totalMs, queueMs, executeMs, github? }.
   *   - totalMs   = webhook arrival → done
   *   - queueMs   = webhook arrival → dispatch start (bus hops + routing)
   *   - executeMs = dispatch start → done (LLM + tools)
   *   - github    = { owner, repo, number } when the original payload
   *                 carried it (PR reviews, etc.); absent otherwise.
   */
  AGENT_SKILL_LATENCY: "agent.skill.latency",

  /**
   * Prefix for dispatcher drop events. Full topic is
   * `dispatch.dropped.{reason}` where reason ∈ {no_skill, target_unresolved,
   * cooldown}. Published by SkillDispatcherPlugin at each chokepoint drop
   * site so subscribers (dashboard, drop-rate alerts) can count + filter
   * by reason without scraping stdout. Payload shape:
   * see `DispatchDroppedPayload` in src/event-bus/payloads.ts.
   */
  DISPATCH_DROPPED_PREFIX: "dispatch.dropped",
} as const;

export const SECURITY_TOPICS = {
  /** Published when a security incident is detected. */
  SECURITY_INCIDENT_REPORTED: "security.incident.reported",
} as const;

export const RELEASE_TOPICS = {
  /**
   * Published by the GitHub plugin when a GitHub Release is published (native
   * `release` webhook, action=published). Mechanism-agnostic — fires whether
   * the release was cut by auto-release.yml `gh release create`, release-tools,
   * or by hand. A general fleet lifecycle primitive: content surfacing,
   * changelog aggregation, deploy verification, and announce subscribe here.
   * Payload shape: see `ReleasePublishedPayload` in src/event-bus/payloads.ts.
   */
  RELEASE_PUBLISHED: "release.published",
} as const;

export const REVIEW_TOPICS = {
  /**
   * Published by `pr-inspector` after a `review_comment` / `review_approve` /
   * `review_request_changes` action succeeds. Fire-and-forget signal for any
   * notifier (Discord embed, dashboard activity feed, etc.) that wants to
   * react to Quinn's review verdicts without subscribing to every github API
   * response. See `quinn-review-notifier-plugin` for the Discord side.
   *
   * Payload shape: { owner, repo, prNumber, event, reviewId?, prUrl? }.
   */
  QUINN_REVIEW_SUBMITTED: "quinn.review.submitted",
} as const;

export const SYSTEM_TOPICS = {
  /**
   * App-self error — published by the bus when a subscriber handler throws
   * (#800). Consumed by AppAlertPlugin, which posts a throttled message to the
   * ops Discord webhook. Payload: { source, plugin?, pattern?, error }.
   */
  SYSTEM_ERROR: "system.error",
} as const;

export const FLOW_TOPICS = {
  /**
   * Flow-item lifecycle — published by SkillDispatcherPlugin for every dispatch
   * (one item per correlationId, id = `skill-<correlationId>`). Consumed by the
   * BusHistoryRecorder + FlowStorePlugin (the durable execution log behind
   * `GET /api/flows` / the orchestration canvas, ADR-0008). Payload: FlowItemPayload.
   */
  FLOW_ITEM_CREATED: "flow.item.created",
  FLOW_ITEM_UPDATED: "flow.item.updated",
  FLOW_ITEM_COMPLETED: "flow.item.completed",
} as const;

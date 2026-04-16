---
title: Bus Topics Reference
---

All bus topics published and subscribed across all plugins and subsystems. Topic patterns use `#` as a multi-segment wildcard (MQTT-style). `{variable}` denotes a dynamic segment.

---

## Skill dispatch

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `agent.skill.request` | Internal | RouterPlugin, ActionDispatcherPlugin, CeremonyPlugin, OutcomeAnalysisPlugin | SkillDispatcherPlugin | Requests execution of a named skill. `plan` / `onboard_project` / `deep_research` all flow through here (no per-skill routing table) |
| `agent.skill.response.<correlationId>` | Internal | SkillDispatcherPlugin | Caller (varies) | Result of a skill execution |
| `skill.progress` | Internal | DeepAgentExecutor / A2AExecutor | Optional subscribers (UI, logs) | Intermediate tool-call + assistant-message events streamed during skill execution (LangGraph tool calls for in-process, A2A stream updates for external). Payload is a `SkillProgressEvent`; useful for dashboards that want to render live agent reasoning. Not guaranteed in-order, not for correctness. |

**`agent.skill.request` payload** (`SkillRequest`):
```typescript
{
  skill: string;           // Skill name (e.g. "sitrep", "pr_review")
  content?: string;        // Natural language task description
  prompt?: string;         // Explicit prompt override
  correlationId: string;   // Trace ID — never changes within a flow
  parentId?: string;       // Parent span ID — the bus message.id that triggered this
  replyTopic: string;      // Where to publish the result
  payload?: Record<string, unknown>;  // Full original payload for context
}
```

**`agent.skill.response.<correlationId>` payload** (`SkillResult`):
```typescript
{
  text: string;            // Output text from the executor
  isError: boolean;        // True if execution failed
  correlationId: string;   // Propagated trace ID
  data?: unknown;          // Structured data (function/workflow executors)
}
```

---

## GitHub plugin

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `message.inbound.github.<owner>.<repo>.<event>.<number>` | Inbound | GitHubPlugin | RouterPlugin | GitHub event (issue/PR comment, review, etc.) |
| `message.outbound.github.<owner>.<repo>.<number>` | Outbound | RouterPlugin / agents | GitHubPlugin | Post a comment on a GitHub issue or PR |
| `message.inbound.onboard` | Inbound | GitHubPlugin | OnboardingPlugin | New repository created in org |

**Inbound payload**:
```typescript
{
  sender: string;       // GitHub username
  channel: string;      // "{owner}/{repo}#{number}"
  content: string;      // Event header + title + body
  skillHint?: string;   // From github.yaml skillHints map
  github: {
    event: string;
    owner: string; repo: string;
    number: number; title: string; url: string;
  };
}
```

---

## Discord plugin

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `message.inbound.discord.<channelId>` | Inbound | DiscordPlugin | RouterPlugin | @mention, guild channel message, or DM received |
| `message.inbound.discord.slash.<interactionId>` | Inbound | DiscordPlugin | RouterPlugin | Slash command invoked |
| `message.outbound.discord.<channelId>` | Outbound | Agents | DiscordPlugin | Reply to a specific channel |
| `message.outbound.discord.push.<channelId>` | Outbound | CeremonyPlugin, ActionDispatcherPlugin | DiscordPlugin | Unprompted push (cron result, alert) |

**Inbound payload**:
```typescript
{
  sender: string;         // Discord user ID
  channel: string;        // Discord channel ID
  content: string;        // Cleaned message (mentions stripped)
  skillHint?: string;     // Set by slash commands and reaction handlers
  isReaction?: boolean;
  isThread?: boolean;
  guildId?: string;
  correlationId: string;  // Stable conversationId for multi-turn sessions — reused
                          // across turns by ConversationManager, becomes the A2A contextId
}
```

**Multi-turn conversations**: when `conversation.enabled: true` is set for a channel in `workspace/channels.yaml`, `ConversationManager` assigns a stable `conversationId` to each `(channelId, userId)` pair. This ID flows as `correlationId` on every turn, becoming the A2A `contextId` so agents have full conversation memory. DMs are always conversation-enabled (no YAML needed). RouterPlugin applies DM conversation stickiness — once a skill/agent is matched, subsequent DM turns reuse the same target without re-running keyword matching.

---

## GOAP / world engine

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `world.state.updated` | Internal | WorldStateEngine | GoalEvaluatorPlugin, PlannerPluginL0, ActionDispatcherPlugin | Domain data refreshed |
| `world.state.delta` | Internal | A2AExecutor (via `effect-domain-v1` interceptor), TaskTracker | WorldStateEngine | Agent-observed mutations applied in-process without waiting for next poll |
| `world.goal.violated` | Internal | GoalEvaluatorPlugin | PlannerPluginL0, OutcomeAnalysisPlugin | A goal evaluation failed |
| `world.action.dispatch` | Internal | PlannerPluginL0 | ActionDispatcherPlugin | A single action ready to execute (superseded the older `world.action.plan` batch shape) |
| `world.action.queue_full` | Internal | ActionDispatcherPlugin | alert-bridge → Discord | WIP limit reached; action queued |

**`world.state.updated` payload**:
```typescript
{
  domain: string;          // Domain name that updated
  state: Record<string, unknown>;  // Full current world state snapshot
}
```

**`world.goal.violated` payload**:
```typescript
{
  goalId: string;
  severity: "low" | "medium" | "high" | "critical";
  selector?: string;
  actual?: unknown;
  expected?: unknown;
  worldState: Record<string, unknown>;
}
```

**`world.action.dispatch` payload** (`ActionDispatchPayload`):
```typescript
{
  type: "dispatch";
  actionId: string;
  goalId: string;
  action: Action;                 // full Action record with effects + meta
  correlationId: string;
  timestamp: number;
  optimisticEffectsApplied: boolean;
}
```

---

## Autonomous observation stream

Emitted by extensions running inside `A2AExecutor` and by `ActionDispatcherPlugin`'s terminal outcomes. `OutcomeAnalysisPlugin` and `AgentFleetHealthPlugin` subscribe to `autonomous.outcome.#` to aggregate per-agent + per-skill rollups. `PlannerPluginL0` reads the per-skill stores (populated by the cost + confidence extensions) when ranking candidates (Arc 6.4).

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `autonomous.outcome.{systemActor}.{skill}` | Internal | ActionDispatcherPlugin, SkillDispatcherPlugin | OutcomeAnalysisPlugin, AgentFleetHealthPlugin, PlannerPluginL0 | Terminal-state outcome for every autonomous skill execution — unified stream across GOAP, ceremony, FAF, and user-initiated dispatches |
| `autonomous.cost.{systemActor}.{skill}` | Internal | `cost-v1` extension (after-hook in A2AExecutor) | Dashboard collectors, external telemetry | Per-(agent, skill) token + wall-time actuals; `CostStore` is the in-memory aggregate |
| `autonomous.confidence.{systemActor}.{skill}` | Internal | `confidence-v1` extension | Calibration dashboard, OutcomeAnalysis | Agent-reported confidence 0.0–1.0 per call; `ConfidenceStore` aggregates |
| `ops.alert.action_quality` | Internal | OutcomeAnalysisPlugin | alert-bridge → Discord | Skill with <50% success rate over 10+ attempts |
| `ops.alert.hitl_escalation` | Internal | OutcomeAnalysisPlugin | alert-bridge → Discord | 3+ HITL escalations for the same (kind, target) |

**`AutonomousOutcomePayload`**:
```typescript
{
  correlationId: string;
  systemActor: "user" | "goap" | "ceremony:<id>" | ...;
  skill: string;
  actionId?: string;   // set for GOAP dispatches
  goalId?: string;     // set for GOAP dispatches
  success: boolean;
  error?: string;
  taskState: "completed" | "failed" | "canceled" | "rejected" | ...;
  durationMs: number;
  usage?: AnthropicUsage;
}
```

See [`self-improving-loop.md`](../explanation/self-improving-loop.md) for the end-to-end observation → planner-ranking path and [`cost-v1`](../extensions/cost-v1.md) / [`confidence-v1`](../extensions/confidence-v1.md) for the extension-specific payload shapes.

---

## Ceremony plugin

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `ceremony.<id>.execute` | Internal | CeremonyPlugin (cron), ActionDispatcherPlugin | CeremonyPlugin | Trigger a ceremony |

**`ceremony.<id>.execute` payload**:
```typescript
{
  ceremonyId: string;
  triggeredBy?: "cron" | "action" | "manual";
  correlationId?: string;
}
```

---

## Scheduler plugin

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `cron.<scheduleId>` | Internal | SchedulerPlugin | RouterPlugin, CeremonyPlugin | Scheduled event fires |
| `command.schedule` | Internal | Any | SchedulerPlugin | Runtime schedule management |
| `schedule.list` | Internal | SchedulerPlugin | Caller | Response to `action: list` |

**`command.schedule` payload**:
```typescript
{
  action: "add" | "remove" | "pause" | "resume" | "list";
  id?: string;
  schedule?: string;    // Cron expression or ISO datetime
  timezone?: string;
  topic?: string;
  payload?: object;
}
```

---

## Security / incidents

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `security.incident.reported` | Internal | HTTP API, Agents | GoalEvaluatorPlugin, DiscordPlugin | New incident created |

**`security.incident.reported` payload**:
```typescript
{
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  description?: string;
  reportedAt: string;  // ISO 8601
}
```

---

## Human-in-the-loop (HITL)

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `hitl.request.#` | Internal | Agents (e.g. protoMaker team post-plan, Quinn post-review) | HITLPlugin | Approval request |
| `hitl.response.#` | Internal | Interface plugins (Discord reaction, CLI) | HITLPlugin | Human decision |
| `hitl.pending.<correlationId>` | Internal | HITLPlugin | API callers | Unrouted request awaiting response |
| `hitl.expired.<correlationId>` | Internal | HITLPlugin | Any | Request TTL exceeded (60s sweep) |

---

## Topic naming conventions

```
message.inbound.<source>.<...context>   — messages arriving from external interfaces
message.outbound.<dest>.<...context>    — messages to deliver to external interfaces
agent.skill.request / response.<id>     — skill dispatch pipeline
world.state.updated                     — domain poll results
world.goal.violated                     — GOAP goal breach
world.action.dispatch                   — GOAP action ready to execute
ceremony.<id>.execute                   — ceremony trigger
cron.<id>                               — scheduled event
security.incident.reported              — incident lifecycle
hitl.<stage>.<correlationId>            — human-in-the-loop lifecycle
command.<verb>                          — imperative plugin commands
```

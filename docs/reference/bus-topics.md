---
title: Bus Topics Reference
---

# Bus Topics Reference

All bus topics published and subscribed across all plugins and subsystems. Topic patterns use `#` as a multi-segment wildcard (MQTT-style). `{variable}` denotes a dynamic segment.

---

## Skill dispatch

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `agent.skill.request` | Internal | RouterPlugin, ActionDispatcherPlugin, CeremonyPlugin | SkillDispatcherPlugin | Requests execution of a named skill |
| `agent.skill.response.<correlationId>` | Internal | SkillDispatcherPlugin | Caller (varies) | Result of a skill execution |

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
| `message.inbound.discord.<channelId>` | Inbound | DiscordPlugin | RouterPlugin | @mention or DM received |
| `message.inbound.discord.slash.<interactionId>` | Inbound | DiscordPlugin | RouterPlugin | Slash command invoked |
| `message.outbound.discord.<channelId>` | Outbound | Agents | DiscordPlugin | Reply to a specific channel |
| `message.outbound.discord.push.<channelId>` | Outbound | CeremonyPlugin, ActionDispatcherPlugin | DiscordPlugin | Unprompted push (cron result, alert) |

**Inbound payload**:
```typescript
{
  sender: string;       // Discord user ID
  channel: string;      // Discord channel ID
  content: string;      // Cleaned message (mentions stripped)
  skillHint?: string;   // Set by slash commands and reaction handlers
  isReaction?: boolean;
  isThread?: boolean;
  guildId?: string;
}
```

---

## GOAP / world engine

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `world.state.updated` | Internal | WorldStateEngine | GoalEvaluatorPlugin | Domain data refreshed |
| `world.goal.violated` | Internal | GoalEvaluatorPlugin | PlannerPluginL0 | A goal evaluation failed |
| `world.action.plan` | Internal | PlannerPluginL0 | ActionDispatcherPlugin | A set of actions to execute |

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

**`world.action.plan` payload**:
```typescript
{
  actions: Array<{
    id: string;
    goalId: string;
    tier: string;
    meta: { topic: string; fireAndForget?: boolean; agentId?: string };
  }>;
  correlationId: string;
}
```

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
| `hitl.request.#` | Internal | Agents (e.g. ava post-plan) | HITLPlugin | Approval request |
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
world.action.plan                       — GOAP action plan
ceremony.<id>.execute                   — ceremony trigger
cron.<id>                               — scheduled event
security.incident.reported              — incident lifecycle
hitl.<stage>.<correlationId>            — human-in-the-loop lifecycle
command.<verb>                          — imperative plugin commands
```

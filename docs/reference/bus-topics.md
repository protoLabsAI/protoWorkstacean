# Bus Topics Reference

_This is a reference doc. It lists all bus topics published and subscribed across all plugins._

---

Topic patterns use `#` as a multi-segment wildcard (MQTT-style). `{variable}` denotes a dynamic segment.

---

## GitHub Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.github.{owner}.{repo}.{event}.{number}` | Inbound | GitHubPlugin | @mention received on issue or PR |
| `message.inbound.onboard` | Inbound | GitHubPlugin | New repository created in org |
| `message.outbound.github.{owner}.{repo}.{number}` | Outbound | A2APlugin | Reply to post as GitHub comment |

**Inbound payload** (`message.inbound.github.*`):
```typescript
{
  sender: string;       // GitHub username
  channel: string;      // "{owner}/{repo}#{number}"
  content: string;      // event header + title + body
  skillHint?: string;   // from github.yaml skillHints
  github: {
    event: string; owner: string; repo: string;
    number: number; title: string; url: string;
  };
}
```

---

## Discord Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.discord.{channelId}` | Inbound | DiscordPlugin | @mention or DM |
| `message.inbound.discord.slash.{interactionId}` | Inbound | DiscordPlugin | Slash command |
| `message.outbound.discord.{channelId}` | Outbound | A2APlugin | Reply to @mention or DM |
| `message.outbound.discord.slash.{interactionId}` | Outbound | A2APlugin | Reply to slash command |
| `message.outbound.discord.push.{channelId}` | Outbound | A2APlugin | Unprompted push (cron, etc.) |

Subscribe to `message.outbound.discord.#` to handle all outbound Discord delivery.

**Inbound payload**:
```typescript
{
  sender: string;       // Discord user ID
  channel: string;      // Discord channel ID
  content: string;      // cleaned message (mentions stripped)
  skillHint?: string;   // set by slash commands and 📋 reactions
  isReaction?: boolean;
  isThread?: boolean;
  guildId?: string;
}
```

---

## Plane Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.plane.issue.create` | Inbound | PlanePlugin | Issue created with `plan` or `auto` label |
| `message.inbound.plane.issue.update` | Inbound | PlanePlugin | Issue updated (not currently routed) |
| `plane.reply.{correlationId}` | Outbound | Ava | A2A reply — triggers Plane state PATCH + comment |

---

## A2A Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.#` | Subscribed | All interface plugins | All inbound messages — routed by skill |
| `cron.#` | Subscribed | SchedulerPlugin | Cron events — routed by skill |
| `message.outbound.*` | Published | A2APlugin | Agent responses |
| `message.outbound.discord.push.{channel}` | Published | A2APlugin | Cron responses to Discord |

---

## HITL Plugin

| Topic | Direction | Publisher | Subscriber | Description |
|-------|-----------|-----------|------------|-------------|
| `hitl.request.#` | Inbound | Ava | HITLPlugin | Approval request after SPARC PRD |
| `hitl.response.#` | Inbound | Interface plugin | HITLPlugin | Human decision |
| `hitl.pending.{correlationId}` | Outbound | HITLPlugin | API callers | Unrouted requests |
| `hitl.expired.{correlationId}` | Outbound | HITLPlugin | Any | Request TTL exceeded (60s sweep) |

---

## Scheduler Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `command.schedule` | Inbound | Any | Runtime schedule management (add/remove/pause/resume/list) |
| `schedule.list` | Outbound | SchedulerPlugin | Response to `action: list` |
| `cron.{id}` | Outbound | SchedulerPlugin | Fired when a schedule triggers |

**`command.schedule` payload**:
```typescript
{
  action: "add" | "remove" | "pause" | "resume" | "list";
  id?: string;
  schedule?: string;    // cron expression or ISO datetime
  timezone?: string;
  topic?: string;
  payload?: object;
}
```

---

## Google Plugin

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.gmail.{label}` | Inbound | GooglePlugin | Gmail message matching a watched label |
| `google.calendar.event.upcoming` | Outbound | GooglePlugin | Upcoming calendar events (polled) |
| `google.drive.file.created` | Outbound | GooglePlugin | New Drive file detected |

---

## Onboarding

| Topic | Direction | Publisher | Description |
|-------|-----------|-----------|-------------|
| `message.inbound.onboard` | Inbound | GitHubPlugin | New repo created — triggers `onboard_project` |

**Onboard payload**:
```typescript
{
  event: "repository.created";
  owner: string;
  repo: string;
  fullName: string;    // "owner/repo"
  url: string;
  description: string;
  isPrivate: boolean;
}
```

---

## Topic naming conventions

```
message.inbound.{source}.{...context}   — messages arriving from external interfaces
message.outbound.{dest}.{...context}    — messages to be delivered to external interfaces
command.{verb}                          — imperative commands to plugins
cron.{id}                               — scheduled event fires
hitl.{stage}.{correlationId}            — human-in-the-loop lifecycle
plane.reply.{correlationId}             — Plane sync-back events
google.{service}.{event}                — Google Workspace events
schedule.{action}                       — scheduler responses
```

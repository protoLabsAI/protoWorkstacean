---
title: Scheduler
---

Cron-style scheduled events that publish to the message bus. No external cron daemon needed.

## How It Works

```
User: "daily at 8a send me the weather"
  → Agent calls schedule_task tool (Pi SDK extension)
    → Tool validates cron expression, writes YAML to workspace/crons/
    → Publishes command.schedule to bus
      → SchedulerPlugin creates timer
        → [8am] Timer fires → publishes to cron.daily-weather
          → RouterPlugin processes via handleCron()
            → Agent fetches weather, composes response
              → Publishes to message.outbound.signal.{sender}
                → SignalPlugin sends via HTTP
```

## YAML Format

```yaml
# workspace/crons/daily-weather.yaml
id: daily-weather
schedule: "0 8 * * *"
timezone: "America/New_York"
topic: "cron.daily-weather"
payload:
  content: "Tell the user today's weather for their location. Keep it brief."
  sender: "cron"
  channel: "signal"
enabled: true
lastFired: "2026-04-02T12:00:00.000Z"
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (kebab-case). Used as filename. |
| `type` | No | `cron` or `once`. Auto-detected from schedule format if omitted. |
| `schedule` | Yes | Cron expression (`0 8 * * *`) = recurring. ISO datetime (`2026-04-01T15:00:00`) = one-shot. |
| `timezone` | No | IANA timezone. Defaults to system TZ. |
| `topic` | Yes | Bus topic to publish on fire (e.g., `cron.daily-weather`). |
| `payload.content` | Yes | Message the agent receives when this fires. |
| `payload.sender` | No | Sender identifier. Default: `cron`. |
| `payload.channel` | No | Reply channel (`signal`, `cli`). Default: `cli`. |
| `enabled` | No | Whether this schedule is active. Default: `true`. |
| `lastFired` | Auto | ISO timestamp of last fire. Updated by scheduler. |

## Bus Commands

The scheduler listens on `command.schedule` for runtime management.

### Add a schedule

```json
{
  "topic": "command.schedule",
  "payload": {
    "action": "add",
    "id": "daily-weather",
    "schedule": "0 8 * * *",
    "timezone": "America/New_York",
    "topic": "cron.daily-weather",
    "payload": {
      "content": "Tell the user today's weather",
      "sender": "cron",
      "channel": "signal"
    }
  }
}
```

### Remove a schedule

```json
{ "topic": "command.schedule", "payload": { "action": "remove", "id": "daily-weather" } }
```

### List schedules

```json
{ "topic": "command.schedule", "payload": { "action": "list" } }
```

Response published to `schedule.list`.

### Pause / Resume

```json
{ "topic": "command.schedule", "payload": { "action": "pause", "id": "daily-weather" } }
{ "topic": "command.schedule", "payload": { "action": "resume", "id": "daily-weather" } }
```

## Missed Fires

If a schedule was missed (container was down), it fires immediately on restart. Only fires once — if missed by more than 24 hours, it's skipped.

## Pi SDK Tool (Optional)

For natural language scheduling, register a tool in a Pi SDK extension:

```ts
pi.registerTool({
  name: "schedule_task",
  description: "Schedule a recurring or one-time task",
  parameters: Type.Object({
    id: Type.String(),
    schedule: Type.String(),
    message: Type.String(),
    channel: Type.Optional(StringEnum(["signal", "cli"])),
    timezone: Type.Optional(Type.String()),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // validate cron expression
    // write YAML to workspace/crons/{id}.yaml
    // publish command.schedule to bus
    return { content: [{ type: "text", text: `Scheduled ${params.id}` }], details: {} };
  },
});
```

## Timezone

- Default: system timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
- Override: `timezone` field in YAML
- Env var: `TZ` (standard, respected by most runtimes)

## One-Shot Schedules

Use an ISO datetime in the `schedule` field. The `type` is auto-detected. The schedule fires once and the YAML file is deleted.

```yaml
id: take-break-reminder
schedule: "2026-04-01T15:00:00"
topic: "cron.take-break-reminder"
payload:
  content: "Remind the user to take a break"
  sender: "cron"
  channel: "signal"
```

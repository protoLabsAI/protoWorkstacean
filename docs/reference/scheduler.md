---
title: Scheduler
---

Cron-style scheduled events that publish to the message bus. No external cron daemon needed.

## How It Works

```
workspace/crons/daily-weather.yaml created
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
| `payload.channel` | No | Where the fired schedule is delivered. `cli` / `signal` route to local agents (with the channel as the *reply* topic). `a2a` routes to a configured remote A2A endpoint — see [A2A delivery channel](#a2a-delivery-channel). Default: `cli`. |
| `enabled` | No | Whether this schedule is active. Default: `true`. |
| `lastFired` | Auto | ISO timestamp of last fire. Updated by scheduler. |

## Managing Schedules via API

Use `POST /publish` to send `command.schedule` messages from any external caller:

```bash
curl -X POST http://localhost:3000/publish \
  -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "command.schedule",
    "payload": {
      "action": "add",
      "id": "daily-weather",
      "schedule": "0 8 * * *",
      "timezone": "America/New_York",
      "topic": "cron.daily-weather",
      "payload": {
        "content": "Tell the user today'\''s weather",
        "sender": "cron",
        "channel": "signal"
      }
    }
  }'
```

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

## Timezone

- Default: system timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
- Override: `timezone` field in YAML
- Env var: `TZ` (standard, respected by most runtimes)

## A2A delivery channel

When `payload.channel` is `a2a`, the fired schedule is delivered to a remote A2A endpoint as a JSON-RPC `message/send` call instead of being processed by a local skill. Use this when Workstacean is acting as the scheduler for one or more remote agents (for example, [protoAgent](https://github.com/protoLabsAI/protoAgent) forks that subscribe via the `WorkstaceanScheduler` adapter).

### Topic naming convention

Use `cron.<agent_name>.<job_id>` so multi-fork deployments are trivially discoverable — operators can grep the topic list to see which agent is scheduling what.

### Required payload fields for `a2a`

| Field | Description |
|-------|-------------|
| `payload.channel` | Must be `"a2a"`. |
| `payload.agent_name` | Key into the `targets` map in `workspace/a2a.yaml`. Selects the destination endpoint. |
| `payload.scheduler_job_id` | Surfaced as `metadata.scheduler_job_id` on the outbound message so observers can tell scheduler-driven turns from user-driven ones. |
| `payload.content` | The user-message text sent to the A2A endpoint. |

### Configuration: `workspace/a2a.yaml`

```yaml
targets:
  gina-personal:
    url: http://gina-personal:7870/a2a
    bearer_token: ${GINA_PERSONAL_BEARER}
    api_key: ${GINA_PERSONAL_API_KEY}

  gina-work:
    url: http://gina-work:7871/a2a
    bearer_token: ${GINA_WORK_BEARER}
```

Both `bearer_token` and `api_key` are optional — provide whichever the target requires. `${ENV_VAR}` substitution is supported. When the file is absent, the channel is a no-op (cron firings with `channel: a2a` are dropped with a loud error).

### Example

```yaml
# workspace/crons/gina-personal-daily.yaml
id: gina-personal-daily
schedule: "0 9 * * 1-5"
topic: "cron.gina-personal.daily"
payload:
  content: "morning standup summary"
  sender: "scheduler"
  channel: "a2a"
  agent_name: "gina-personal"
  scheduler_job_id: "gina-personal-daily"
```

When this fires at 9am on weekdays, Workstacean POSTs to `http://gina-personal:7870/a2a` with:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "<uuid>",
      "role": "user",
      "parts": [{ "kind": "text", "text": "morning standup summary" }],
      "metadata": {
        "scheduler_job_id": "gina-personal-daily",
        "channel": "a2a",
        "agent_name": "gina-personal"
      }
    }
  }
}
```

For the protoAgent end-to-end wiring, see the [A2A scheduler bridge guide](../guides/a2a-scheduler-bridge/).

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

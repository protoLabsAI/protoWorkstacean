# How to Create a Ceremony (Scheduled Recurring Task)

_This is a how-to guide. It covers creating cron schedules via YAML, the bus, and the Pi SDK tool._

---

A "ceremony" is a scheduled recurring event — a daily digest, a weekly board audit, a nightly cleanup. In Workstacean, ceremonies are YAML files in `workspace/crons/` that publish to the message bus on a schedule.

---

## Option A — Write the YAML directly

Create a file in `workspace/crons/`:

```yaml
# workspace/crons/daily-digest.yaml
id: daily-digest
schedule: "0 14 * * *"         # 2pm UTC daily
timezone: "America/New_York"
topic: "cron.daily-digest"
payload:
  content: "Generate the daily QA digest"
  skillHint: qa_report
  channel: "1234567890123456789"  # Discord channel ID for push
  sender: "cron"
enabled: true
```

The SchedulerPlugin picks up the file on the next container start. No restart needed if you publish `command.schedule` (see Option B).

### YAML fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (kebab-case). Used as filename. |
| `type` | No | `cron` or `once`. Auto-detected from schedule format. |
| `schedule` | Yes | Cron expression for recurring, ISO datetime for one-shot. |
| `timezone` | No | IANA timezone. Defaults to system TZ. |
| `topic` | Yes | Bus topic to publish when the schedule fires. |
| `payload.content` | Yes | Message the agent receives when this fires. |
| `payload.sender` | No | Sender identifier. Default: `cron`. |
| `payload.channel` | No | Reply channel (`signal`, `cli`, or Discord channel ID). |
| `payload.skillHint` | No | Routes to a specific skill (e.g., `qa_report`, `board_audit`). |
| `enabled` | No | Whether active. Default: `true`. |
| `lastFired` | Auto | ISO timestamp updated by the scheduler on each fire. |

---

## Option B — Add via bus command at runtime

No restart needed — publish `command.schedule` to register a schedule immediately:

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "command.schedule",
    "payload": {
      "action": "add",
      "id": "daily-digest",
      "schedule": "0 14 * * *",
      "timezone": "America/New_York",
      "topic": "cron.daily-digest",
      "payload": {
        "content": "Generate the daily QA digest",
        "skillHint": "qa_report",
        "channel": "1234567890123456789",
        "sender": "cron"
      }
    }
  }'
```

The SchedulerPlugin creates the YAML file in `data/crons/` and activates the timer immediately.

---

## Option C — Ask the agent in natural language (Pi SDK tool)

If the `schedule_task` Pi SDK tool is registered:

```
Schedule a daily QA digest at 2pm New York time to the #dev-alerts channel
```

The agent calls the tool with the right cron expression, writes the YAML, and publishes `command.schedule`. No manual YAML editing needed.

---

## Managing schedules

### Pause a schedule

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{"topic": "command.schedule", "payload": {"action": "pause", "id": "daily-digest"}}'
```

### Resume a schedule

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{"topic": "command.schedule", "payload": {"action": "resume", "id": "daily-digest"}}'
```

### Remove a schedule

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{"topic": "command.schedule", "payload": {"action": "remove", "id": "daily-digest"}}'
```

### List all schedules

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{"topic": "command.schedule", "payload": {"action": "list"}}'
```

Response published to `schedule.list`.

---

## Create a one-shot ceremony

Use an ISO datetime in `schedule` to fire once and self-delete:

```yaml
id: q1-kickoff-reminder
schedule: "2026-04-01T09:00:00"
timezone: "America/New_York"
topic: "cron.q1-kickoff-reminder"
payload:
  content: "Remind the team about the Q1 kickoff meeting at 10am"
  sender: "cron"
  channel: "signal"
```

One-shot schedules are automatically deleted after firing.

---

## Missed fire behavior

If the container was down when a schedule was due, it fires immediately on restart — once only. If the missed window is more than 24 hours, it is skipped entirely and the next scheduled time applies.

---

## Related docs

- [reference/config-files.md](../reference/config-files.md) — full cron YAML schema
- [reference/bus-topics.md](../reference/bus-topics.md) — cron and schedule command topics
- [explanation/plugin-lifecycle.md](../explanation/plugin-lifecycle.md) — how SchedulerPlugin loads and manages timers

---
title: Create a Ceremony
---

# Create a Ceremony

A **ceremony** is a scheduled skill invocation — a recurring fleet ritual defined in YAML, fired by a cron expression, and dispatched through the standard skill routing pipeline.

Ceremonies are distinct from GOAP actions. Actions react to world-state violations. Ceremonies run on a fixed schedule regardless of world state, like a daily standup or a weekly retrospective.

## How ceremonies work

1. `SchedulerPlugin` fires a `cron.<id>` bus event at the scheduled time
2. `RouterPlugin` receives it, identifies it as a ceremony, and publishes `ceremony.<id>.execute`
3. `CeremonyPlugin` subscribes to `ceremony.#.execute`, loads the ceremony definition, and dispatches `agent.skill.request` with the configured skill and targets
4. `SkillDispatcherPlugin` routes the request to the matching executor

The ceremony YAML is the only configuration required.

## Ceremony YAML schema

Create a file in `workspace/ceremonies/<id>.yaml`:

```yaml
# workspace/ceremonies/daily-standup.yaml

# Must match the file name (without .yaml).
id: daily-standup

# Human-readable name.
name: "Daily Fleet Standup"

# Optional description — shown in /api/ceremonies.
description: "Morning ceremony: board summary, active ceremonies, open PRs"

# Cron expression (UTC). Standard 5-field cron.
schedule: "0 9 * * 1-5"

# Skill name to dispatch. Must be registered by an agent.
skill: board_audit

# Agent names to route this skill to. If multiple, all receive it.
# Leave empty to use default routing (skill-match or default executor).
targets:
  - ava

# Discord channel ID for the response. Leave empty to suppress Discord posting.
notifyChannel: "1469195643590541353"

# Set to false to disable without deleting the file.
enabled: true
```

## Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique ceremony ID. Must match the filename (without `.yaml`). |
| `name` | Yes | Human-readable name shown in the API and logs. |
| `description` | No | Explains the purpose of the ceremony. |
| `schedule` | Yes | 5-field cron expression (UTC). Examples below. |
| `skill` | Yes | Skill name dispatched via `agent.skill.request`. |
| `targets` | No | Agent names for explicit routing. Empty = default routing. |
| `notifyChannel` | No | Discord channel ID for delivery. Empty = no Discord post. |
| `enabled` | No | `true` (default) or `false` to suspend without deleting. |

## Cron expression examples

| Schedule | Expression |
|----------|-----------|
| Weekdays at 9:00 UTC | `0 9 * * 1-5` |
| Every 30 minutes | `*/30 * * * *` |
| Every 3 hours | `0 */3 * * *` |
| Mondays at 9:00 UTC | `0 9 * * 1` |
| Daily at midnight | `0 0 * * *` |

## Triggering a ceremony manually

Ceremonies can be triggered outside their schedule via the HTTP API:

```bash
curl -X POST http://localhost:3000/api/ceremonies/daily-standup/run \
  -H "X-API-Key: $WORKSTACEAN_API_KEY"
```

Or by publishing to the bus:

```bash
curl -X POST http://localhost:3000/publish \
  -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "ceremony.daily-standup.execute", "payload": {}}'
```

## Listing ceremonies

```bash
curl http://localhost:3000/api/ceremonies
```

Response:

```json
[
  {
    "id": "daily-standup",
    "name": "Daily Fleet Standup",
    "schedule": "0 9 * * 1-5",
    "skill": "board_audit",
    "enabled": true,
    "nextRun": "2026-04-09T09:00:00.000Z"
  }
]
```

## Example: security triage ceremony

This ceremony runs hourly and is also triggered by a GOAP action (see `workspace/actions.yaml`):

```yaml
# workspace/ceremonies/security-triage.yaml
id: security-triage
name: "Security Incident Triage"
description: "Investigates open security incidents and reports resolution status."
schedule: "0 * * * *"
skill: bug_triage
targets: []
notifyChannel: ""
enabled: true
```

When `ActionDispatcherPlugin` fires the `ceremony.security_triage` GOAP action, it publishes `ceremony.security-triage.execute`, which triggers this ceremony immediately — using the same code path as the cron schedule.

## Example: weekly retrospective

```yaml
# workspace/ceremonies/weekly-retro.yaml
id: weekly-retro
name: "Weekly Retrospective"
schedule: "0 9 * * 1"
skill: pattern_analysis
targets:
  - ava
notifyChannel: "1469195643590541355"
enabled: true
```

`ava` receives the `pattern_analysis` skill request every Monday at 9:00 UTC and posts its output to the configured Discord channel.

## Adding a ceremony

1. Create the file `workspace/ceremonies/<id>.yaml` with the schema above
2. Restart the server (ceremonies are loaded at startup)
3. Confirm it appears in `GET /api/ceremonies`
4. Optionally trigger it manually to verify the skill routes correctly

## Related

- [Add an agent](\1/) — register the agent that will run the ceremony's skill
- [Bus topics reference](\1/) — `ceremony.<id>.execute`, `cron.<id>`
- [Workspace files reference](\1/)

---
title: Create a Ceremony
---

A **ceremony** is a scheduled skill invocation — a recurring fleet ritual defined in YAML, fired by a cron expression, and dispatched through the standard skill routing pipeline.

Ceremonies are distinct from GOAP actions. Actions react to world-state violations. Ceremonies run on a fixed schedule regardless of world state, like a daily standup or a weekly retrospective.

## How ceremonies work

1. `CeremonyPlugin` owns an internal cron timer for each enabled ceremony and fires `ceremony.<id>.execute` at the scheduled time
2. `CeremonyPlugin` publishes `agent.skill.request` with the configured skill and targets
3. `SkillDispatcherPlugin` routes the request to the matching executor (in-process or A2A)
4. On terminal response (or 120s timeout) `CeremonyPlugin` publishes `ceremony.<id>.completed` and persists the outcome to `knowledge.db`

Ceremony YAML is hot-reloaded every 5 seconds — drop a file and it's live without a restart.

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
  - protomaker

# Discord channel ID for the response. Leave empty to suppress Discord posting.
notifyChannel: "1469195643590541353"

# Set to false to disable without deleting the file.
enabled: true

# Ownership marker — stamped automatically when created via API with a
# per-agent key. Controls who can update/delete through the HTTP API.
# Operator-authored ceremonies omit this (treated as "system"-owned).
createdBy: quinn
```

## Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique ceremony ID. Must match the filename (without `.yaml`). |
| `name` | Yes | Human-readable name shown in the API and logs. |
| `description` | No | Explains the purpose of the ceremony. |
| `schedule` | Yes | 5-field cron expression (UTC). Examples below. |
| `skill` | Yes | Skill name dispatched via `agent.skill.request`. |
| `targets` | Yes | Non-empty array of agent names (e.g. `["quinn"]`), or `["all"]` for fleet broadcast. |
| `notifyChannel` | No | Discord channel ID for delivery. Empty = no Discord post. |
| `enabled` | No | `true` (default) or `false` to suspend without deleting. |
| `createdBy` | No | Owning agent name. Stamped automatically when created via the HTTP API with a per-agent key; operator-written files typically omit it. Enforced by `/api/ceremonies/:id/update` and `/api/ceremonies/:id/delete`. |

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
curl -H "X-API-Key: $WORKSTACEAN_API_KEY" http://localhost:3000/api/ceremonies
```

Admin keys see every ceremony; per-agent keys (`WORKSTACEAN_API_KEY_<AGENT>`) return only ceremonies where `createdBy` matches the caller. Admins can pass `?all=true` to see everything regardless of owner.

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "daily-standup",
      "name": "Daily Fleet Standup",
      "schedule": "0 9 * * 1-5",
      "skill": "board_audit",
      "targets": ["ava"],
      "notifyChannel": "1469195643590541353",
      "enabled": true
    }
  ]
}
```

## Creating ceremonies at runtime

Drop a file into `workspace/ceremonies/` (hot-reloaded in ≤5s) *or* call the API:

```bash
curl -X POST http://localhost:3000/api/ceremonies/create \
  -H "X-API-Key: $WORKSTACEAN_API_KEY_QUINN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "quinn.hourly-sweep",
    "name": "Hourly Sweep",
    "schedule": "0 * * * *",
    "skill": "qa_report",
    "targets": ["quinn"]
  }'
```

When called with a per-agent key, `createdBy` is stamped server-side. Agents can then update or delete only ceremonies they own; admins can manage any. See [Build an A2A agent → Scheduled work](./build-an-a2a-agent#scheduled-work-ceremonies) for the agent-side `manage_cron` tool pattern.

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
  - protomaker
notifyChannel: "1469195643590541355"
enabled: true
```

The protoMaker team receives the `pattern_analysis` skill request every Monday at 9:00 UTC and posts its output to the configured Discord channel.

## Adding a ceremony

1. Create the file `workspace/ceremonies/<id>.yaml` with the schema above (or POST to `/api/ceremonies/create`)
2. Wait ≤5s for the hot-reload watcher, or confirm immediately via `GET /api/ceremonies`
3. Optionally trigger it manually with `/api/ceremonies/<id>/run` to verify the skill routes correctly

## Related

- [Add an agent](./add-an-agent) — register the agent that will run the ceremony's skill
- [Bus topics reference](../../reference/bus-topics) — `ceremony.<id>.execute`, `cron.<id>`
- [Workspace files reference](../../reference/workspace-files)

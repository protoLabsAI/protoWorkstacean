---
title: CeremonyPlugin Reference
---

CeremonyPlugin replaces hardcoded cron tasks with configurable, observable, and hot-reloadable YAML-defined ceremonies. A **ceremony** is a recurring scheduled ritual — for example, a daily board health check, PR triage, or weekly sprint review.

## What is a Ceremony?

A ceremony is a named, cron-scheduled task that:

- Fires on a cron schedule (e.g. every morning at 9am, every Friday at 5pm)
- Invokes an agent skill against one or more project targets
- Publishes lifecycle events on the EventBus
- Persists execution outcomes to `knowledge.db`
- Optionally notifies a Discord channel on completion

Ceremonies are defined in YAML files placed in `workspace/ceremonies/`. They are loaded at startup and hot-reloaded every 5 seconds when files change, with no restart required.

## YAML Schema

Each ceremony is defined in its own `.yaml` file inside `workspace/ceremonies/`.

```yaml
id: board.pr-audit          # required — unique ceremony identifier
name: PR Audit              # required — human-readable name
schedule: "0 9 * * 1-5"    # required — cron expression (UTC)
skill: audit-prs            # required — agent skill to invoke
targets:                    # required — project paths or ['all']
  - projects/my-project
notifyChannel: eng-standup  # optional — Discord channel slug for notifications
enabled: true               # optional — defaults to true; set false to pause
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier, e.g. `board.pr-audit`. Used in bus topics. |
| `name` | string | yes | Human-readable name shown in logs and notifications. |
| `schedule` | string | yes | Standard 5-field cron expression (UTC). |
| `skill` | string | yes | Agent skill invoked when the ceremony fires. |
| `targets` | string[] | yes | Non-empty list of project paths, or `['all']` to target all projects. |
| `notifyChannel` | string | no | Discord channel slug for outcome notifications. |
| `enabled` | boolean | no | Whether this ceremony is active. Defaults to `true`. |

### Cron Expression Examples

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | 9:00 AM UTC, Monday–Friday |
| `0 17 * * 5` | 5:00 PM UTC on Fridays |
| `0 */3 * * *` | Every 3 hours |
| `0 8 * * 1` | 8:00 AM UTC every Monday |

## File Layout

```
workspace/
  ceremonies/                        # global ceremonies (all projects)
    board-pr-audit.yaml
    weekly-sprint-review.yaml

.proto/
  projects/
    {project-slug}/
      ceremonies/                    # project-scoped overrides
        board-pr-audit.yaml          # overrides global ceremony with same id
```

Project-level ceremonies with the same `id` override global ones. All other global ceremonies are inherited unchanged.

## How CeremonyPlugin Integrates with the Scheduler and Bus

At startup, `CeremonyPlugin.install(bus)`:

1. Loads all ceremony YAML files via `CeremonyYamlLoader`
2. Schedules a cron timer for each enabled ceremony
3. Starts a 5-second hot-reload polling loop

When a ceremony fires:

1. Publishes `ceremony.{id}.execute` on the EventBus
2. Publishes `agent.skill.request` to dispatch the skill to an agent
3. Waits up to 120 seconds for `agent.skill.response.{runId}`
4. Publishes `ceremony.{id}.completed` with the outcome
5. Persists the outcome to `knowledge.db` (capped at 500 entries per ceremony)
6. Sends a Discord notification if `notifyChannel` is set

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `ceremony.{id}.execute` | published | Fired when a ceremony's cron triggers |
| `ceremony.{id}.completed` | published | Fired after a ceremony run finishes |
| `agent.skill.request` | published | Dispatches the skill to an agent for execution |
| `agent.skill.response.{runId}` | subscribed | Result from the agent skill execution |
| `ceremony.#` | subscribed | Wildcard — used internally to intercept completed events |
| `world.state.snapshot` | published | Ceremony state update via `CeremonyStateExtension` |

### Execute Payload (`ceremony.{id}.execute`)

```typescript
{
  type: "ceremony.execute",
  context: {
    runId: string,          // UUID for this run
    ceremonyId: string,
    projectPaths: string[], // resolved targets
    startedAt: number,      // Unix ms
  },
  skill: string,
  ceremonyName: string,
}
```

### Completed Payload (`ceremony.{id}.completed`)

```typescript
{
  type: "ceremony.completed",
  outcome: {
    runId: string,
    ceremonyId: string,
    skill: string,
    status: "success" | "failure" | "timeout",
    duration: number,       // ms
    targets: string[],
    startedAt: number,
    completedAt: number,
    result?: string,        // optional summary from skill
    error?: string,         // set on failure or timeout
  }
}
```

## Built-in vs Custom Ceremonies

**Built-in ceremonies** ship as default YAML files in `src/plugins/ceremonies/defaults/`. On first run, CeremonyPlugin copies any missing defaults into `workspace/ceremonies/`. You can edit these files to customize them — they will not be overwritten on subsequent runs.

**Custom ceremonies** are any YAML files you add to `workspace/ceremonies/` or `.proto/projects/{slug}/ceremonies/`. There is no registration step — just drop the file and it will be picked up within 5 seconds.

## Outcome Persistence

Ceremony outcomes are stored in `knowledge.db` using `CeremonyOutcomesRepository`. Each ceremony retains up to 500 historical outcomes; older entries are pruned automatically. Status values are `success`, `failure`, and `timeout` (after 120 seconds with no skill response).

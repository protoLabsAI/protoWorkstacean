# How to Create a Ceremony

Ceremonies are recurring scheduled rituals defined in YAML and powered by CeremonyPlugin. This guide walks through adding one to your workspace.

## Step 1: Create a YAML file in `workspace/ceremonies/`

Each ceremony lives in its own `.yaml` file. The filename doesn't matter — the `id` field is the identifier.

```bash
touch workspace/ceremonies/my-ceremony.yaml
```

## Step 2: Define the ceremony

Open the file and add the required fields:

```yaml
id: my-ceremony             # unique identifier
name: My Ceremony           # human-readable label
schedule: "0 9 * * 1-5"    # cron expression (UTC)
skill: my-skill             # agent skill to invoke
targets:
  - projects/my-project     # project path, or 'all' for all projects
```

That's the minimum. CeremonyPlugin polls for changes every 5 seconds — no restart needed.

## Example: Daily Board Health Check at 9am

```yaml
id: board.health-check
name: Daily Board Health Check
schedule: "0 9 * * 1-5"
skill: board-health-check
targets:
  - all
notifyChannel: eng-standup
```

- Runs at 9:00 AM UTC, Monday through Friday
- Invokes the `board-health-check` skill across all projects
- Posts a summary to the `#eng-standup` Discord channel

## Example: Weekly Sprint Review on Fridays

```yaml
id: sprint.weekly-review
name: Weekly Sprint Review
schedule: "0 17 * * 5"
skill: sprint-review
targets:
  - projects/alpha
  - projects/beta
notifyChannel: sprint-reviews
```

- Runs at 5:00 PM UTC every Friday
- Invokes `sprint-review` for `projects/alpha` and `projects/beta`
- Posts results to `#sprint-reviews`

## Optional Fields

```yaml
notifyChannel: my-channel   # Discord channel slug — omit to skip notifications
enabled: false              # set to false to temporarily pause without deleting
```

## Project-Scoped Overrides

To override a global ceremony for a specific project, create a file with the same `id` at:

```
.automaker/projects/{project-slug}/ceremonies/my-ceremony.yaml
```

The project-level definition takes precedence over the global one. All other global ceremonies are inherited unchanged.

## How to Test a Ceremony Manually

To trigger a ceremony immediately without waiting for its cron schedule, publish a `ceremony.{id}.execute` event directly on the EventBus:

```typescript
const runId = crypto.randomUUID();
const ceremonyId = "board.health-check";

bus.publish(`ceremony.${ceremonyId}.execute`, {
  id: crypto.randomUUID(),
  correlationId: runId,
  topic: `ceremony.${ceremonyId}.execute`,
  timestamp: Date.now(),
  payload: {
    type: "ceremony.execute",
    context: {
      runId,
      ceremonyId,
      projectPaths: ["projects/my-project"],
      startedAt: Date.now(),
    },
    skill: "board-health-check",
    ceremonyName: "Daily Board Health Check",
  },
});
```

Listen on `ceremony.{id}.completed` to see the outcome:

```typescript
bus.subscribe(`ceremony.${ceremonyId}.completed`, "test", (msg) => {
  const { outcome } = msg.payload;
  console.log(`Status: ${outcome.status}, duration: ${outcome.duration}ms`);
  if (outcome.result) console.log("Result:", outcome.result);
  if (outcome.error) console.log("Error:", outcome.error);
});
```

The plugin dispatches the skill via `agent.skill.request` and waits up to 120 seconds for a response on `agent.skill.response.{runId}`. If no response arrives, the run is marked `timeout`.

## Related Docs

- [reference/ceremony-plugin.md](../reference/ceremony-plugin.md) — full schema, bus topics, and internals

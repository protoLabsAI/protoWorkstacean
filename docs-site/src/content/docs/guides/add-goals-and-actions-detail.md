---
title: Goal Registry & Evaluator (Milestone 2)
---

# Goal Registry & Evaluator (Milestone 2)

The Goal Evaluator is an observe-only plugin that continuously monitors world state
against declared goals and emits violation events when deviations are detected.

## Architecture

```
world.state.# ──► GoalEvaluatorPlugin
                        │
                        ├── GoalsLoader (workspace/goals.yaml + per-project overrides)
                        ├── InvariantGoalEvaluator
                        ├── ThresholdGoalEvaluator
                        ├── DistributionGoalEvaluator
                        │
                        ├── EventBus.publish("world.goal.violated", ...)
                        ├── LangfuseLogger (HTTP ingestion API)
                        └── DiscordLogger (webhook)
```

## Configuration

The plugin is configured via `GoalsConfig`:

```typescript
import { GoalEvaluatorPlugin } from "./src/plugins/goal_evaluator_plugin.ts";

const plugin = new GoalEvaluatorPlugin({
  workspaceDir: "workspace",
  observeOnly: true,  // always true — no planner in this milestone
});
plugin.install(bus);
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse public API key |
| `LANGFUSE_SECRET_KEY` | Langfuse secret API key |
| `LANGFUSE_HOST` | Langfuse host (default: `https://cloud.langfuse.com`) |
| `DISCORD_GOALS_WEBHOOK_URL` | Discord webhook URL for violation notifications |

## Goals File Format

See [goals-schema.md](./goals-schema.md) for the full schema reference.

Example `workspace/goals.yaml`:

```yaml
version: "1.0"
goals:
  - id: auth-healthy
    type: Invariant
    description: Auth service must be healthy
    severity: critical
    selector: services.auth.status
    operator: eq
    expected: "healthy"

  - id: cpu-ok
    type: Threshold
    description: CPU must stay below 80%
    severity: high
    selector: metrics.cpu.usage
    max: 80
```

## World State Topic Convention

The plugin subscribes to `world.state.#`. Publish world state updates with:

```typescript
bus.publish("world.state.update", {
  id: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  topic: "world.state.update",
  timestamp: Date.now(),
  payload: {
    projectSlug: "my-project",  // optional
    state: {
      services: { auth: { status: "healthy" } },
      metrics: { cpu: { usage: 45 } },
    },
  },
});
```

## Violation Events

When a goal is violated, the plugin emits a `world.goal.violated` event:

```typescript
{
  topic: "world.goal.violated",
  payload: {
    type: "world.goal.violated",
    violation: {
      goalId: "auth-healthy",
      goalType: "Invariant",
      severity: "critical",
      description: "Auth service must be healthy",
      message: "Expected \"services.auth.status\" to equal \"healthy\", got \"degraded\"",
      actual: "degraded",
      expected: "healthy",
      timestamp: 1712345678000,
      projectSlug: "my-project",
    },
  },
}
```

See [events.md](./events.md) for the full event catalog.

## Observe-Only Mode

The plugin **never triggers planner actions**. It only:
1. Evaluates goals against world state
2. Emits `world.goal.violated` events
3. Logs violations to Langfuse and Discord

Planner integration is deferred to a future milestone.

## Per-Project Goal Overrides

Place a `goals.yaml` file at `.proto/projects/{slug}/goals.yaml`.
Project goals with the same `id` override global goals. New IDs are additive.

---
title: Your First GOAP Goal
---

# Your First GOAP Goal

This tutorial walks through the complete lifecycle of a GOAP goal: defining a goal, writing a matching action, watching the world engine detect a violation, and seeing the action dispatched.

You will build a simple goal that monitors a custom HTTP endpoint reporting a service's error rate and sends a Discord alert when it crosses a threshold.

## Prerequisites

- protoWorkstacean running locally (see [Getting Started](./getting-started.md))
- A domain that reports numeric data — this tutorial uses a mock endpoint, but the same pattern applies to any HTTP collector
- A Discord channel configured (optional — the action can target any topic)

## Concepts recap

The GOAP loop is:

```
WorldStateEngine polls domains
  → GoalEvaluatorPlugin checks goals against current state
    → Emits world.goal.violated when a goal is breached
      → PlannerPluginL0 maps violations to actions via goalId
        → ActionDispatcherPlugin fires the action (publishes to action.meta.topic)
```

Goals express **what should be true**. Actions express **what to do when it is not**.

## Step 1 — Register a domain

Create or edit `workspace/domains.yaml`. This instructs WorldStateEngine to poll an HTTP endpoint every 30 seconds and store the result under the key `domains.error_rate`:

```yaml
domains:
  - name: error_rate
    url: http://localhost:9000/metrics/error-rate
    tickMs: 30000
    headers:
      X-API-Key: "${METRICS_API_KEY}"
```

The `${METRICS_API_KEY}` syntax reads from the process environment at startup. Set it in `.env`:

```dotenv
METRICS_API_KEY=my-internal-key
```

Your endpoint should return JSON. For this tutorial, assume it returns:

```json
{ "rate": 0.12 }
```

WorldStateEngine stores the full response body under `domains.error_rate.data`. So `domains.error_rate.data.rate` holds `0.12`.

Start (or restart) the server and confirm the domain is being polled:

```bash
curl http://localhost:3000/api/world-state/error_rate
# {"name":"error_rate","data":{"rate":0.12},"collectedAt":"2026-04-08T09:00:00.000Z"}
```

## Step 2 — Write a goal

Add to `workspace/goals.yaml`:

```yaml
goals:
  - id: services.error_rate_healthy
    type: Threshold
    severity: high
    selector: "domains.error_rate.data.rate"
    max: 0.05
    description: "Service error rate must stay below 5%"
```

Goal fields:

| Field | Meaning |
|-------|---------|
| `id` | Unique identifier — referenced by actions via `goalId` |
| `type` | `Threshold`, `Invariant`, or `Distribution` |
| `severity` | `low`, `medium`, `high`, `critical` — affects planner priority |
| `selector` | Dot-path into world state (the same shape returned by `/api/world-state`) |
| `max` | Upper bound. Use `min` for a lower bound. Both can be set. |

GoalEvaluatorPlugin reloads `goals.yaml` on startup and evaluates every goal against every `world.state.updated` event. When `domains.error_rate.data.rate > 0.05`, it emits `world.goal.violated` with this goal's ID.

## Step 3 — Write an action

Add to `workspace/actions.yaml`:

```yaml
actions:
  - id: alert.error_rate_high
    goalId: services.error_rate_healthy
    tier: tier_0
    priority: 10
    cost: 1
    name: "Alert on high error rate"
    preconditions:
      - path: "domains.error_rate.data.rate"
        operator: gt
        value: 0.05
    effects: []
    meta:
      topic: "message.outbound.discord.push.1234567890"
      fireAndForget: true
```

Action fields:

| Field | Meaning |
|-------|---------|
| `goalId` | Which goal this action addresses |
| `tier` | `tier_0` = deterministic/cheap, `tier_1` = A* planned, `tier_2` = LLM |
| `preconditions` | Guard — world state conditions that must be true before dispatching |
| `effects` | State mutations the action applies after execution (can be empty for alerts) |
| `meta.topic` | Bus topic ActionDispatcherPlugin publishes to when the action fires |
| `meta.fireAndForget` | Do not wait for a response |

`preconditions` use the same dot-path selectors as goals. Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `exists`, `not_exists`.

## Step 4 — Watch it fire

Restart the server so it picks up the new goal and action. Then simulate a threshold breach by temporarily serving a high error rate from your endpoint:

```json
{ "rate": 0.15 }
```

Wait up to `tickMs` (30 seconds) for the next poll. In the server logs you should see:

```
[world-state] domain error_rate updated
[goal-evaluator] VIOLATION services.error_rate_healthy — rate=0.15 > max=0.05
[planner-l0] plan: [alert.error_rate_high]
[action-dispatcher] firing action alert.error_rate_high → message.outbound.discord.push.1234567890
```

If DiscordPlugin is running, the alert appears in your configured channel. Otherwise, the outbound message is logged to the event log.

Confirm via API:

```bash
# Check current goals status
curl http://localhost:3000/api/goals
```

## What you built

```
domains.yaml        → WorldStateEngine polls /metrics/error-rate every 30s
goals.yaml          → GoalEvaluatorPlugin detects when rate > 5%
actions.yaml        → PlannerPluginL0 selects alert.error_rate_high
                    → ActionDispatcherPlugin publishes to Discord
```

## Next steps

- [Add goals and actions](../guides/add-goals-and-actions.md) — full reference for goal types, operators, and effect types
- [Add a domain](../guides/add-a-domain.md) — ENV interpolation, custom headers, tick intervals
- [Create a ceremony](../guides/create-a-ceremony.md) — scheduled skills that run on cron

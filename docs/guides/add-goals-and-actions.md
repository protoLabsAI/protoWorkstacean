---
title: Add Goals and Actions
---

Goals define the invariants and thresholds the system must maintain. Actions define what to do when a goal is violated. Together they form the GOAP (Goal-Oriented Action Planning) loop.

Goals are evaluated continuously by `GoalEvaluatorPlugin` against the live world state. When a goal is violated, `PlannerPluginL0` selects matching actions from `ActionRegistry`. `ActionDispatcherPlugin` fires them subject to a WIP limit.

## Goals

Edit `workspace/goals.yaml`:

```yaml
goals:
  - id: my.goal
    type: Threshold
    severity: medium
    selector: "domains.my_service.data.value"
    min: 10
    max: 100
    description: "Value must stay between 10 and 100"
```

### Goal types

#### Threshold

Checks a numeric value against `min` and/or `max` bounds. Both are optional — you can set only one.

```yaml
- id: ci.success_rate_healthy
  type: Threshold
  severity: high
  selector: "domains.ci.data.successRate"
  min: 0.70
  description: "CI success rate must stay >= 70%"
```

Violated when: `value < min` OR `value > max`.

#### Invariant

Checks that a value satisfies a boolean condition.

```yaml
- id: security.no_open_incidents
  type: Invariant
  severity: critical
  selector: "domains.security.data.openIncidents"
  operator: falsy
  description: "No open security incidents"
```

Supported operators: `truthy`, `falsy`, `exists`, `not_exists`.

Violated when the operator condition is not met.

#### Distribution

Checks that a distribution of named categories meets proportion targets, with a tolerance band.

```yaml
- id: flow.distribution_balanced
  type: Distribution
  severity: medium
  description: "Board must have >= 40% features, <= 30% defects"
  distribution:
    feature: 0.40
    defect: 0.30
  tolerance: 0.10
```

The `selector` for Distribution goals points to an object whose keys are category names and values are counts. The evaluator computes proportions and compares against the targets within `tolerance`.

### Goal fields reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique goal ID. Referenced by actions via `goalId`. |
| `type` | Yes | `Threshold` \| `Invariant` \| `Distribution` | Evaluation strategy. |
| `severity` | Yes | `low` \| `medium` \| `high` \| `critical` | Affects planner priority and alert routing. |
| `selector` | Yes (Threshold/Invariant) | string | Dot-path into world state. |
| `min` | No (Threshold) | number | Lower bound (inclusive). |
| `max` | No (Threshold) | number | Upper bound (inclusive). |
| `operator` | Yes (Invariant) | string | `truthy`, `falsy`, `exists`, `not_exists`. |
| `distribution` | Yes (Distribution) | Record<string, number> | Target proportions (0–1). |
| `tolerance` | No (Distribution) | number | Allowed deviation (default: `0.05`). |
| `description` | No | string | Human-readable explanation. Appears in logs and API. |

---

## Actions

Edit `workspace/actions.yaml`:

```yaml
actions:
  - id: my.action
    goalId: my.goal
    tier: tier_0
    priority: 10
    cost: 1
    name: "Human-readable name"
    preconditions:
      - path: "domains.my_service.data.value"
        operator: lt
        value: 10
    effects:
      - path: "domains.my_service.data.alerted"
        type: set
        value: true
    meta:
      topic: "message.outbound.discord.push.1234567890"
      fireAndForget: true
```

### Preconditions

Preconditions guard action dispatch. All conditions must be true simultaneously for an action to be selected. If any condition fails, the action is skipped.

```yaml
preconditions:
  - path: "domains.my_service.data.errorCount"
    operator: gt
    value: 0

  - path: "domains.ci.data.successRate"
    operator: gte
    value: 0.70
```

#### Supported operators

| Operator | Meaning |
|----------|---------|
| `eq` | Strictly equal |
| `neq` | Not equal |
| `gt` | Greater than |
| `gte` | Greater than or equal |
| `lt` | Less than |
| `lte` | Less than or equal |
| `exists` | Key exists and is not null/undefined |
| `not_exists` | Key is missing, null, or undefined |

The `path` is a dot-path into the world state — same syntax as `selector` in goals.

### Effects

Effects describe how the world state changes after the action runs. They are applied by the planner when simulating action sequences (useful for tier_1/tier_2 plans). For tier_0 fire-and-forget actions they are informational.

```yaml
effects:
  - path: "domains.my_service.data.alertSent"
    type: set
    value: true

  - path: "domains.my_service.data.alertCount"
    type: increment
    value: 1
```

#### Supported effect types

| Type | Meaning |
|------|---------|
| `set` | Set the path to `value` |
| `increment` | Add `value` to the current numeric value |
| `decrement` | Subtract `value` from the current numeric value |
| `delete` | Remove the key |

### Tiers

| Tier | Meaning |
|------|---------|
| `tier_0` | Deterministic, cheap — alert sends, ceremony triggers. Executed immediately. |
| `tier_1` | A*-planned — requires plan-level sequencing, multi-step recovery. |
| `tier_2` | LLM-driven — requires autonomous reasoning to decide next step. |

Most alert and ceremony-trigger actions should be `tier_0`. Reserve higher tiers for actions that need to be sequenced with other actions or that require agent judgment.

### Action fields reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique action ID. |
| `goalId` | Yes | string | Which goal this action remedies. Must match a goal `id`. |
| `tier` | Yes | `tier_0` \| `tier_1` \| `tier_2` | Execution tier. |
| `priority` | No | number | Higher priority actions are preferred when multiple match. Default: `0`. |
| `cost` | No | number | Planning cost (used by A* for tier_1). Default: `1`. |
| `name` | No | string | Human-readable name. |
| `preconditions` | No | array | Guard conditions. All must be true. |
| `effects` | No | array | World state mutations applied after execution. |
| `meta.topic` | Yes | string | Bus topic to publish on when the action fires. |
| `meta.agentId` | No | string | Hint to route the action to a specific agent. |
| `meta.fireAndForget` | No | boolean | Do not wait for a response. Default: `false`. |
| `meta.payload` | No | object | Extra payload fields merged into the dispatched message. |

---

## Full example: service health monitoring

```yaml
# workspace/goals.yaml
goals:
  - id: services.all_healthy
    type: Invariant
    severity: high
    selector: "domains.services.metadata.failed"
    operator: falsy
    description: "No service collection failures"

# workspace/actions.yaml
actions:
  - id: alert.service_collection_failed
    goalId: services.all_healthy
    tier: tier_0
    priority: 20
    cost: 1
    name: "Alert on service collection failure"
    preconditions:
      - path: "domains.services.metadata.failed"
        operator: exists
    effects: []
    meta:
      topic: "message.outbound.discord.push.ops-channel"
      fireAndForget: true

  - id: ceremony.health_check
    goalId: services.all_healthy
    tier: tier_0
    priority: 10
    cost: 1
    name: "Trigger health check ceremony"
    preconditions:
      - path: "domains.services.metadata.failed"
        operator: exists
    effects: []
    meta:
      topic: "ceremony.health_check.execute"
      fireAndForget: true
```

## Related

- [Your first GOAP goal](../tutorials/first-goap-goal.md) — end-to-end walkthrough
- [Add a domain](./add-a-domain.md) — defining the data sources goals evaluate
- [Explanation: world engine](../explanation/world-engine.md)
- [Workspace files reference](../reference/workspace-files.md)

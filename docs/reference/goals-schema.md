# goals.yaml Schema Reference

The `goals.yaml` file defines observable goals for the GoalEvaluatorPlugin.
Goals are evaluated against incoming world state events. Violations are emitted
as `world.goal.violated` events and logged to Langfuse and Discord.

## File Locations

| Scope | Path |
|-------|------|
| Global | `workspace/goals.yaml` |
| Per-project override | `.proto/projects/{slug}/goals.yaml` |

Project-level goals override global goals with the same `id`.

## Top-Level Structure

```yaml
version: "1.0"  # optional
goals:
  - id: unique-goal-id
    type: Invariant | Threshold | Distribution
    description: Human-readable description
    severity: low | medium | high | critical  # default: medium
    enabled: true  # default: true
    tags: [optional, labels]
    # ... type-specific fields
```

## Goal Types

### Invariant

Checks a boolean condition against a world state value.

```yaml
- id: auth-service-healthy
  type: Invariant
  description: Auth service must be healthy
  severity: critical
  selector: services.auth.status
  operator: eq
  expected: "healthy"
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `selector` | Yes | Dot-notation path into world state |
| `operator` | No | `eq`, `neq`, `truthy`, `falsy`, `in`, `not_in` (default: `truthy`) |
| `expected` | No | Expected value for comparison |

**Operators:**
- `truthy` — value must be truthy (non-null, non-false, non-zero, non-empty)
- `falsy` — value must be falsy
- `eq` — value must equal `expected`
- `neq` — value must not equal `expected`
- `in` — value must be in `expected` array
- `not_in` — value must not be in `expected` array

### Threshold

Checks a numeric metric against min/max bounds.

```yaml
- id: cpu-usage-ok
  type: Threshold
  description: CPU usage must stay below 80%
  severity: high
  selector: metrics.cpu.usage
  max: 80
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `selector` | Yes | Dot-notation path resolving to a number |
| `min` | Conditional | Minimum allowed value (at least one of min/max required) |
| `max` | Conditional | Maximum allowed value |

### Distribution

Checks patterns or value proportions in an array/map.

```yaml
- id: agent-status-distribution
  type: Distribution
  description: Most agents should be active
  severity: medium
  selector: agents.statuses
  distribution:
    active: 0.8
    idle: 0.2
  tolerance: 0.1
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `selector` | Yes | Dot-notation path resolving to an array or object |
| `pattern` | No | Regex — all values must match |
| `distribution` | No | Expected value proportions `{ value: fraction }` |
| `tolerance` | No | Allowed deviation from expected fraction (default: `0.1`) |

## Severity Levels

| Level | Color | Use case |
|-------|-------|----------|
| `low` | Blue | Informational, non-urgent |
| `medium` | Orange | Should investigate soon |
| `high` | Red | Requires prompt attention |
| `critical` | Purple | System-breaking condition |

## JSON Schema

The full JSON schema is at `schema/goals.yaml.schema.json`.

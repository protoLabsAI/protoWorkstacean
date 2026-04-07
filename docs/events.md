# Event Catalog

This document describes events published by the GoalEvaluatorPlugin.

## world.goal.violated

Emitted when a goal evaluation detects a violation.

**Topic:** `world.goal.violated`

**Payload:**

```typescript
{
  type: "world.goal.violated";
  violation: {
    goalId: string;          // Goal identifier from goals.yaml
    goalType: "Invariant" | "Threshold" | "Distribution";
    severity: "low" | "medium" | "high" | "critical";
    description: string;     // Human-readable goal description
    message: string;         // Specific violation message
    actual: unknown;         // Actual value observed in world state
    expected: unknown;       // Expected value/bounds
    timestamp: number;       // Unix milliseconds
    projectSlug?: string;    // Project context (if scoped)
  };
}
```

**Example:**

```json
{
  "topic": "world.goal.violated",
  "payload": {
    "type": "world.goal.violated",
    "violation": {
      "goalId": "cpu-ok",
      "goalType": "Threshold",
      "severity": "high",
      "description": "CPU must stay below 80%",
      "message": "\"metrics.cpu.usage\" value 92 exceeds maximum threshold 80",
      "actual": 92,
      "expected": { "max": 80 },
      "timestamp": 1712345678000,
      "projectSlug": "protoworkstacean"
    }
  }
}
```

## world.state.# (input)

The plugin subscribes to `world.state.#` for incoming world state.

**Expected payload:**

```typescript
{
  state: Record<string, unknown>;  // The world state to evaluate against
  projectSlug?: string;            // Optional project scope
}
```

Or the entire payload is treated as the world state if no `state` key is present.

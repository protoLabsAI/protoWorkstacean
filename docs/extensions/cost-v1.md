---
title: "Extension: x-protolabscost-v1"
---

`x-protolabscost-v1` is an A2A agent card extension that lets skills declare their expected cost estimates and enables the runtime to record observed actuals. The interceptor maintains exponential moving averages that converge on real behaviour over time and publishes `autonomous.cost.#` events after each execution.

**Extension URI**: `https://protolabs.ai/a2a/ext/cost-v1`

---

## Purpose

Without cost declarations, the budget system can only estimate costs from prompt text length heuristics. When a skill declares its expected token and wall-time costs, the runtime can:

- Stamp expected cost hints onto outbound metadata so agents can self-calibrate
- Record observed actuals and compute running averages per agent+skill pair
- Surface cost telemetry to any subscriber via `autonomous.cost.<agentName>` events
- Drive future budget tier pre-flight decisions with empirical rather than estimated data

---

## Schema

Declared inside the A2A agent card under `capabilities.extensions`:

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/cost-v1
      params:
        skills:
          <skill_name>:
            avgTokensIn: <number>
            avgTokensOut: <number>
            avgWallMs: <number>
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avgTokensIn` | `number` | yes | Expected average input tokens (prompt + context) for this skill |
| `avgTokensOut` | `number` | yes | Expected average output tokens for this skill |
| `avgWallMs` | `number` | yes | Expected average wall-clock milliseconds for this skill to complete |

These are **estimates** used as starting priors. The runtime overwrites them over time as real observations accumulate via the EMA.

---

## Example

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/cost-v1
      params:
        skills:
          deep_research:
            avgTokensIn: 2000
            avgTokensOut: 8000
            avgWallMs: 300000
          summarize:
            avgTokensIn: 500
            avgTokensOut: 200
            avgWallMs: 15000
```

---

## Outbound metadata

When an agent card advertises this extension and an estimate is registered, the `before()` hook stamps three keys onto the request metadata:

| Key | Value |
|-----|-------|
| `x-cost-v1-estimated-tokens-in` | `avgTokensIn` from the registered estimate |
| `x-cost-v1-estimated-tokens-out` | `avgTokensOut` from the registered estimate |
| `x-cost-v1-estimated-wall-ms` | `avgWallMs` from the registered estimate |

Remote agents may use these hints to surface a budget summary in their response.

---

## Published event: `autonomous.cost.<agentName>`

After each skill execution, the `after()` hook publishes one bus message on `autonomous.cost.<agentName>`. Subscribe to `autonomous.cost.#` to receive all cost events or `autonomous.cost.researcher` to receive events for a specific agent.

### Payload shape

```typescript
interface CostActualPayload {
  source: string;           // agent name
  skill: string;            // skill that executed
  correlationId: string;    // trace ID
  // Agent card estimate (0 if none registered)
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedWallMs: number;
  // Observed actuals
  actualTokensIn: number | undefined;   // undefined if not reported by the agent
  actualTokensOut: number | undefined;  // undefined if not reported by the agent
  actualWallMs: number;                 // measured wall-clock ms
  // Updated running averages (EMA, alpha=0.2)
  runningAvgTokensIn: number;
  runningAvgTokensOut: number;
  runningAvgWallMs: number;
  sampleCount: number;      // total observations for this agent+skill pair
}
```

### Running average algorithm

The runtime uses an exponential moving average (EMA) with `alpha = 0.2`:

```
new_avg = old_avg × 0.8 + sample × 0.2   (for count > 1)
new_avg = sample                           (for count = 1, initialisation)
```

This gives more weight to historical observations than to any single outlier, while still tracking real-world drift over time.

---

## Registering the extension

### Runtime startup (`src/index.ts`)

`registerCostV1Extension(bus)` is called once at startup and wires the interceptor into `defaultExtensionRegistry`.

### Seeding estimates from agent cards

When the SkillBrokerPlugin discovers an agent card that declares `cost-v1` params, call `registerEstimate()` on the returned handle to seed the prior:

```typescript
const costExtension = registerCostV1Extension(bus);
// Later, after reading agent card:
costExtension.registerEstimate("researcher", "deep_research", {
  avgTokensIn: 2000,
  avgTokensOut: 8000,
  avgWallMs: 300_000,
});
```

### In-process agent (workspace/agents/\<name\>.yaml)

In-process agents do not use the A2A agent card format. Register estimates programmatically in the startup sequence after loading the agent YAML.

### External A2A agent (agent card)

Add the extension to the agent's `/.well-known/agent-card.json`:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://protolabs.ai/a2a/ext/cost-v1",
        "params": {
          "skills": {
            "deep_research": {
              "avgTokensIn": 2000,
              "avgTokensOut": 8000,
              "avgWallMs": 300000
            }
          }
        }
      }
    ]
  }
}
```

---

## Versioning

This is version 1 of the cost extension. The URI `https://protolabs.ai/a2a/ext/cost-v1` is stable. Breaking changes (field renames, semantic changes to average algorithm) will be published under a new versioned URI.

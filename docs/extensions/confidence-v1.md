---
title: "Extension: x-protolabs/confidence-v1"
---

`x-protolabs/confidence-v1` captures the agent's self-reported confidence in its output so OutcomeAnalysis can weight failure signals by how sure the agent was, and the planner can prefer high-confidence candidates when ranking.

**Extension URI**: `https://protolabs.ai/a2a/ext/confidence-v1`

---

## Why observed confidence matters

A high-confidence failure is a stronger signal than a low-confidence one. A low-confidence success shouldn't get the same weight as a high-confidence success in aggregate quality metrics. Without this signal, every success and failure counts equally — masking agents that are lucky at low confidence and flagging agents that correctly hedge.

The companion metric `highConfFailures` tracks calibration drift: if an agent routinely reports 0.95 confidence on outputs that fail, their self-assessment is miscalibrated and should be down-weighted independently.

---

## Interceptor behavior

Registered in `src/index.ts` at startup:

```ts
import { registerConfidenceExtension } from "./executor/extensions/confidence.ts";
registerConfidenceExtension(bus);
```

`A2AExecutor.execute()` runs the interceptor before and after every outbound call:

**before** — stamps `x-confidence-skill: <skill>` onto outbound JSON-RPC metadata. This gives the agent an explicit handle to attach a confidence score in its terminal message.

**after** — reads `result.data.confidence` (a number in `[0, 1]`) and optional `result.data.confidenceExplanation`. If `confidence` isn't set the interceptor no-ops (agents that don't support the extension produce no samples). Values are clamped defensively — a badly-formatted `1.2` or `-0.1` won't poison the store.

Records a `ConfidenceSample` to `defaultConfidenceStore` and publishes `autonomous.confidence.{systemActor}.{skill}`.

---

## Sample shape

```ts
interface ConfidenceSample {
  systemActor: string;
  agentName: string;
  skill: string;
  confidence: number;        // 0.0 - 1.0
  explanation?: string;
  success: boolean;          // from result.data.success
  completedAt: number;
  correlationId: string;
}
```

---

## Store API

`ConfidenceStore` keeps the last 200 samples per `${agentName}::${skill}` key. Exposed via `defaultConfidenceStore`:

```ts
const summary = defaultConfidenceStore.summary("quinn", "pr_review");
// {
//   agentName: "quinn",
//   skill: "pr_review",
//   sampleCount: 18,
//   avgConfidence: 0.87,
//   avgConfidenceOnSuccess: 0.91,
//   avgConfidenceOnFailure: 0.62,
//   highConfFailures: 2       // calibration warning: ≥ 0.8 confidence but task failed
// }
```

`highConfFailures` counts samples where `confidence >= 0.8` but `success === false`. A rising count is a signal the agent's self-assessment is overconfident and its priors should be discounted.

---

## Agent response contract

An agent participating in confidence-v1 sets these fields on the terminal message's `data` part:

```json
{
  "kind": "data",
  "data": {
    "confidence": 0.82,
    "confidenceExplanation": "Spec was ambiguous on edge case; chose the conservative interpretation.",
    "success": true
  }
}
```

Agents that don't implement the extension return normal A2A responses — the interceptor simply skips sample recording for them.

---

## Planner integration

`PlannerPluginL0` reads `defaultConfidenceStore` alongside `defaultCostStore` when ranking effect-based candidates:

```
score (warm) = 2.0 * cost.successRate
             + 0.5 * confidence.avgConfidenceOnSuccess
             - 0.3 * clamp(cost.avgWallMs / 60_000, 0, 2)
```

`avgConfidenceOnSuccess` specifically (not overall average) is used — it answers "when this agent succeeds at this skill, how sure is it?" which is the right question for ranking future candidates.

See [`self-improving-loop.md`](../explanation/self-improving-loop.md) for the full flow.

---

## Bus topic

```
autonomous.confidence.{systemActor}.{skill}
```

Payload is the raw `ConfidenceSample`. Subscribers: dashboard calibration view, OutcomeAnalysis (elevating high-confidence-failure clusters), external telemetry collectors.

---

## Related

- [`cost-v1`](cost-v1.md) — companion metric; planner reads both together
- [`effect-domain-v1`](effect-domain-v1.md) — card-side declaration of effects; observed confidence overrides the declared prior once warm

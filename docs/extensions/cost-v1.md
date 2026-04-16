---
title: "Extension: x-protolabs/cost-v1"
---

`x-protolabs/cost-v1` records per-(agent, skill) token + wall-time actuals for every A2A dispatch, feeds a rolling in-memory store, and publishes `autonomous.cost.*` observability events. The planner reads from the store to rank candidate skills by observed success rate + cost-per-call.

**Extension URI**: `https://protolabs.ai/a2a/ext/cost-v1`

---

## Purpose

Two signals the planner needs but couldn't get from the agent card alone:

- **Success rate** — how often this (agent, skill) combination actually succeeds, independent of the agent's self-declared confidence
- **Wall-time cost** — how long a call takes end-to-end, including retries and HITL round-trips

Without observations, the planner falls back to the card's confidence field (what the agent claims about itself). cost-v1 replaces self-advertisement with measurement once ≥ 5 samples exist per key.

---

## Interceptor behavior

Registered in `src/index.ts` at startup:

```ts
import { registerCostExtension } from "./executor/extensions/cost.ts";
registerCostExtension(bus);
```

`A2AExecutor.execute()` runs the interceptor before and after every outbound call:

**before** — stamps `x-cost-skill: <skill>` onto outbound JSON-RPC metadata so the agent can correlate cost advertisements with invocations.

**after** — reads `result.data.usage` (A2A SDK surfaces Anthropic-shaped `{input_tokens, output_tokens, cache_*}`) plus `result.data.durationMs` and `result.data.costUsd`. Records a `CostSample` to `defaultCostStore` and publishes `autonomous.cost.{systemActor}.{skill}` on the bus.

The interceptor self-gates: if the response lacks `usage` fields the sample records wall-time only, and no publish is suppressed — dashboards can observe what's available.

---

## Sample shape

```ts
interface CostSample {
  systemActor: string;      // "user" | "goap" | "ceremony:<id>" | ...
  agentName: string;
  skill: string;
  tokensIn?: number;
  tokensOut?: number;
  wallMs: number;
  costUsd?: number;
  success: boolean;
  completedAt: number;      // ms epoch
  correlationId: string;
}
```

---

## Store API

`CostStore` keeps the last 200 samples per `${agentName}::${skill}` key (in-memory, rolling). Exposed via `defaultCostStore`:

```ts
const summary = defaultCostStore.summary("quinn", "pr_review");
// {
//   agentName: "quinn",
//   skill: "pr_review",
//   sampleCount: 23,
//   avgTokensIn: 8520,
//   avgTokensOut: 1204,
//   avgWallMs: 14_230,
//   avgCostUsd: 0.024,
//   successRate: 0.96
// }
```

`allSummaries()` returns one entry per (agent, skill) pair seen — drives the fleet cost-per-outcome dashboard view.

**Intentionally in-memory.** Cost tracking here is observational telemetry, not billing. A durable persistence layer can subscribe to `autonomous.cost.#` and ingest samples independently.

---

## Planner integration

`PlannerPluginL0` queries `defaultCostStore` when ranking candidates for effect-based dispatch:

- ≥ 5 samples → warm: sort by `2.0 * successRate + 0.5 * avgConfidenceOnSuccess − 0.3 * clamp(avgWallMs / 60_000, 0, 2)`
- \< 5 samples → cold: fall back to card-declared confidence

See [`self-improving-loop.md`](../explanation/self-improving-loop.md) for the full observation → ranking flow.

---

## Bus topic

```
autonomous.cost.{systemActor}.{skill}
```

Payload is the raw `CostSample` above. Used for:

- Dashboard fleet cost view
- OutcomeAnalysis alerting (`ops.alert.action_quality` when success rate drops below 50% after 10+ attempts)
- External collectors / billing systems that subscribe to `autonomous.cost.#`

---

## Reference implementations

| Side | Where | Notes |
|---|---|---|
| **Extraction** (consumer) | [`src/executor/executors/a2a-executor.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/src/executor/executors/a2a-executor.ts) — added in #372 | Scans terminal Task artifact parts for `application/vnd.protolabs.cost-v1+json`, flattens onto `result.data` so the cost interceptor records the sample |
| **Emission** (producer) | [`Quinn/a2a_handler.py::_terminal_artifact_parts`](https://github.com/protoLabsAI/quinn/blob/main/a2a_handler.py) + [`Quinn/server.py::_chat_langgraph_stream`](https://github.com/protoLabsAI/quinn/blob/main/server.py) — added in Quinn #56 | Captures `on_chat_model_end` events from LangGraph for `usage_metadata`, accumulates onto `TaskRecord.usage`, emits the DataPart on COMPLETED |

Quinn currently emits `usage` + `durationMs` only — `costUsd` capture from the LiteLLM gateway response is a follow-up. Consumers tolerate missing `costUsd` and can derive it from per-model rates if needed.

---

## Related

- [`confidence-v1`](confidence-v1.md) — companion extension for agent-reported confidence, read alongside cost in the same planner ranking
- [`effect-domain-v1`](effect-domain-v1.md) — card-side effect declarations; Arc 6.4 ranking layers observed cost/confidence on top
- [`worldstate-delta-v1`](worldstate-delta-v1.md) — artifact format for observed mutations

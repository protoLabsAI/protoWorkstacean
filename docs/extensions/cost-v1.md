---
title: "Extension: x-protolabs/cost-v1"
---

`x-protolabs/cost-v1` records per-(agent, skill) token + wall-time actuals for every A2A dispatch, feeds a rolling in-memory store, and publishes `autonomous.cost.*` observability events. The store surfaces observed success rate + cost-per-call for the observability API's cost-summary dashboards.

**Extension URI**: `https://proto-labs.ai/a2a/ext/cost-v1`

---

## Purpose

Two signals that the agent card alone can't provide:

- **Success rate** — how often this (agent, skill) combination actually succeeds, independent of the agent's self-declared confidence
- **Wall-time cost** — how long a call takes end-to-end, including retries and HITL round-trips

These are *measured* rather than self-advertised: the store accumulates per-key actuals so dashboards reflect observed behavior once samples exist.

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

`allSummaries()` returns one entry per (agent, skill) pair seen — read by the observability API (`GET /api/cost-summaries`) to drive the cost-per-outcome dashboard view.

**Intentionally in-memory.** Cost tracking here is observational telemetry, not billing. A durable persistence layer can subscribe to `autonomous.cost.#` and ingest samples independently.

---

## Consumers

`defaultCostStore` is read by the **observability API** (`src/api/observability.ts`, `GET /api/cost-summaries`), which surfaces per-(agent, skill) success rate, average wall time, and dollar cost for dashboards.

Health-weighted dispatch inside `ExecutorRegistry` is a **separate** path — it sources its metrics from `AgentFleetHealthPlugin` (which aggregates `autonomous.outcome.#` events over a rolling window), not from this cost store. When multiple agents serve the same skill, the registry selects probabilistically **per agent** by `successRate × (1 / (1 + costPerSuccessfulOutcome))` (`_healthWeight` in `executor-registry.ts`). The cold-start gate is on observed outcomes: an agent with **zero recorded outcomes** (`totalOutcomes === 0`) falls back to neutral weight 1.0 so new agents still get tried.

---

## Bus topic

```
autonomous.cost.{systemActor}.{skill}
```

Payload is the raw `CostSample` above. Used for the dashboard fleet-cost view and any external subscriber that wants to project cost data into its own pipeline.
- External collectors / billing systems that subscribe to `autonomous.cost.#`

---

## Reference implementations

| Side | Where | Notes |
|---|---|---|
| **Extraction** (consumer) | [`src/executor/executors/a2a-executor.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/src/executor/executors/a2a-executor.ts) — added in #372 | Scans terminal Task artifact parts for `application/vnd.protolabs.cost-v1+json`, flattens onto `result.data` so the cost interceptor records the sample. This applies to **remote A2A agents** — the only live one is `protopen`. |
| **Emission** (producer) | Remote A2A agent's `/a2a` handler | The remote agent surfaces `usage` + `durationMs` (and optionally `costUsd`) on the terminal Task — workstacean's interceptor reads it off `result.data`. |

This extension only fires on the A2A dispatch path. In-process DeepAgents (`ava`, `quinn`, `proto`, `protobot`) run inside the workstacean process — there is no JSON-RPC round-trip and no SQLite layer; their token/wall-time accounting comes from the runtime's own telemetry, not this interceptor. (Quinn was absorbed from a standalone service; its old Python `server.py` / SQLite cost path no longer exists.)

Consumers tolerate a missing `costUsd` and can derive it from per-model rates if needed.

---

## Related

- [`confidence-v1`](confidence-v1) — companion extension for agent-reported confidence, surfaced alongside cost
- [`effect-domain-v1`](effect-domain-v1) — after-hook that re-publishes agent-reported `world.state.delta` for observability
- [`worldstate-delta-v1`](worldstate-delta-v1) — artifact format for observed mutations

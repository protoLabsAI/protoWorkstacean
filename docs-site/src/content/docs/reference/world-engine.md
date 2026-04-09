---
title: World Engine Reference
---

_This is a reference doc. It covers schemas, formats, API surface, and bus topics — not conceptual explanations._

See also: [`explanation/world-engine-concepts.md`](../explanation/world-engine-concepts) for the design rationale behind these components.

---

## World State Schema

`WorldStateEngine` is generic — it makes no assumptions about what domains exist. Domain data shape is entirely defined by the application via `workspace/domains.yaml`.

```typescript
// Engine-level types only. Domain data is application-defined.

interface WorldState {
  domains: Record<string, WorldStateDomain<unknown>>;
  snapshotVersion: number;   // incremented on each knowledge.db write
}

interface WorldStateDomain<T = unknown> {
  data: T;
  metadata: WorldStateMetadata;
}

interface WorldStateMetadata {
  collectedAt: number;   // Unix ms
  domain: string;
  tickNumber: number;
  failed?: boolean;
  errorMessage?: string;
}
```

### Domain registration

Domains are registered via `workspace/domains.yaml` (see [Workspace Files](./workspace-files/) for schema). Each domain declares:

- `name` — unique key in the world state map
- `url` — HTTP endpoint to poll (env vars interpolated at poll time)
- `intervalMs` — poll interval (default: 60 000 ms)
- `headers` — optional request headers

There are no built-in or hardcoded domain names. All domains are configuration.

### Redis sink

Each domain write stores two keys:

```
worldstate:{domain}:{collectedAt}   — timestamped snapshot
worldstate:{domain}:latest          — stable "latest" key for polling
```

TTL is 2× the domain's `intervalMs`. When Redis is unavailable, `WorldStateEngine` falls back to an in-memory `Map`.

### knowledge.db persistence

`WorldStateEngine` writes the full `WorldState` to `data/knowledge.db` (SQLite) every 5 minutes (configurable via `snapshotIntervalMs`). On startup it restores the latest snapshot. The last 50 snapshots are retained; older rows are pruned.

---

## goals.yaml Format

Goals are declared in `workspace/goals.yaml` with optional per-project overrides at `.proto/projects/{slug}/goals.yaml`.

```yaml
version: "1.0"
goals:
  - id: auth-service-healthy
    type: Invariant
    description: Auth service must be healthy
    severity: critical
    enabled: true         # default: true
    tags: [infrastructure]
    selector: services.auth.status
    operator: eq
    expected: "healthy"

  - id: cpu-usage-ok
    type: Threshold
    description: CPU must stay below 80%
    severity: high
    selector: metrics.cpu.usage
    max: 80

  - id: flow-distribution
    type: Distribution
    description: Feature work must be at least 40% of WIP
    severity: medium
    selector: flow.distribution
    distribution:
      feature: 0.4
    tolerance: 0.1
```

### Goal types

| Type | What it checks | Required fields |
|------|---------------|-----------------|
| `Invariant` | Boolean condition on a state value | `selector`, optionally `operator`, `expected` |
| `Threshold` | Numeric min/max bounds | `selector`, at least one of `min` / `max` |
| `Distribution` | Value proportions in an array/object | `selector`, `distribution` or `pattern` |

**Invariant operators:** `truthy` (default), `falsy`, `eq`, `neq`, `in`, `not_in`

### Severity levels

| Level | Color | Use |
|-------|-------|-----|
| `low` | Blue | Informational |
| `medium` | Orange | Should investigate |
| `high` | Red | Requires prompt attention |
| `critical` | Purple | System-breaking |

### Violation event

When a goal is violated, `GoalEvaluatorPlugin` emits `world.goal.violated`:

```typescript
{
  topic: "world.goal.violated",
  payload: {
    type: "world.goal.violated",
    violation: {
      goalId: string;
      goalType: "Invariant" | "Threshold" | "Distribution";
      severity: "low" | "medium" | "high" | "critical";
      description: string;
      message: string;   // human-readable diff
      actual: unknown;
      expected: unknown;
      timestamp: number;
      projectSlug?: string;
    };
  }
}
```

---

## Escalation Ladder

When a goal is violated the system tries the cheapest capable tier first.

```
Goal violated
    │
    ▼
L0 — Deterministic rule matcher
    Match found?  ── Yes ──► Execute action (no LLM, no cost)
    │ No
    ▼
L1 — A* planner (HTN/GOAP)
    Plan found within budget?  ── Yes ──► Execute plan (cheap model call)
    │ No or over budget
    ▼
L2 — Ava (LLM reasoning)
    Within L2 cost threshold?  ── Yes ──► Ava evaluates and acts
    │ No
    ▼
L3 — Human in the loop (HITL)
    BudgetPlugin publishes hitl.request.budget.{requestId}
    Human approves/rejects via Discord/Plane/API
```

Each escalation tier corresponds to a cost threshold enforced by `BudgetPlugin` and `TierRouter`:

| Tier | Label | Max est. cost | Min remaining budget | Action |
|------|-------|--------------|---------------------|--------|
| L0 | Autonomous | < $0.10 | ≥ 50% | Execute immediately |
| L1 | Notify | < $1.00 | ≥ 25% | Execute, notify ops channel |
| L2 | Soft-gate | < $5.00 | ≥ 10% | Log warning, execute with caution |
| L3 | HITL Required | unlimited | any | Block, escalate to human |

Daily caps: **$10 per project per day**, **$50 total across all projects**.

---

## Budget / Cost Estimation API

`BudgetPlugin` handles pre-flight cost checks. Any agent publishes a `BudgetRequest` and waits for a `BudgetDecision`.

### Request

Publish to `budget.request.{requestId}`:

```typescript
{
  type: "budget_request";
  requestId: string;           // UUID
  agentId: string;
  projectId: string;
  goalId?: string;
  modelId?: string;            // e.g. "claude-sonnet-4-6"
  promptText?: string;         // used for heuristic token count
  estimatedPromptTokens?: number;
  estimatedCompletionTokens?: number;
}
```

### Decision

Subscribe to `budget.decision.{requestId}`:

```typescript
{
  type: "budget_decision";
  requestId: string;
  tier: "L0" | "L1" | "L2" | "L3";
  approved: boolean;
  estimatedCost: number;    // USD
  maxCost: number;          // conservative upper bound (1.5× if heuristic used)
  budgetState: BudgetState;
  reason: string;
  escalationContext?: EscalationContext;  // present when tier === "L3"
}
```

### Actual cost reconciliation

After execution, publish to `budget.actual.{requestId}`:

```typescript
{
  type: "budget_actual";
  requestId: string;
  agentId: string;
  projectId: string;
  actualCost: number;
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
}
```

Discrepancies > 20% between estimated and actual cost trigger an `ops.alert.budget` event.

### Cost estimation

`pre_flight_estimate` uses a 4-chars-per-token heuristic when token counts are not supplied. The conservative `maxCost` is 1.5× the estimate when heuristics are used.

| Model | Input ($/token) | Output ($/token) |
|-------|-----------------|------------------|
| `claude-opus-4-6` | $0.000015 | $0.000075 |
| `claude-sonnet-4-6` | $0.000003 | $0.000015 |
| `claude-haiku-4-5` | $0.00000025 | $0.00000125 |
| `default` | $0.000003 | $0.000015 |

---

## Flow Monitor Metrics

`FlowMonitorPlugin` continuously tracks 5 Flow Framework metrics. Metrics are recomputed on every work item event and on a 60 s background tick.

### Metric definitions

**1. Velocity** — items completed per period

```typescript
{
  currentPeriodCount: number;     // completions in current 24 h window
  rollingAverage: number;         // 30-day rolling average
  trend: number;                  // (recent 3d − prior 3d) / prior 3d
  history: VelocityDataPoint[];   // 30 daily data points
  period: "daily";
  calculatedAt: number;
}
```

**2. Lead Time** — creation-to-completion duration (requires ≥ 5 samples)

```typescript
{
  p50Ms: number | null;
  p85Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
  state: "PENDING" | "READY";
  minRequired: 5;
  calculatedAt: number;
}
```

**3. Efficiency** — active time ÷ total cycle time (target: ≥ 35%)

```typescript
{
  ratio: number;        // 0.0–1.0
  target: 0.35;
  healthy: boolean;     // ratio >= 0.35
  totalActiveMs: number;
  totalCycleMs: number;
  byStage: Record<string, { activeMs: number; cycleMs: number; ratio: number }>;
  calculatedAt: number;
}
```

**4. Load (WIP)** — work-in-progress count with Little's Law enforcement

```typescript
{
  totalWIP: number;
  byStage: Record<string, number>;
  wipLimit: WIPLimitResult;
  calculatedAt: number;
}

// WIPLimitResult:
{
  state: "PENDING" | "ok" | "exceeded";
  currentWIP: number;
  wipLimit: number | null;    // null while PENDING (< 5 lead-time samples)
  suggestedDelayMs?: number;  // delay hint when exceeded
  waitQueue: string[];        // item IDs held back
}
```

**5. Distribution** — feature / defect / risk / debt ratio

```typescript
{
  ratios: { feature: number; defect: number; risk: number; debt: number };
  counts: { feature: number; defect: number; risk: number; debt: number };
  total: number;
  balanced: boolean;   // feature >= 40% AND defect <= 30%
  recommended: { feature: 0.4; defect: 0.3; risk: 0.15; debt: 0.15 };
  calculatedAt: number;
}
```

### WIP limits (Little's Law)

Little's Law: `WIP = Throughput × Lead Time`. The WIP limit is set to 1.5× the calculated WIP ceiling. When exceeded, new dispatch requests are queued (not rejected) with a `suggestedDelayMs` hint.

### Bottleneck detection (Theory of Constraints)

Stages are ranked by total accumulation time (item count × avg dwell time). A stage is flagged as a bottleneck when avg dwell exceeds 2 hours. The primary bottleneck is the highest-ranked stage.

---

## Bus Topics — World Engine

### WorldStateCollectorPlugin

| Topic | Direction | Description |
|-------|-----------|-------------|
| `tool.world_state.get` | Inbound | Bus-based world state query |
| `mcp.tool.get_world_state` | Inbound | MCP tool invocation |
| `event.world_state.db_error` | Outbound | knowledge.db write failure |

**`tool.world_state.get` / `mcp.tool.get_world_state` payload:**

```typescript
{
  domain?: string;  // any registered domain name from domains.yaml
  maxAgeMs?: number;   // reject stale data (default: 60000 ms)
}
```

Reply published to `msg.reply.topic`:

```typescript
{ success: true; data: WorldState | WorldStateDomain<unknown> }
// or
{ success: false; error: string }
```

### FlowMonitorPlugin

| Topic | Direction | Description |
|-------|-----------|-------------|
| `flow.item.created` | Inbound | Register a new work item |
| `flow.item.updated` | Inbound | Update item status/stage |
| `flow.item.completed` | Inbound | Mark item complete (production) |
| `flow.item.dispatch` | Inbound | Request to dispatch (WIP gating) |
| `tool.flow.metrics.get` | Inbound | Query current metrics |
| `mcp.tool.get_flow_metrics` | Inbound | MCP tool invocation |
| `event.flow.metrics.updated` | Outbound | After each metric tick |
| `event.flow.wip_exceeded` | Outbound | WIP limit breached |
| `event.flow.bottleneck.detected` | Outbound | Significant bottleneck found |
| `event.flow.goal.updated` | Outbound | Goal state changed |
| `event.flow.efficiency.debug` | Outbound | Debug when efficiency < 35% |

**`flow.item.created` payload:**

```typescript
{
  id?: string;        // UUID generated if omitted
  type: "feature" | "defect" | "risk" | "debt";
  stage: string;      // e.g. "backlog", "in-progress", "review"
  createdAt?: number; // Unix ms (defaults to now)
  meta?: Record<string, unknown>;
}
```

**`flow.item.dispatch` reply (WIP gating):**

```typescript
// Accepted:
{ accepted: true; currentWIP: number; wipLimit: number }

// Rejected (WIP exceeded):
{
  accepted: false;
  reason: "WIP_EXCEEDED";
  currentWIP: number;
  wipLimit: number;
  suggestedDelayMs: number;
  queuePosition: number;
}
```

### BudgetPlugin

| Topic | Direction | Description |
|-------|-----------|-------------|
| `budget.request.#` | Inbound | Pre-flight cost check |
| `budget.actual.#` | Inbound | Post-execution cost reconciliation |
| `budget.decision.{requestId}` | Outbound | Tier decision (approved/rejected) |
| `hitl.request.budget.{requestId}` | Outbound | L3 HITL escalation |
| `budget.alert.threshold` | Outbound | 50% or 80% budget threshold crossed |
| `budget.circuit.open.{key}` | Outbound | Circuit breaker opened |
| `ops.alert.budget` | Outbound | Autonomous rate below 85%, or cost discrepancy |

### GoalEvaluatorPlugin

| Topic | Direction | Description |
|-------|-----------|-------------|
| `world.state.#` | Inbound | World state updates to evaluate |
| `world.goal.violated` | Outbound | Goal violation detected |

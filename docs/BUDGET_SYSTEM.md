# Budget System — Architecture & Design

## Overview

The BudgetPlugin provides cost-aware budget management for the Workstacean bus.
It enforces daily spending caps, routes requests through tiered execution levels,
and escalates expensive requests to human review.

**Daily caps:**
- `$10` per project per day (`MAX_PROJECT_BUDGET`)
- `$50` total across all projects per day (`MAX_DAILY_BUDGET`)

**Autonomous rate target:** 85–90% (≤15% escalation rate)

---

## Tier Routing: L0 → L1 → L2 → L3

Each incoming request is assigned a tier based on its estimated max cost and the
remaining budget ratio. The **tighter** of `projectBudgetRatio` and `dailyBudgetRatio`
is used as the binding constraint.

| Tier | Max Cost | Min Budget Ratio | Behaviour |
|------|----------|-----------------|-----------|
| **L0** | < $0.10 | > 50% remaining | Fully autonomous — no notification |
| **L1** | < $1.00 | > 25% remaining | Notify ops channel, proceed automatically |
| **L2** | < $5.00 | > 10% remaining | Log warning (soft-gate), proceed |
| **L3** | anything else | any | **Block — escalate to HITL** |

### Tier Assignment Flow

```
pre_flight_estimate(request)
    └─> route_by_tier(estimate, budgetState)
            ├─ L0  → execute, record, no alert
            ├─ L1  → execute, log warning, record
            ├─ L2  → execute, log warning, record
            └─ L3  → block, publish hitl.request.budget.{requestId}
```

---

## Pre-flight Cost Estimation

All requests undergo cost estimation **before** execution. The estimator uses a
heuristic approach (≈4 characters per token) since the Anthropic SDK is not
installed. A conservative upper-bound (`maxCost = estimatedCost × 1.5`) is used
for tier assignment.

**Deviation rule:** When the Anthropic token counting API is unavailable, the
system activates fallback heuristics at 1.5× observed average and sets
`fallbackUsed = true` in the estimate.

```typescript
// lib/plugins/cost-estimator.ts
const estimate = pre_flight_estimate({
  promptText: "...",
  modelId: "claude-sonnet-4-6",
});
// estimate.maxCost used for tier routing
```

---

## Circuit Breaker (per goal × agent)

A circuit breaker tracks the state of each `goalId:agentId` combination.

| State | Description |
|-------|-------------|
| `CLOSED` | Normal operation — requests pass through |
| `OPEN` | Budget exceeded — requests blocked |
| `HALF_OPEN` | Recovery test window — one request allowed |

**Default config:**
- `failureThreshold: 3` — opens after 3 consecutive budget failures
- `recoveryWindowMs: 300_000` — 5-minute recovery window
- Transitions: `CLOSED → OPEN` on failures, `OPEN → HALF_OPEN` after recovery window

**Emergency override** (requires justification + approver):
```typescript
circuitBreaker.override("goal-id", "ava", "CLOSED", "emergency fix", "ops-lead");
```

---

## HITL Escalation (L3)

When a request is assigned tier L3, the BudgetPlugin publishes to
`hitl.request.budget.{requestId}`. The payload includes:

- `escalation_reason` — human-readable reason for escalation
- `cost_trail` — last 10 records for this agent+project
- `escalationContext` — full budget state snapshot
- `summary` — formatted markdown with all cost context

The HITLPlugin routes this to the appropriate interface (Discord, API, etc.)
and waits for an approve/reject decision (30-minute timeout).

---

## Discord Alerts

The `DiscordAlerter` monitors `projectBudgetRatio` and `dailyBudgetRatio` and
fires notifications at configured thresholds (default: 50% and 80%).

Alerts are sent to the `DISCORD_BUDGET_WEBHOOK_URL` environment variable.
On failure: exponential backoff retry (max 7 retries), with a fallback to
`DISCORD_OPS_WEBHOOK_URL` if configured.

---

## Metrics & Autonomous Rate

The `MetricsTracker` records every request event and computes:

- `autonomous_rate` — fraction of requests handled autonomously (target ≥ 0.85)
- Tier breakdown (L0/L1/L2/L3 counts)
- Per-agent and per-project metrics

When the autonomous rate drops below 85%, an `ops.alert.budget` event is published
with a diagnostic report. **Auto-adjustment is prohibited** — a human must review
and adjust tier thresholds or circuit breaker sensitivity.

---

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `budget.request.#` | Inbound | Pre-flight cost check request |
| `budget.actual.#` | Inbound | Post-execution actual cost |
| `budget.decision.{requestId}` | Outbound | Tier decision (approved/blocked) |
| `hitl.request.budget.{requestId}` | Outbound | L3 escalation to HITLPlugin |
| `ops.alert.budget` | Outbound | Ops-level alerts (rate drop, discrepancy) |
| `budget.circuit.open.{key}` | Outbound | Circuit breaker state change |

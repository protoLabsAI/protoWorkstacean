---
title: Budget System Configuration Reference
---


## Budget Constants

Defined in `lib/types/budget.ts`.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_PROJECT_BUDGET` | `$10.00` | Maximum daily spend per project |
| `MAX_DAILY_BUDGET` | `$50.00` | Maximum total daily spend across all projects |
| `FALLBACK_COST_MULTIPLIER` | `1.5` | Conservative upper-bound multiplier for heuristic estimates |

---

## Tier Configuration

Defined in `TIER_CONFIG` in `lib/types/budget.ts`.

| Tier | `maxCost` | `minBudgetRatio` | `requiresHITL` | Description |
|------|-----------|-----------------|----------------|-------------|
| L0 | `$0.10` | `0.50` (50%) | No | Autonomous — no notification |
| L1 | `$1.00` | `0.25` (25%) | No | Notify ops, proceed |
| L2 | `$5.00` | `0.10` (10%) | No | Soft-gate warning |
| L3 | `∞` | `0` | **Yes** | HITL approval required |

**Tier assignment:** A request is assigned the highest L tier where BOTH
`maxCost < tier.maxCost` AND `minBudgetRatio ≤ budgetRatio` are satisfied.
The tighter of `projectBudgetRatio` and `dailyBudgetRatio` is used.

---

## Model Rates

Defined in `MODEL_RATES` in `lib/types/budget.ts`.

| Model | Input (per token) | Output (per token) |
|-------|-------------------|--------------------|
| `claude-opus-4-6` | $0.000015 | $0.000075 |
| `claude-sonnet-4-6` | $0.000003 | $0.000015 |
| `claude-haiku-4-5` | $0.00000025 | $0.00000125 |
| `gpt-4o` | $0.0000025 | $0.00001 |
| `gpt-4o-mini` | $0.00000015 | $0.0000006 |
| `default` | $0.000003 | $0.000015 |

---

## Circuit Breaker Configuration

`CircuitBreaker` accepts a `CircuitBreakerConfig` in its constructor.

| Property | Default | Description |
|----------|---------|-------------|
| `failureThreshold` | `3` | Consecutive failures to open the circuit |
| `recoveryWindowMs` | `300_000` (5 min) | Time in OPEN before trying HALF_OPEN |
| `successThreshold` | `1` | Successes in HALF_OPEN to close circuit |

---

## Discord Alert Configuration

`DiscordAlerter` accepts a `DiscordAlertConfig` partial.

| Property | Default | Environment Variable | Description |
|----------|---------|---------------------|-------------|
| `webhookUrl` | `""` | `DISCORD_BUDGET_WEBHOOK_URL` | Primary alert webhook |
| `opsWebhookUrl` | `""` | `DISCORD_OPS_WEBHOOK_URL` | Fallback ops webhook |
| `thresholds` | `[0.5, 0.8]` | — | Budget usage fractions to alert at |
| `maxRetries` | `7` | — | Max webhook delivery retries |
| `initialBackoffMs` | `1000` | — | Initial exponential backoff delay |

---

## HITL Escalation Timeout

The default HITL escalation timeout is **30 minutes** (1800 seconds).
Requests that expire without a decision are auto-rejected per deviation rules.

This is hardcoded in `lib/plugins/budget.ts`:
```typescript
expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
```

---

## Metrics Target

| Metric | Target | Alert Threshold |
|--------|--------|----------------|
| `autonomous_rate` | 85–90% | < 85% triggers ops alert |

---

## Bus Topic Reference

| Topic | Payload Type | Description |
|-------|-------------|-------------|
| `budget.request.{suffix}` | `BudgetRequest` | Trigger pre-flight cost check |
| `budget.actual.{suffix}` | `BudgetActual` | Report actual post-execution cost |
| `budget.decision.{requestId}` | `BudgetDecision` | Cost check result |
| `hitl.request.budget.{requestId}` | `HITLRequest` (with cost fields) | L3 escalation |
| `ops.alert.budget` | `{ type, ... }` | Budget system ops alerts |
| `budget.circuit.open.{key}` | `{ type, key, circuitState }` | Circuit breaker opened |

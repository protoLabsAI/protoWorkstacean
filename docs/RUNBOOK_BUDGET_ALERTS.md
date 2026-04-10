# Runbook — Budget Alerts

## Alert: Budget Threshold Crossed (50% or 80%)

**Topic:** Discord webhook (or `budget.alert.threshold` on bus)

**Triggered when:** Project daily spend or total daily spend exceeds 50% or 80%
of the configured cap.

### Immediate response

1. Check current spend via the metrics endpoint or `ops.alert.budget` events
2. Review recent `budget.decision.*` events for the project/agent
3. If approaching $10 project cap — consider pausing non-critical agent runs
4. If approaching $50 daily cap — escalate to team lead immediately

### No further action needed if:
- Spend is on track with expected project activity
- Threshold is 50% and there is no unusual spike

---

## Alert: Autonomous Rate Below 85%

**Topic:** `ops.alert.budget` with `type: "autonomous_rate_below_threshold"`

**Triggered when:** The 24-hour autonomous rate drops below 85%.

### Steps

1. **Read the diagnostic report** in the alert payload — it includes tier breakdown
2. Check for unusual L3 escalation patterns (are certain agents/projects spiking?)
3. Review tier thresholds — are they still appropriate for current usage patterns?
4. **Do NOT auto-adjust** tier thresholds or circuit breaker config without a team review
5. Open a ticket for the engineering team to review and adjust configuration

---

## Alert: Cost Discrepancy >20%

**Topic:** `ops.alert.budget` with `type: "cost_discrepancy"`

**Triggered when:** The actual post-execution cost differs from the pre-flight estimate
by more than 20%.

### Steps

1. Check the `estimated` vs `actual` values in the alert payload
2. Review the model being used — is it returning more tokens than expected?
3. Adjust `estimatedCompletionTokens` in the calling code if consistently over-estimating
4. The budget tracker will adjust the recorded spend to the actual value automatically
5. If discrepancy is systematic (>20% consistently), escalate to HITL for budget review

---

## Alert: Circuit Breaker OPEN

**Topic:** `budget.circuit.open.{goalId}:{agentId}`

**Triggered when:** A goal×agent circuit breaker transitions to OPEN state.

### Steps

1. Identify which `goalId:agentId` combination tripped the breaker
2. Review the recent `budget_ledger` records for that combination
3. Determine root cause: was the budget exhausted, or is there a runaway agent?
4. If the agent is behaving correctly and budget is available, use the emergency override:

```typescript
// From ops console or emergency responder tooling
circuitBreaker.override("goal-id", "agent-id", "CLOSED", "budget replenished — resuming", "ops-oncall");
```

5. Log the override with justification (cost deducted from next period's allocation)
6. Monitor the agent for the next 10 minutes to confirm normal behavior

---

## Alert: HITL Escalation Timeout

**Topic:** `hitl.expired.{correlationId}`

**Triggered when:** A HITL approval request expires without a decision (default: 30 minutes).

### Steps

1. Per deviation rule: the request is auto-rejected after timeout
2. Review the original escalation context in the expired request
3. If the request was legitimate, manually re-trigger from the source
4. Notify the ops team about the missed escalation
5. Review escalation alert routing if this is happening frequently

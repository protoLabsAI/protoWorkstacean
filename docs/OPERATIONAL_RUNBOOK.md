# L2 Planner Operational Runbook

## Monitoring

### Dashboard

See `monitoring/dashboards/l2-planner-dashboard.json` for the dashboard definition.

Key panels:
- **Escalation Rate**: Should trend downward over time
- **Success Rate**: Target > 80%
- **Confidence Distribution**: Healthy system has most plans > 0.7
- **Learned Rules Count**: Should grow steadily

### Alerts

| Condition | Severity | Action |
|-----------|----------|--------|
| Escalation rate > 50% (1h window) | Warning | Check L2 planner health |
| Escalation rate > 80% (1h window) | Critical | Check A2A connectivity and action graph |
| P95 latency > 30s | Warning | Check A2A response times |
| Learned rule failure rate > 30% | Warning | Trigger rule audit |

## Common Operations

### Adjusting Confidence Thresholds

Edit `src/config/routing-config.yaml`:
```yaml
routing:
  l2_confidence_threshold: 0.5  # Lower = more autonomous, higher = more escalations
```

### Inspecting Learned Rules

```typescript
const registry = dispatcher.getRuleRegistry();
const stats = registry.getStats();
const rules = registry.getAll();
```

### Rolling Back a Learned Rule

```typescript
const migration = new RuleMigration(registry, versioning, auditor);
migration.rollback("rule-id");
```

### Checking Escalation Trends

```typescript
const tracker = dispatcher.getEscalationTracker();
const trend = tracker.getTrend(3600_000); // 1-hour buckets
const reasons = tracker.getTopReasons(10);
```

## Discord Rate Limiting

### How It Works

The Discord plugin enforces per-user message rate limits (default: 5 messages per 10 seconds, configurable in `workspace/discord.yaml`). Rate-limit windows are persisted to `data/events.db` in the `rate_limits` table so that limits survive process restarts.

On startup, the plugin loads all non-expired hits from the DB, so a user who spammed before a restart will remain limited until their window expires.

### Single-Instance Limitation

**The rate-limit state is single-instance only.** Each Workstacean process maintains its own in-memory window and writes to the local SQLite DB. If multiple instances run behind a load balancer, each instance has independent state and limits are not enforced across the fleet.

For multi-instance deployments, migrate to a shared Redis store using `INCR` + `EXPIRE` per-user keys. This is a known limitation and is not addressed by the current implementation.

### Inspecting Rate-Limit State

```bash
sqlite3 data/events.db "SELECT user_id, COUNT(*) as hits, MAX(ts) as last_seen FROM rate_limits GROUP BY user_id;"
```

### Clearing Rate-Limit State for a User

```bash
sqlite3 data/events.db "DELETE FROM rate_limits WHERE user_id = 'USER_ID';"
```

## Troubleshooting

### High Escalation Rate

1. Check A2A client connectivity (is Ava responding?)
2. Verify action graph has sufficient actions for the goal types
3. Check if confidence threshold is too high
4. Review top escalation reasons: `tracker.getTopReasons(10)`

### Learned Rule Causing Failures

1. Identify the rule: `registry.findByGoal(goalPattern)`
2. Check failure count: `rule.failureCount`
3. Rollback if needed: `migration.rollback(rule.id)`
4. Audit trail: `auditor.getForRule(rule.id)`

### L2 Planner Not Learning

1. Check minimum learning confidence: plans below 0.8 are not extracted
2. Check promotion threshold: rules need 3 successes before promotion
3. Verify registry is not at max capacity (500 default)
4. Check if plans are too long (max 10 actions for extraction)

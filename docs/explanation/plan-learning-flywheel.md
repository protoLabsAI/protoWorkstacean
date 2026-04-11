---
title: Plan Learning Flywheel
---


## Concept

The learning flywheel converts expensive L2 (LLM-assisted) plans into cheap L0 (deterministic) rules. Over time, this drives the escalation rate toward zero as the system learns to handle more situations autonomously.

## Cycle

```
Request → L2 (LLM + A*) → Successful Plan → Extract Rule → Register Rule
                                                              ↓
Request → Check Learned Rules → Match! → Use Learned Plan → Record Success
                                                              ↓
                                              Promote to L0 (after N successes)
```

## Components

### RuleExtractor

Extracts generalizable conditions from successful L2 plans:
- Uses the plan's first action preconditions as rule conditions
- Captures relevant state keys from the initial state
- Configurable minimum confidence threshold (default: 0.8)

### RuleRegistry

Stores learned rules with:
- Success/failure tracking
- Version history
- Active/inactive status
- Promotion tracking (to L0)
- Automatic pruning of low-performing rules

### PatternMatcher

Checks incoming requests against learned rules:
- Exact goal pattern matching
- State condition evaluation
- Selects best rule by: success rate → confidence → cost

### PlanConverter

Orchestrates the conversion pipeline:
- Validates plan eligibility
- Creates or updates rules
- Triggers promotion check

### RuleMigration

Safe promotion from L2 registry to L0:
- Version snapshots before promotion
- Audit trail of all events
- Auto-rollback on performance degradation

## Configuration

```yaml
learning:
  min_learning_confidence: 0.8
  promotion_threshold: 3
  max_learned_rules: 500
  auto_rollback_enabled: true
```

## Monitoring

Track flywheel health via:
- `rulesLearned`: Total rules in registry
- `rulesPromoted`: Rules promoted to L0
- `l0HitRate`: Ratio of requests handled by learned rules
- `escalationRateDelta`: Change in escalation rate (negative = improving)

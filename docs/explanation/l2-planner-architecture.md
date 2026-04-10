---
title: L2 Planner Architecture
---


## Overview

The L2 planner is a hybrid LLM-A* planning system that sits between the deterministic L0/L1 layers and human escalation (L3). It combines creative plan generation from an LLM agent (Ava) with rigorous A* validation and optimization.

## Layer Model

```
L0 (Deterministic Rules) → L1 (A* Search) → L2 (LLM-A* Hybrid) → L3 (Human)
```

- **L0**: Pattern-matching rule engine. Fast, deterministic, zero-cost. Handles ~80% of cases.
- **L1**: A* search with HTN decomposition. Finds optimal plans within budget. Handles ~15%.
- **L2**: LLM proposes creative plans, A* validates and optimizes. Handles novel situations.
- **L3**: Human-in-the-loop for cases where L2 confidence is too low.

## L2 Hybrid Planning Flow

1. **Routing**: `L2Router` intercepts L0/L1 failures or low-confidence results
2. **Proposal**: `A2AProposer` sends structured prompt to Ava (LLM) via A2A protocol
3. **Validation**: `AStarValidator` checks each candidate plan against A* simulation
4. **Optimization**: A* attempts to find a lower-cost alternative
5. **Confidence**: `ConfidenceScorer` evaluates plan quality (feasibility, goal alignment, cost, constraints)
6. **Escalation**: `EscalationTrigger` routes low-confidence plans to L3

## Learning Flywheel

Every successful L2 plan is fed into the learning flywheel:

1. `RuleExtractor` extracts generalizable conditions from the plan
2. `PlanConverter` creates a `LearnedRule` in the `RuleRegistry`
3. On subsequent requests, `PatternMatcher` checks learned rules first
4. After enough successful executions, `RuleMigration` promotes the rule to L0
5. Result: escalation rate decreases over time as the system learns

## Confidence Scoring

Confidence is a weighted composite of:
- **Feasibility** (35%): Can actions execute in order?
- **Goal Alignment** (30%): Does the final state satisfy the goal?
- **Cost Efficiency** (15%): Is the cost reasonable?
- **Constraint Satisfaction** (20%): Are all constraints met?

## Configuration

See `src/config/routing-config.yaml` for tunable thresholds.

## Key Files

| File | Purpose |
|------|---------|
| `src/planner/l2-router.ts` | Top-level L0→L1→L2→L3 routing |
| `src/planner/hybrid-planner.ts` | LLM-A* hybrid planning engine |
| `src/planner/a2a-proposer.ts` | LLM candidate generation via A2A |
| `src/planner/astar-validator.ts` | A* plan validation and optimization |
| `src/planner/confidence-scorer.ts` | Plan quality scoring |
| `src/planner/escalation-trigger.ts` | L3 escalation decisions |
| `src/planner/dispatcher.ts` | Full pipeline dispatcher |
| `src/learning/plan-converter.ts` | Plan → rule conversion |
| `src/learning/rule-registry.ts` | Learned rule storage |
| `src/learning/rule-migration.ts` | L2 → L0 rule promotion |
| `src/monitoring/l2-metrics.ts` | Invocation/success telemetry |
| `src/monitoring/escalation-tracker.ts` | Escalation trend tracking |

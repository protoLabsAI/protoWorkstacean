---
title: Planner Architecture
---

# Planner Architecture

## Overview

The L1 planner is a budget-bounded A* search system that serves as fallback when the L0 rule matcher cannot handle a request. It operates on an action graph where world states are nodes and actions are directed edges.

## Component Layers

```
┌─────────────────────────────────────┐
│         L0-L1 Bridge                │  ← Entry point
│  (src/matcher/l0-l1-bridge.ts)      │
├─────────────────────────────────────┤
│         L1 Planner                  │  ← Orchestration
│  (src/planner/l1-integration.ts)    │
├─────────┬───────────┬───────────────┤
│ Anytime │   HTN     │    Plan       │  ← Planning layers
│ Planner │ Decomposer│  Validator    │
├─────────┴───────────┴───────────────┤
│         A* Search                   │  ← Core search
│  (src/planner/a-star.ts)            │
├─────────────────────────────────────┤
│     Action Graph + World State      │  ← Data layer
│  (src/planner/action-graph.ts)      │
└─────────────────────────────────────┘
```

## Data Flow

1. L0 rule matcher receives a goal and current state
2. If no rule matches, L0-L1 bridge constructs an L0Context
3. L1 planner runs HTN decomposition to expand available actions
4. AnytimePlanner runs iterative weighted A* within budget
5. Best plan is validated on a state copy
6. Validated plan is returned to the caller

## Key Design Decisions

- **Immutable state**: PlannerState is `Readonly<Record<string, StateValue>>` — all mutations produce new objects
- **Budget-bounded**: Search respects both time and expansion budgets, returning best partial plan if budget exhausted
- **Anytime**: Starts with high-weight A* for fast initial solutions, then refines with lower weights
- **Side-effect free validation**: Plans are validated on cloned state before committing
- **Replanning**: If world state changes mid-execution, the replan manager produces a new plan from current state while preserving executed steps

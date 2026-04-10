---
title: Planner API Reference
---


## Entry Points

### L1Planner

Main entry point for the A* planner system.

```ts
import { L1Planner } from "../src/planner/l1-integration.ts";
import { ActionGraph } from "../src/planner/action-graph.ts";
import { TaskNetwork } from "../src/planner/task-network.ts";

const planner = new L1Planner(graph, network, { defaultBudgetMs: 5000 });
const result = planner.planFromContext(context);
```

### L0L1Bridge

Connects L0 rule matcher to L1 planner with automatic fallback.

```ts
import { L0L1Bridge } from "../src/matcher/l0-l1-bridge.ts";

const bridge = new L0L1Bridge(matcher, actions, compositeTasks);
const result = bridge.resolve(state, goal);
```

## Core Types

### PlannerState
Flat key-value map representing world state for planning:
```ts
type StateValue = string | number | boolean | null;
type PlannerState = Readonly<Record<string, StateValue>>;
```

### Action
Primitive action with preconditions and effects:
```ts
interface Action {
  id: string;
  name: string;
  cost: number;
  level: HierarchyLevel;
  preconditions: StatePredicate[];
  effects: StateTransform[];
}
```

### Plan
Sequence of actions with cost tracking:
```ts
interface Plan {
  actions: Action[];
  totalCost: number;
  isComplete: boolean;
  lowerBound?: number;
}
```

## Creating Actions

Use the fluent `action()` builder:

```ts
import { action } from "../src/planner/action.ts";

const restart = action("restart-svc", "Restart Service")
  .cost(2)
  .level("action")
  .requireEquals("service.status", "down")
  .set({ "service.status": "healthy" })
  .build();
```

## Heuristics

Available heuristic functions:

- `zeroHeuristic` — always returns 0 (Dijkstra-equivalent)
- `stateDiffHeuristic(goalState)` — counts differing state keys
- `namedGoalHeuristic(namedGoal)` — uses goal-attached heuristic
- `maxHeuristic(...fns)` — max of multiple heuristics

## Search Configuration

```ts
interface SearchConfig {
  maxExpansions?: number;   // Max nodes to expand
  timeBudgetMs?: number;    // Time budget in ms
  weight?: number;          // Weighted A* factor (>1 = faster, less optimal)
}
```

## Plan Validation

```ts
import { validatePlan } from "../src/planner/plan-validator.ts";

const result = validatePlan(plan, initialState, goal);
// result.valid, result.failedAtIndex, result.finalState, result.error
```

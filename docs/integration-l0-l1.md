# L0-L1 Integration Guide

## Overview

The L0 rule matcher handles ~80% of cases with deterministic pattern matching. When L0 cannot find a matching rule, the L0-L1 bridge invokes the L1 A* planner as fallback.

## Setup

```ts
import { L0L1Bridge, type L0RuleMatcher } from "../src/matcher/l0-l1-bridge.ts";
import { action } from "../src/planner/action.ts";

// Define your L0 matcher
const matcher: L0RuleMatcher = {
  match(state, goal) {
    // Your rule matching logic
    // Return { matched: true, action } or { matched: false, reason }
  }
};

// Define available actions for L1
const actions = [
  action("fix", "fix-issue").requireEquals("broken", true).set({ broken: false }).build(),
];

// Create bridge
const bridge = new L0L1Bridge(matcher, actions, compositeTasks, {
  defaultBudget: { timeBudgetMs: 5000 },
});
```

## Usage

```ts
const result = bridge.resolve(currentState, goal);

if (result.success) {
  // result.plan contains the action sequence
  for (const action of result.plan.actions) {
    // Execute action
  }
} else {
  console.error(result.error);
}
```

## Deviation Handling

| Situation | Behavior |
|-----------|----------|
| L0 matches | Returns single-action plan immediately |
| L0 no match | Invokes L1 A* planner |
| L1 budget exhausted | Returns best partial plan with warning |
| L1 plan invalid | Returns validation failure |
| World state changes | ReplanManager produces new plan |

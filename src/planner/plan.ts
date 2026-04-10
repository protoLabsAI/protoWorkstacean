/**
 * Plan construction and manipulation utilities.
 */

import type { Action, Plan, SearchNode } from "./types.ts";

/** Create an empty plan. */
export function emptyPlan(): Plan {
  return {
    actions: [],
    totalCost: 0,
    isComplete: false,
  };
}

/** Reconstruct a plan by following parent pointers from a search node. */
export function reconstructPlan(node: SearchNode): Plan {
  const actions: Action[] = [];
  let current: SearchNode | null = node;

  while (current !== null) {
    if (current.action !== null) {
      actions.unshift(current.action);
    }
    current = current.parent;
  }

  const totalCost = actions.reduce((sum, a) => sum + a.cost, 0);

  return {
    actions,
    totalCost,
    isComplete: true,
  };
}

/** Create a partial (incomplete) plan from the best node found so far. */
export function partialPlan(node: SearchNode, lowerBound: number): Plan {
  const plan = reconstructPlan(node);
  return {
    ...plan,
    isComplete: false,
    lowerBound,
  };
}

/** Merge an already-executed prefix with a new plan suffix. */
export function mergePlans(executed: Action[], suffix: Plan): Plan {
  const executedCost = executed.reduce((sum, a) => sum + a.cost, 0);
  return {
    actions: [...executed, ...suffix.actions],
    totalCost: executedCost + suffix.totalCost,
    isComplete: suffix.isComplete,
    lowerBound: suffix.lowerBound,
  };
}

/** Get the remaining actions in a plan starting from a given index. */
export function remainingActions(plan: Plan, fromIndex: number): Action[] {
  return plan.actions.slice(fromIndex);
}

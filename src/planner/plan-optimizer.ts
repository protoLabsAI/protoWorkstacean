/**
 * PlanOptimizer — optimizes plans by removing redundant actions,
 * reordering where possible, and trimming unnecessary steps.
 */

import type { Plan, PlannerState, Goal } from "./types.ts";
import { validatePlan } from "./plan-validator.ts";
import { cloneState } from "./world-state.ts";
import { applyEffects } from "./action.ts";

/** Optimization result with before/after stats. */
export interface OptimizationResult {
  optimizedPlan: Plan;
  originalCost: number;
  optimizedCost: number;
  actionsRemoved: number;
  valid: boolean;
}

/**
 * Remove redundant actions from a plan.
 *
 * An action is redundant if removing it doesn't affect goal satisfaction.
 * Uses a greedy approach: try removing each action and check if plan still works.
 */
export function removeRedundantActions(
  plan: Plan,
  initialState: PlannerState,
  goal: Goal,
): OptimizationResult {
  const originalCost = plan.totalCost;
  let optimizedActions = [...plan.actions];

  // Try removing each action (reverse order to preserve indices)
  for (let i = optimizedActions.length - 1; i >= 0; i--) {
    const without = [...optimizedActions.slice(0, i), ...optimizedActions.slice(i + 1)];
    const candidate: Plan = {
      actions: without,
      totalCost: without.reduce((sum, a) => sum + a.cost, 0),
      isComplete: true,
    };

    const validation = validatePlan(candidate, initialState, goal);
    if (validation.valid) {
      optimizedActions = without;
    }
  }

  const optimizedPlan: Plan = {
    actions: optimizedActions,
    totalCost: optimizedActions.reduce((sum, a) => sum + a.cost, 0),
    isComplete: plan.isComplete,
  };

  const validation = validatePlan(optimizedPlan, initialState, goal);

  return {
    optimizedPlan,
    originalCost,
    optimizedCost: optimizedPlan.totalCost,
    actionsRemoved: plan.actions.length - optimizedActions.length,
    valid: validation.valid,
  };
}

/**
 * Full optimization pass: remove redundant actions.
 */
export function optimizePlan(
  plan: Plan,
  initialState: PlannerState,
  goal: Goal,
): OptimizationResult {
  return removeRedundantActions(plan, initialState, goal);
}

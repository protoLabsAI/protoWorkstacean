/**
 * Plan validator — validates a plan by executing it on a world state copy.
 *
 * Ensures:
 * - All preconditions are met before each action
 * - Effects are properly applied
 * - The final state satisfies the goal
 * - Original state is never modified
 */

import type { Goal, Plan, PlannerState, ValidationResult } from "./types.ts";
import { cloneState } from "./world-state.ts";
import { executePlan } from "./executor.ts";

/**
 * Validate a plan by executing it on a copy of the world state.
 *
 * @param plan - The plan to validate
 * @param initialState - The starting world state (not modified)
 * @param goal - Optional goal predicate to check after execution
 * @returns ValidationResult indicating success/failure
 */
export function validatePlan(
  plan: Plan,
  initialState: PlannerState,
  goal?: Goal,
): ValidationResult {
  // Execute on a clone to ensure no side effects
  const stateCopy = cloneState(initialState);
  const execResult = executePlan(plan, stateCopy);

  if (!execResult.success) {
    return {
      valid: false,
      failedAtIndex: execResult.failedAtIndex,
      finalState: execResult.finalState,
      error: execResult.steps[execResult.failedAtIndex]?.error ??
        "Unknown execution failure",
    };
  }

  // If a goal is provided, check that the final state satisfies it
  if (goal && !goal(execResult.finalState)) {
    return {
      valid: false,
      failedAtIndex: -1,
      finalState: execResult.finalState,
      error: "Plan executed successfully but final state does not satisfy goal",
    };
  }

  return {
    valid: true,
    failedAtIndex: -1,
    finalState: execResult.finalState,
  };
}

/**
 * Validate that the original state is not modified by validation.
 * Returns true if original state is preserved.
 */
export function validateNoSideEffects(
  plan: Plan,
  initialState: PlannerState,
): { preserved: boolean; originalState: PlannerState } {
  const originalSnapshot = cloneState(initialState);
  validatePlan(plan, initialState);

  // Check that original state was not mutated
  const keys = new Set([
    ...Object.keys(originalSnapshot),
    ...Object.keys(initialState),
  ]);

  for (const key of keys) {
    if (originalSnapshot[key] !== initialState[key]) {
      return { preserved: false, originalState: originalSnapshot };
    }
  }

  return { preserved: true, originalState: originalSnapshot };
}

/**
 * Plan executor — applies plan actions to a world state sequentially.
 * Used by the validator to simulate execution on a copy.
 */

import type { Action, Plan, PlannerState } from "./types.ts";
import { preconditionsMet, applyEffects } from "./action.ts";
import { cloneState } from "./world-state.ts";

/** Result of executing a single action. */
export interface ExecutionStepResult {
  actionIndex: number;
  action: Action;
  success: boolean;
  stateBefore: PlannerState;
  stateAfter: PlannerState;
  error?: string;
}

/** Result of executing an entire plan. */
export interface ExecutionResult {
  success: boolean;
  steps: ExecutionStepResult[];
  finalState: PlannerState;
  /** Index of first failed step (-1 if all succeeded). */
  failedAtIndex: number;
  /** Number of steps successfully executed. */
  stepsCompleted: number;
}

/**
 * Execute a plan on a cloned copy of the given state.
 * Does NOT modify the original state.
 *
 * For each action:
 * 1. Check preconditions against current state
 * 2. If preconditions fail, stop and report failure
 * 3. Apply effects to produce next state
 */
export function executePlan(
  plan: Plan,
  initialState: PlannerState,
): ExecutionResult {
  let currentState = cloneState(initialState);
  const steps: ExecutionStepResult[] = [];

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    const stateBefore = currentState;

    // Check preconditions
    if (!preconditionsMet(action, currentState)) {
      steps.push({
        actionIndex: i,
        action,
        success: false,
        stateBefore,
        stateAfter: stateBefore,
        error: `Precondition failed for action "${action.name}" (${action.id}) at step ${i}`,
      });

      return {
        success: false,
        steps,
        finalState: currentState,
        failedAtIndex: i,
        stepsCompleted: i,
      };
    }

    // Apply effects
    const stateAfter = applyEffects(action, currentState);
    steps.push({
      actionIndex: i,
      action,
      success: true,
      stateBefore,
      stateAfter,
    });
    currentState = stateAfter;
  }

  return {
    success: true,
    steps,
    finalState: currentState,
    failedAtIndex: -1,
    stepsCompleted: plan.actions.length,
  };
}

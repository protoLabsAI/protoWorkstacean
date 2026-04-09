/**
 * State change detector — monitors world state for changes that
 * invalidate the current plan during execution.
 */

import type { Action, Plan, PlannerState } from "./types.ts";
import { preconditionsMet } from "./action.ts";

/** Describes a detected state change that affects the plan. */
export interface StateChange {
  /** Keys that changed. */
  changedKeys: string[];
  /** Index of first plan action invalidated by this change. */
  invalidatedFromIndex: number;
  /** Whether any remaining actions are invalidated. */
  planInvalidated: boolean;
}

/**
 * Compare two states and return the set of keys that differ.
 */
export function diffStates(
  before: PlannerState,
  after: PlannerState,
): string[] {
  const allKeys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  const changed: string[] = [];
  for (const key of allKeys) {
    if (before[key] !== after[key]) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Detect whether a state change invalidates any remaining plan actions.
 *
 * @param plan - The current plan
 * @param fromIndex - The index of the next action to execute
 * @param expectedState - The state we expected at this point
 * @param actualState - The actual current world state
 * @returns StateChange describing the impact, or null if plan is still valid
 */
export function detectInvalidation(
  plan: Plan,
  fromIndex: number,
  expectedState: PlannerState,
  actualState: PlannerState,
): StateChange | null {
  const changedKeys = diffStates(expectedState, actualState);
  if (changedKeys.length === 0) return null;

  // Check if any remaining action's preconditions are broken
  // by simulating from the actual state
  let currentState = actualState;
  for (let i = fromIndex; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    if (!preconditionsMet(action, currentState)) {
      return {
        changedKeys,
        invalidatedFromIndex: i,
        planInvalidated: true,
      };
    }
    // Simulate applying the action to check subsequent steps
    let nextState = currentState;
    for (const eff of action.effects) {
      nextState = eff(nextState);
    }
    currentState = nextState;
  }

  // State changed but plan is still valid
  return {
    changedKeys,
    invalidatedFromIndex: -1,
    planInvalidated: false,
  };
}

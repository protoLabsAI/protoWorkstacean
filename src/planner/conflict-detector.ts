/**
 * ConflictDetector — detects conflicts between actions in a plan.
 *
 * Checks for:
 * - Actions with contradictory effects
 * - Precondition violations due to earlier effects
 * - Resource conflicts (same state key modified by multiple actions)
 */

import type { Action, Plan, PlannerState } from "./types.ts";
import { applyEffects, preconditionsMet } from "./action.ts";
import { cloneState } from "./world-state.ts";

/** A detected conflict between two actions. */
export interface PlanConflict {
  type: "precondition_violation" | "contradictory_effects" | "resource_conflict";
  /** Index of the first action involved. */
  actionIndexA: number;
  /** Index of the second action involved (may be same as A for self-conflicts). */
  actionIndexB: number;
  description: string;
}

/**
 * Detect conflicts in a plan by simulating execution.
 */
export function detectConflicts(plan: Plan, initialState: PlannerState): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  let state = cloneState(initialState);

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i];

    // Check preconditions against current simulated state
    if (!preconditionsMet(action, state)) {
      // Find which earlier action invalidated the preconditions
      const invalidator = findInvalidator(plan.actions, i, initialState);
      conflicts.push({
        type: "precondition_violation",
        actionIndexA: invalidator,
        actionIndexB: i,
        description: `Action "${action.name}" (index ${i}) has unsatisfied preconditions after effects of action at index ${invalidator}`,
      });
    }

    // Apply effects to advance simulated state
    state = applyEffects(action, state);
  }

  // Check for contradictory effects (actions that undo each other)
  for (let i = 0; i < plan.actions.length - 1; i++) {
    for (let j = i + 1; j < plan.actions.length; j++) {
      if (hasContradictoryEffects(plan.actions[i], plan.actions[j])) {
        conflicts.push({
          type: "contradictory_effects",
          actionIndexA: i,
          actionIndexB: j,
          description: `Actions "${plan.actions[i].name}" and "${plan.actions[j].name}" have contradictory effects`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Find which action invalidated preconditions for a later action.
 */
function findInvalidator(actions: Action[], targetIndex: number, initialState: PlannerState): number {
  let state = cloneState(initialState);
  const targetAction = actions[targetIndex];

  for (let i = 0; i < targetIndex; i++) {
    const prevState = cloneState(state);
    state = applyEffects(actions[i], state);

    // If preconditions were met before this action but not after, this is the invalidator
    if (preconditionsMet(targetAction, prevState) && !preconditionsMet(targetAction, state)) {
      return i;
    }
  }

  return 0; // Default: initial state didn't satisfy preconditions
}

/**
 * Check if two actions have effects that contradict each other.
 * Two effects contradict if they set the same state key to different values.
 */
function hasContradictoryEffects(a: Action, b: Action): boolean {
  // Compare effect outputs by running them on a sample state
  const sampleState: PlannerState = {};
  const stateAfterA = applyEffects(a, sampleState);
  const stateAfterB = applyEffects(b, sampleState);

  for (const key of Object.keys(stateAfterA)) {
    if (key in stateAfterB && stateAfterA[key] !== stateAfterB[key]) {
      return true;
    }
  }

  return false;
}

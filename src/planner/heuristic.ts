/**
 * Heuristic functions for A* search.
 *
 * A heuristic must be admissible (never overestimate) for A* to find optimal plans.
 * For weighted A*, the heuristic is multiplied by a weight factor.
 */

import type { Goal, NamedGoal, PlannerState } from "./types.ts";

/** Heuristic function type: estimates cost from state to goal. */
export type HeuristicFn = (state: PlannerState, goal: Goal) => number;

/**
 * Zero heuristic — always returns 0.
 * Makes A* equivalent to Dijkstra's algorithm. Always admissible.
 */
export function zeroHeuristic(_state: PlannerState, _goal: Goal): number {
  return 0;
}

/**
 * Goal-provided heuristic — uses the heuristic function attached to a NamedGoal.
 * Falls back to zero if no heuristic is provided.
 */
export function namedGoalHeuristic(namedGoal: NamedGoal): HeuristicFn {
  return (state: PlannerState, _goal: Goal): number => {
    if (namedGoal.heuristic) {
      return namedGoal.heuristic(state);
    }
    return 0;
  };
}

/**
 * State-difference heuristic — counts the number of state keys that differ
 * from a known goal state. Useful when the goal state is fully specified.
 */
export function stateDiffHeuristic(goalState: PlannerState): HeuristicFn {
  return (state: PlannerState, _goal: Goal): number => {
    let diff = 0;
    for (const key of Object.keys(goalState)) {
      if (state[key] !== goalState[key]) {
        diff++;
      }
    }
    return diff;
  };
}

/**
 * Composite heuristic — returns the maximum of multiple heuristics.
 * If each component is admissible, the max is also admissible.
 */
export function maxHeuristic(...heuristics: HeuristicFn[]): HeuristicFn {
  return (state: PlannerState, goal: Goal): number => {
    let best = 0;
    for (const h of heuristics) {
      best = Math.max(best, h(state, goal));
    }
    return best;
  };
}

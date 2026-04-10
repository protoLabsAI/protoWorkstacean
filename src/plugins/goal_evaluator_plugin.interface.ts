import type { GoalViolation } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";

export interface IGoalEvaluatorPlugin {
  /** Evaluate loaded goals against the given world state. Returns all violations. */
  evaluateState(state: WorldState, projectSlug?: string): GoalViolation[];
  /** Reload goals from disk. */
  reloadGoals(projectSlug?: string): void;
}

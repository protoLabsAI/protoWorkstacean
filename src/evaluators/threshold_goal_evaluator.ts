import type { ThresholdGoal, GoalViolation, Severity } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";
import { resolvePath } from "../engines/state_diff_engine.ts";

export class ThresholdGoalEvaluator {
  evaluate(goal: ThresholdGoal, state: WorldState, projectSlug?: string): GoalViolation | null {
    if (goal.enabled === false) return null;

    const { found, value } = resolvePath(state, goal.selector);

    if (!found) {
      return {
        goalId: goal.id,
        goalType: "Threshold",
        severity: (goal.severity ?? "medium") as Severity,
        description: goal.description,
        message: `Selector "${goal.selector}" not found in world state`,
        actual: undefined,
        expected: { min: goal.min, max: goal.max },
        timestamp: Date.now(),
        projectSlug,
      };
    }

    if (typeof value !== "number") {
      return {
        goalId: goal.id,
        goalType: "Threshold",
        severity: (goal.severity ?? "medium") as Severity,
        description: goal.description,
        message: `Selector "${goal.selector}" must resolve to a number, got ${typeof value}`,
        actual: value,
        expected: { min: goal.min, max: goal.max },
        timestamp: Date.now(),
        projectSlug,
      };
    }

    const belowMin = goal.min !== undefined && value < goal.min;
    const aboveMax = goal.max !== undefined && value > goal.max;

    if (!belowMin && !aboveMax) return null;

    let message: string;
    if (belowMin && aboveMax) {
      message = `"${goal.selector}" value ${value} is below min ${goal.min} and above max ${goal.max}`;
    } else if (belowMin) {
      message = `"${goal.selector}" value ${value} is below minimum threshold ${goal.min}`;
    } else {
      message = `"${goal.selector}" value ${value} exceeds maximum threshold ${goal.max}`;
    }

    return {
      goalId: goal.id,
      goalType: "Threshold",
      severity: (goal.severity ?? "medium") as Severity,
      description: goal.description,
      message,
      actual: value,
      expected: { min: goal.min, max: goal.max },
      timestamp: Date.now(),
      projectSlug,
    };
  }
}

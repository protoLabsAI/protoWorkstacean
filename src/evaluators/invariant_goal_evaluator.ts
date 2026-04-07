import type { InvariantGoal, GoalViolation, Severity } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";
import { resolvePath } from "../engines/state_diff_engine.ts";

export class InvariantGoalEvaluator {
  evaluate(goal: InvariantGoal, state: WorldState, projectSlug?: string): GoalViolation | null {
    if (goal.enabled === false) return null;

    const { found, value } = resolvePath(state, goal.selector);
    const operator = goal.operator ?? "truthy";

    let violated = false;
    let message = "";

    if (!found && operator !== "falsy") {
      violated = true;
      message = `Selector "${goal.selector}" not found in world state`;
    } else {
      switch (operator) {
        case "truthy":
          violated = !value;
          message = violated
            ? `Expected "${goal.selector}" to be truthy, got ${JSON.stringify(value)}`
            : "";
          break;
        case "falsy":
          violated = !!value;
          message = violated
            ? `Expected "${goal.selector}" to be falsy, got ${JSON.stringify(value)}`
            : "";
          break;
        case "eq":
          violated = value !== goal.expected;
          message = violated
            ? `Expected "${goal.selector}" to equal ${JSON.stringify(goal.expected)}, got ${JSON.stringify(value)}`
            : "";
          break;
        case "neq":
          violated = value === goal.expected;
          message = violated
            ? `Expected "${goal.selector}" to not equal ${JSON.stringify(goal.expected)}, got ${JSON.stringify(value)}`
            : "";
          break;
        case "in":
          if (!Array.isArray(goal.expected)) {
            violated = true;
            message = `Goal "${goal.id}" operator "in" requires expected to be an array`;
          } else {
            violated = !(goal.expected as unknown[]).includes(value);
            message = violated
              ? `Expected "${goal.selector}" to be one of ${JSON.stringify(goal.expected)}, got ${JSON.stringify(value)}`
              : "";
          }
          break;
        case "not_in":
          if (!Array.isArray(goal.expected)) {
            violated = true;
            message = `Goal "${goal.id}" operator "not_in" requires expected to be an array`;
          } else {
            violated = (goal.expected as unknown[]).includes(value);
            message = violated
              ? `Expected "${goal.selector}" to not be in ${JSON.stringify(goal.expected)}, got ${JSON.stringify(value)}`
              : "";
          }
          break;
      }
    }

    if (!violated) return null;

    return {
      goalId: goal.id,
      goalType: "Invariant",
      severity: (goal.severity ?? "medium") as Severity,
      description: goal.description,
      message,
      actual: value,
      expected: goal.expected,
      timestamp: Date.now(),
      projectSlug,
    };
  }
}

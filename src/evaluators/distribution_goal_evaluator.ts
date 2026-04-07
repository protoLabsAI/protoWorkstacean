import type { DistributionGoal, GoalViolation, Severity } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";
import { resolvePath } from "../engines/state_diff_engine.ts";

export class DistributionGoalEvaluator {
  evaluate(goal: DistributionGoal, state: WorldState, projectSlug?: string): GoalViolation | null {
    if (goal.enabled === false) return null;

    const { found, value } = resolvePath(state, goal.selector);

    if (!found) {
      return {
        goalId: goal.id,
        goalType: "Distribution",
        severity: (goal.severity ?? "medium") as Severity,
        description: goal.description,
        message: `Selector "${goal.selector}" not found in world state`,
        actual: undefined,
        expected: { pattern: goal.pattern, distribution: goal.distribution },
        timestamp: Date.now(),
        projectSlug,
      };
    }

    // Check pattern: all values in array must match regex
    if (goal.pattern) {
      const violation = this._checkPattern(goal, value, projectSlug);
      if (violation) return violation;
    }

    // Check distribution: value proportions must match expected distribution within tolerance
    if (goal.distribution) {
      const violation = this._checkDistribution(goal, value, projectSlug);
      if (violation) return violation;
    }

    return null;
  }

  private _checkPattern(
    goal: DistributionGoal,
    value: unknown,
    projectSlug?: string,
  ): GoalViolation | null {
    const values = this._toArray(value);
    if (values === null) {
      return {
        goalId: goal.id,
        goalType: "Distribution",
        severity: (goal.severity ?? "medium") as Severity,
        description: goal.description,
        message: `Selector "${goal.selector}" must resolve to an array for pattern check, got ${typeof value}`,
        actual: value,
        expected: { pattern: goal.pattern },
        timestamp: Date.now(),
        projectSlug,
      };
    }

    const regex = new RegExp(goal.pattern!);
    const nonMatching = values.filter(v => !regex.test(String(v)));

    if (nonMatching.length === 0) return null;

    return {
      goalId: goal.id,
      goalType: "Distribution",
      severity: (goal.severity ?? "medium") as Severity,
      description: goal.description,
      message: `${nonMatching.length} value(s) in "${goal.selector}" do not match pattern "${goal.pattern}": ${JSON.stringify(nonMatching.slice(0, 5))}`,
      actual: values,
      expected: { pattern: goal.pattern },
      timestamp: Date.now(),
      projectSlug,
    };
  }

  private _checkDistribution(
    goal: DistributionGoal,
    value: unknown,
    projectSlug?: string,
  ): GoalViolation | null {
    const values = this._toArray(value);
    if (values === null || values.length === 0) {
      return {
        goalId: goal.id,
        goalType: "Distribution",
        severity: (goal.severity ?? "medium") as Severity,
        description: goal.description,
        message: `Selector "${goal.selector}" must resolve to a non-empty array for distribution check`,
        actual: value,
        expected: goal.distribution,
        timestamp: Date.now(),
        projectSlug,
      };
    }

    const tolerance = goal.tolerance ?? 0.1;
    const total = values.length;
    const counts: Record<string, number> = {};

    for (const v of values) {
      const key = String(v);
      counts[key] = (counts[key] ?? 0) + 1;
    }

    const actualDistribution: Record<string, number> = {};
    for (const [key, count] of Object.entries(counts)) {
      actualDistribution[key] = count / total;
    }

    const deviations: string[] = [];
    for (const [key, expectedPct] of Object.entries(goal.distribution!)) {
      const actualPct = actualDistribution[key] ?? 0;
      const deviation = Math.abs(actualPct - expectedPct);
      if (deviation > tolerance) {
        deviations.push(
          `"${key}": expected ${(expectedPct * 100).toFixed(1)}%, got ${(actualPct * 100).toFixed(1)}% (deviation ${(deviation * 100).toFixed(1)}% > tolerance ${(tolerance * 100).toFixed(1)}%)`,
        );
      }
    }

    if (deviations.length === 0) return null;

    return {
      goalId: goal.id,
      goalType: "Distribution",
      severity: (goal.severity ?? "medium") as Severity,
      description: goal.description,
      message: `Distribution violation in "${goal.selector}": ${deviations.join("; ")}`,
      actual: actualDistribution,
      expected: goal.distribution,
      timestamp: Date.now(),
      projectSlug,
    };
  }

  private _toArray(value: unknown): unknown[] | null {
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object") {
      return Object.values(value as Record<string, unknown>);
    }
    return null;
  }
}

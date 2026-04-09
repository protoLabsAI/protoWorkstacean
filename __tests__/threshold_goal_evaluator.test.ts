import { describe, test, expect } from "bun:test";
import { ThresholdGoalEvaluator } from "../src/evaluators/threshold_goal_evaluator.ts";
import type { ThresholdGoal } from "../src/types/goals.ts";

const evaluator = new ThresholdGoalEvaluator();

function makeGoal(overrides: Partial<ThresholdGoal>): ThresholdGoal {
  return {
    id: "test-threshold",
    type: "Threshold",
    description: "Test threshold",
    selector: "metrics.cpu",
    ...overrides,
  };
}

describe("ThresholdGoalEvaluator", () => {
  test("evaluates Threshold goal — value within bounds", () => {
    const goal = makeGoal({ min: 0, max: 80 });
    expect(evaluator.evaluate(goal, { metrics: { cpu: 50 } })).toBeNull();
  });

  test("evaluates Threshold goal — max exceeded", () => {
    const goal = makeGoal({ max: 80 });
    const result = evaluator.evaluate(goal, { metrics: { cpu: 92 } });
    expect(result).not.toBeNull();
    expect(result!.actual).toBe(92);
    expect(result!.message).toContain("exceeds maximum");
  });

  test("evaluates Threshold goal — below min", () => {
    const goal = makeGoal({ min: 10 });
    const result = evaluator.evaluate(goal, { metrics: { cpu: 3 } });
    expect(result).not.toBeNull();
    expect(result!.actual).toBe(3);
    expect(result!.message).toContain("below minimum");
  });

  test("evaluates Threshold goal — exactly at boundary (no violation)", () => {
    const goal = makeGoal({ min: 10, max: 80 });
    expect(evaluator.evaluate(goal, { metrics: { cpu: 10 } })).toBeNull();
    expect(evaluator.evaluate(goal, { metrics: { cpu: 80 } })).toBeNull();
  });

  test("returns violation for non-numeric value", () => {
    const goal = makeGoal({ max: 80 });
    const result = evaluator.evaluate(goal, { metrics: { cpu: "high" } });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("number");
  });

  test("returns violation when selector is missing", () => {
    const goal = makeGoal({ max: 80 });
    const result = evaluator.evaluate(goal, {});
    expect(result).not.toBeNull();
    expect(result!.message).toContain("not found");
  });

  test("skips disabled goals", () => {
    const goal = makeGoal({ max: 80, enabled: false });
    expect(evaluator.evaluate(goal, { metrics: { cpu: 99 } })).toBeNull();
  });

  test("includes projectSlug in violation", () => {
    const goal = makeGoal({ max: 80 });
    const result = evaluator.evaluate(goal, { metrics: { cpu: 95 } }, "proj-1");
    expect(result!.projectSlug).toBe("proj-1");
  });
});

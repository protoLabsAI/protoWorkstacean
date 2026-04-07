import { describe, test, expect } from "bun:test";
import { DistributionGoalEvaluator } from "../src/evaluators/distribution_goal_evaluator.ts";
import type { DistributionGoal } from "../src/types/goals.ts";

const evaluator = new DistributionGoalEvaluator();

function makeGoal(overrides: Partial<DistributionGoal>): DistributionGoal {
  return {
    id: "test-distribution",
    type: "Distribution",
    description: "Test distribution",
    selector: "items",
    ...overrides,
  };
}

describe("DistributionGoalEvaluator", () => {
  test("returns null when all values match pattern", () => {
    const goal = makeGoal({ pattern: "^[a-z]+$" });
    const result = evaluator.evaluate(goal, { items: ["foo", "bar", "baz"] });
    expect(result).toBeNull();
  });

  test("returns violation when values do not match pattern", () => {
    const goal = makeGoal({ pattern: "^[a-z]+$" });
    const result = evaluator.evaluate(goal, { items: ["foo", "BAR", "123"] });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("pattern");
  });

  test("returns null when distribution matches within tolerance", () => {
    const goal = makeGoal({
      distribution: { active: 0.8, idle: 0.2 },
      tolerance: 0.1,
    });
    // 8 active, 2 idle out of 10 = exactly 80/20
    const result = evaluator.evaluate(goal, {
      items: ["active", "active", "active", "active", "active", "active", "active", "active", "idle", "idle"],
    });
    expect(result).toBeNull();
  });

  test("returns violation when distribution deviates beyond tolerance", () => {
    const goal = makeGoal({
      distribution: { active: 0.9, idle: 0.1 },
      tolerance: 0.05,
    });
    // 5 active, 5 idle = 50/50 — violates 90/10 expectation
    const result = evaluator.evaluate(goal, {
      items: ["active", "active", "active", "active", "active", "idle", "idle", "idle", "idle", "idle"],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("Distribution violation");
  });

  test("handles object values (converted to array)", () => {
    const goal = makeGoal({ pattern: "^\\d+$" });
    const result = evaluator.evaluate(goal, { items: { a: "123", b: "456" } });
    expect(result).toBeNull();
  });

  test("returns violation when selector is missing", () => {
    const goal = makeGoal({ pattern: ".*" });
    const result = evaluator.evaluate(goal, {});
    expect(result).not.toBeNull();
    expect(result!.message).toContain("not found");
  });

  test("returns violation for non-array/non-object value", () => {
    const goal = makeGoal({ pattern: ".*" });
    const result = evaluator.evaluate(goal, { items: 42 });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("array");
  });

  test("skips disabled goals", () => {
    const goal = makeGoal({ pattern: "^never$", enabled: false });
    const result = evaluator.evaluate(goal, { items: ["anything"] });
    expect(result).toBeNull();
  });
});

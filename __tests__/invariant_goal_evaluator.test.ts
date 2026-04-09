import { describe, test, expect } from "bun:test";
import { InvariantGoalEvaluator } from "../src/evaluators/invariant_goal_evaluator.ts";
import type { InvariantGoal } from "../src/types/goals.ts";

const evaluator = new InvariantGoalEvaluator();

function makeGoal(overrides: Partial<InvariantGoal>): InvariantGoal {
  return {
    id: "test-goal",
    type: "Invariant",
    description: "Test invariant",
    selector: "status",
    ...overrides,
  };
}

describe("InvariantGoalEvaluator", () => {
  test("returns null when truthy condition is satisfied", () => {
    const goal = makeGoal({ operator: "truthy" });
    const result = evaluator.evaluate(goal, { status: "ok" });
    expect(result).toBeNull();
  });

  test("returns violation when truthy condition fails", () => {
    const goal = makeGoal({ operator: "truthy" });
    const result = evaluator.evaluate(goal, { status: null });
    expect(result).not.toBeNull();
    expect(result!.goalId).toBe("test-goal");
    expect(result!.goalType).toBe("Invariant");
  });

  test("returns null for falsy operator when value is falsy", () => {
    const goal = makeGoal({ operator: "falsy" });
    const result = evaluator.evaluate(goal, { status: false });
    expect(result).toBeNull();
  });

  test("returns violation for falsy operator when value is truthy", () => {
    const goal = makeGoal({ operator: "falsy" });
    const result = evaluator.evaluate(goal, { status: "active" });
    expect(result).not.toBeNull();
  });

  test("evaluates Invariant goal — eq operator match", () => {
    const goal = makeGoal({ operator: "eq", expected: "healthy" });
    const result = evaluator.evaluate(goal, { status: "healthy" });
    expect(result).toBeNull();
  });

  test("evaluates Invariant goal — eq operator violation", () => {
    const goal = makeGoal({ operator: "eq", expected: "healthy" });
    const result = evaluator.evaluate(goal, { status: "degraded" });
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("degraded");
    expect(result!.expected).toBe("healthy");
  });

  test("evaluates Invariant goal — neq operator", () => {
    const goal = makeGoal({ operator: "neq", expected: "error" });
    expect(evaluator.evaluate(goal, { status: "ok" })).toBeNull();
    expect(evaluator.evaluate(goal, { status: "error" })).not.toBeNull();
  });

  test("evaluates Invariant goal — in operator", () => {
    const goal = makeGoal({ operator: "in", expected: ["active", "idle"] });
    expect(evaluator.evaluate(goal, { status: "active" })).toBeNull();
    expect(evaluator.evaluate(goal, { status: "error" })).not.toBeNull();
  });

  test("evaluates Invariant goal — not_in operator", () => {
    const goal = makeGoal({ operator: "not_in", expected: ["error", "fatal"] });
    expect(evaluator.evaluate(goal, { status: "ok" })).toBeNull();
    expect(evaluator.evaluate(goal, { status: "error" })).not.toBeNull();
  });

  test("returns violation when selector is missing from state", () => {
    const goal = makeGoal({ selector: "missing.path" });
    const result = evaluator.evaluate(goal, {});
    expect(result).not.toBeNull();
    expect(result!.message).toContain("not found");
  });

  test("skips disabled goals", () => {
    const goal = makeGoal({ enabled: false, operator: "truthy" });
    const result = evaluator.evaluate(goal, { status: null });
    expect(result).toBeNull();
  });

  test("includes projectSlug in violation", () => {
    const goal = makeGoal({ operator: "truthy" });
    const result = evaluator.evaluate(goal, { status: null }, "my-project");
    expect(result).not.toBeNull();
    expect(result!.projectSlug).toBe("my-project");
  });

  test("defaults severity to medium", () => {
    const goal = makeGoal({ operator: "truthy" });
    const result = evaluator.evaluate(goal, { status: null });
    expect(result!.severity).toBe("medium");
  });
});

/**
 * Tests for HybridPlanner — LLM-A* hybrid planning engine.
 */

import { describe, test, expect } from "bun:test";
import type { Goal, PlannerState, Action, Plan } from "../../src/planner/types.ts";
import type { A2AClient, A2APrompt } from "../../src/planner/a2a-proposer.ts";
import type { CandidatePlan, L2Context } from "../../src/planner/routing-interface.ts";
import { HybridPlanner } from "../../src/planner/hybrid-planner.ts";
import { ActionGraph } from "../../src/planner/action-graph.ts";
import { ConfidenceScorer } from "../../src/planner/confidence-scorer.ts";
import { EscalationTrigger } from "../../src/planner/escalation-trigger.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAction(id: string, cost: number, pre: (s: PlannerState) => boolean, eff: (s: PlannerState) => PlannerState): Action {
  return { id, name: id, cost, level: "action" as const, preconditions: [pre], effects: [eff] };
}

class MockA2AClient implements A2AClient {
  private candidates: CandidatePlan[];
  constructor(candidates: CandidatePlan[] = []) { this.candidates = candidates; }
  async proposePlans(_p: A2APrompt, _m: number): Promise<CandidatePlan[]> { return this.candidates; }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("HybridPlanner", () => {
  const action1 = makeAction("a1", 3, (s) => s["x"] === 0, (s) => ({ ...s, x: 1 }));
  const action2 = makeAction("a2", 2, (s) => s["x"] === 1, (s) => ({ ...s, x: 2 }));

  const goal: Goal = (s) => s["x"] === 2;
  const state: PlannerState = { x: 0 };

  test("finds plan via A* when no LLM candidates", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const planner = new HybridPlanner(new MockA2AClient(), graph);
    const context: L2Context = {
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-1",
    };

    const result = await planner.plan(context);
    expect(result.success).toBe(true);
    expect(result.plan?.isComplete).toBe(true);
    expect(result.plan?.actions).toHaveLength(2);
    expect(result.confidence.overall).toBeGreaterThan(0);
  });

  test("validates LLM-proposed candidate", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const validPlan: Plan = {
      actions: [action1, action2],
      totalCost: 5,
      isComplete: true,
    };

    const client = new MockA2AClient([{
      plan: validPlan,
      rationale: "Chain a1→a2 achieves goal",
      llmConfidence: 0.9,
    }]);

    const planner = new HybridPlanner(client, graph);
    const context: L2Context = {
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-2",
    };

    const result = await planner.plan(context);
    expect(result.success).toBe(true);
    expect(result.confidence.overall).toBeGreaterThan(0);
  });

  test("rejects invalid LLM candidate and falls back to A*", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    // Invalid plan: action2 before action1 (precondition violation)
    const invalidPlan: Plan = {
      actions: [action2, action1],
      totalCost: 5,
      isComplete: true,
    };

    const client = new MockA2AClient([{
      plan: invalidPlan,
      rationale: "Reversed order",
      llmConfidence: 0.5,
    }]);

    const planner = new HybridPlanner(client, graph);
    const context: L2Context = {
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-3",
    };

    const result = await planner.plan(context);
    // Should still find a plan via A* optimization
    expect(result.plan?.isComplete).toBe(true);
  });

  test("escalates to L3 when no plan found", async () => {
    const graph = new ActionGraph(); // Empty — no actions available

    const planner = new HybridPlanner(new MockA2AClient(), graph);
    const context: L2Context = {
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-4",
    };

    const result = await planner.plan(context);
    expect(result.success).toBe(false);
    expect(result.escalatedToL3).toBe(true);
    expect(result.confidence.overall).toBe(0);
  });

  test("returns confidence breakdown", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const planner = new HybridPlanner(new MockA2AClient(), graph);
    const context: L2Context = {
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-5",
    };

    const result = await planner.plan(context);
    expect(result.confidence.breakdown.feasibility).toBeDefined();
    expect(result.confidence.breakdown.goalAlignment).toBeDefined();
    expect(result.confidence.breakdown.costEfficiency).toBeDefined();
    expect(result.confidence.breakdown.constraintSatisfaction).toBeDefined();
  });
});

describe("ConfidenceScorer", () => {
  const action = makeAction("a", 5, () => true, (s) => ({ ...s, done: true }));

  test("scores valid complete plan highly", () => {
    const scorer = new ConfidenceScorer();
    const plan: Plan = { actions: [action], totalCost: 5, isComplete: true };
    const state: PlannerState = { done: false };
    const goal: Goal = (s) => s["done"] === true;

    const score = scorer.score(plan, state, goal, {
      valid: true,
      failedAtIndex: -1,
      finalState: { done: true },
    });

    expect(score.overall).toBeGreaterThan(0.5);
    expect(score.breakdown.feasibility).toBe(1.0);
  });

  test("scores invalid plan as zero", () => {
    const scorer = new ConfidenceScorer();
    const plan: Plan = { actions: [action], totalCost: 5, isComplete: true };
    const state: PlannerState = { done: false };
    const goal: Goal = (s) => s["done"] === true;

    const score = scorer.score(plan, state, goal, {
      valid: false,
      failedAtIndex: 0,
      finalState: state,
      error: "fail",
    });

    expect(score.overall).toBe(0);
  });
});

describe("EscalationTrigger", () => {
  test("escalates when below threshold", () => {
    const trigger = new EscalationTrigger(0.5);
    const result = trigger.evaluate({
      overall: 0.3,
      breakdown: { feasibility: 0.3, goalAlignment: 0.3, costEfficiency: 0.3, constraintSatisfaction: 0.3 },
    });
    expect(result.shouldEscalate).toBe(true);
  });

  test("does not escalate when above threshold", () => {
    const trigger = new EscalationTrigger(0.5);
    const result = trigger.evaluate({
      overall: 0.8,
      breakdown: { feasibility: 0.8, goalAlignment: 0.8, costEfficiency: 0.8, constraintSatisfaction: 0.8 },
    });
    expect(result.shouldEscalate).toBe(false);
    expect(result.isBorderline).toBe(false);
  });

  test("flags borderline confidence", () => {
    const trigger = new EscalationTrigger(0.5, 0.05);
    const result = trigger.evaluate({
      overall: 0.52,
      breakdown: { feasibility: 0.5, goalAlignment: 0.5, costEfficiency: 0.5, constraintSatisfaction: 0.6 },
    });
    expect(result.shouldEscalate).toBe(false);
    expect(result.isBorderline).toBe(true);
  });
});

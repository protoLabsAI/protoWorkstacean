/**
 * Tests for L2Router — verifies routing logic from L0→L1→L2→L3.
 */

import { describe, test, expect } from "bun:test";
import type { Goal, PlannerState, Action, Plan, L0Context } from "../../src/planner/types.ts";
import type { L0RuleMatcher, L0MatchResult } from "../../src/matcher/l0-l1-bridge.ts";
import type { A2AClient, A2APrompt } from "../../src/planner/a2a-proposer.ts";
import type { CandidatePlan } from "../../src/planner/routing-interface.ts";
import { L2Router } from "../../src/planner/l2-router.ts";
import { HybridPlanner } from "../../src/planner/hybrid-planner.ts";
import { ActionGraph } from "../../src/planner/action-graph.ts";
import { DEFAULT_ROUTING_CONFIG } from "../../src/planner/routing-interface.ts";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeAction(id: string, cost: number, pre: (s: PlannerState) => boolean, eff: (s: PlannerState) => PlannerState): Action {
  return {
    id,
    name: id,
    cost,
    level: "action" as const,
    preconditions: [pre],
    effects: [eff],
  };
}

function makeGraph(actions: Action[]): ActionGraph {
  const g = new ActionGraph();
  g.addActions(actions);
  return g;
}

class MockA2AClient implements A2AClient {
  private candidates: CandidatePlan[];
  constructor(candidates: CandidatePlan[] = []) {
    this.candidates = candidates;
  }
  async proposePlans(_prompt: A2APrompt, _max: number): Promise<CandidatePlan[]> {
    return this.candidates;
  }
}

class MockL0Matcher implements L0RuleMatcher {
  private result: L0MatchResult;
  constructor(result: L0MatchResult) {
    this.result = result;
  }
  match(_state: PlannerState, _goal: Goal): L0MatchResult {
    return this.result;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("L2Router", () => {
  const action = makeAction(
    "fix-issue",
    5,
    (s) => s["issue_open"] === true,
    (s) => ({ ...s, issue_open: false }),
  );

  const goal: Goal = (s) => s["issue_open"] === false;
  const state: PlannerState = { issue_open: true };

  test("routes to L0 when matcher finds a match", async () => {
    const matcher = new MockL0Matcher({
      matched: true,
      action,
    });

    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid, {}, undefined, matcher);

    const result = await router.resolve(state, goal);
    expect(result.success).toBe(true);
    expect(result.plan?.actions).toHaveLength(1);
    expect(result.plan?.actions[0].id).toBe("fix-issue");
    expect(result.escalatedToL3).toBe(false);
  });

  test("falls through to L2 when L0 has no match and L1 unavailable", async () => {
    const matcher = new MockL0Matcher({
      matched: false,
      reason: "no matching rule",
    });

    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid, {}, undefined, matcher);

    const result = await router.resolve(state, goal);
    // L2 should attempt A* optimization since no LLM candidates
    expect(result.planId).toBeDefined();
  });

  test("decideRoute returns l0 for high L0 confidence", () => {
    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid);

    const decision = router.decideRoute(state, goal, 0.9, undefined);
    expect(decision.target).toBe("l0");
  });

  test("decideRoute returns l1 for high L1 confidence", () => {
    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid);

    const decision = router.decideRoute(state, goal, 0.3, 0.8);
    expect(decision.target).toBe("l1");
  });

  test("decideRoute returns l2 when both below threshold", () => {
    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid);

    const decision = router.decideRoute(state, goal, 0.3, 0.3);
    expect(decision.target).toBe("l2");
  });

  test("invokes L3 escalation handler when confidence too low", async () => {
    let escalated = false;
    const graph = makeGraph([]); // Empty graph → no plan possible
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid, {
      onL3Escalation: () => { escalated = true; },
    });

    const impossibleGoal: Goal = (s) => s["impossible"] === true;
    await router.resolve(state, impossibleGoal);
    expect(escalated).toBe(true);
  });

  test("invokeL2 directly invokes hybrid planner", async () => {
    const graph = makeGraph([action]);
    const hybrid = new HybridPlanner(new MockA2AClient(), graph);
    const router = new L2Router(hybrid);

    const result = await router.invokeL2({
      currentState: state,
      goal,
      failures: [],
      correlationId: "test-123",
    });

    expect(result.planId).toBeDefined();
    expect(result.confidence).toBeDefined();
  });
});

/**
 * End-to-end integration test: full L0→L1→L2→L3 pipeline
 * with learning flywheel validation.
 */

import { describe, test, expect } from "bun:test";
import type { Goal, PlannerState, Action, Plan } from "../../src/planner/types.ts";
import type { A2AClient, A2APrompt } from "../../src/planner/a2a-proposer.ts";
import type { CandidatePlan } from "../../src/planner/routing-interface.ts";
import { L2Dispatcher } from "../../src/planner/dispatcher.ts";
import { ActionGraph } from "../../src/planner/action-graph.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAction(
  id: string,
  cost: number,
  pre: (s: PlannerState) => boolean,
  eff: (s: PlannerState) => PlannerState,
): Action {
  return {
    id,
    name: id,
    cost,
    level: "action" as const,
    preconditions: [pre],
    effects: [eff],
  };
}

class MockA2AClient implements A2AClient {
  callCount = 0;
  async proposePlans(_prompt: A2APrompt, _max: number): Promise<CandidatePlan[]> {
    this.callCount++;
    return [];
  }
}

// ── Integration tests ───────────────────────────────────────────────────────

describe("E2E: L2 Dispatcher + Learning Flywheel", () => {
  const action1 = makeAction("step-1", 3, (s) => s["phase"] === 0, (s) => ({ ...s, phase: 1 }));
  const action2 = makeAction("step-2", 2, (s) => s["phase"] === 1, (s) => ({ ...s, phase: 2 }));
  const goal: Goal = (s) => s["phase"] === 2;
  const state: PlannerState = { phase: 0 };
  const namedGoal = { id: "advance-phase", name: "Advance to phase 2", test: goal };

  test("resolves through A* when no LLM configured", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const dispatcher = new L2Dispatcher(graph, {
      routing: { l0ConfidenceThreshold: 0.7, l1ConfidenceThreshold: 0.6, l2ConfidenceThreshold: 0.5, maxCandidates: 3, l2TimeBudgetMs: 5000, tryL1BeforeL2: false },
    });

    const result = await dispatcher.resolve(state, goal, namedGoal);
    expect(result.success).toBe(true);
    expect(result.plan?.isComplete).toBe(true);
    expect(result.plan?.actions).toHaveLength(2);
  });

  test("learning flywheel creates rules from successful plans", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const dispatcher = new L2Dispatcher(graph, {
      routing: { l0ConfidenceThreshold: 0.7, l1ConfidenceThreshold: 0.6, l2ConfidenceThreshold: 0.5, maxCandidates: 3, l2TimeBudgetMs: 5000, tryL1BeforeL2: false },
    });

    // First resolve — should create a learned rule
    await dispatcher.resolve(state, goal, namedGoal);

    const registry = dispatcher.getRuleRegistry();
    expect(registry.size).toBeGreaterThanOrEqual(1);
  });

  test("learned rules speed up subsequent resolves", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const a2a = new MockA2AClient();
    const dispatcher = new L2Dispatcher(graph, {
      a2aClient: a2a,
      routing: { l0ConfidenceThreshold: 0.7, l1ConfidenceThreshold: 0.6, l2ConfidenceThreshold: 0.5, maxCandidates: 3, l2TimeBudgetMs: 5000, tryL1BeforeL2: false },
    });

    // First resolve — goes through L2, creates rule
    const result1 = await dispatcher.resolve(state, goal, namedGoal);
    expect(result1.success).toBe(true);
    const callsAfterFirst = a2a.callCount;

    // Second resolve — should use learned rule, skip L2
    const result2 = await dispatcher.resolve(state, goal, namedGoal);
    expect(result2.success).toBe(true);
    // A2A should NOT have been called again (learned rule used)
    expect(a2a.callCount).toBe(callsAfterFirst);
  });

  test("metrics track invocations and escalation rate", async () => {
    const graph = new ActionGraph();
    graph.addActions([action1, action2]);

    const dispatcher = new L2Dispatcher(graph, {
      routing: { l0ConfidenceThreshold: 0.7, l1ConfidenceThreshold: 0.6, l2ConfidenceThreshold: 0.5, maxCandidates: 3, l2TimeBudgetMs: 5000, tryL1BeforeL2: false },
    });

    await dispatcher.resolve(state, goal, namedGoal);

    const metrics = dispatcher.getMetrics();
    const summary = metrics.getSummary();
    expect(summary.totalInvocations).toBeGreaterThanOrEqual(1);
    expect(summary.successRate).toBeGreaterThan(0);
  });

  test("escalation is tracked when plan impossible", async () => {
    const graph = new ActionGraph(); // Empty — no plan possible
    let escalated = false;

    const dispatcher = new L2Dispatcher(graph, {
      routing: { l0ConfidenceThreshold: 0.7, l1ConfidenceThreshold: 0.6, l2ConfidenceThreshold: 0.5, maxCandidates: 3, l2TimeBudgetMs: 5000, tryL1BeforeL2: false },
      onL3Escalation: () => { escalated = true; },
    });

    const impossibleGoal: Goal = (s) => s["impossible"] === true;
    await dispatcher.resolve(state, impossibleGoal);

    expect(escalated).toBe(true);
    const tracker = dispatcher.getEscalationTracker();
    const counts = tracker.getCounts();
    expect(counts.total).toBeGreaterThanOrEqual(1);
  });
});

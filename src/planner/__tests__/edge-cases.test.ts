import { describe, test, expect } from "bun:test";
import { ActionGraph } from "../action-graph.ts";
import { action } from "../action.ts";
import { createState, stateKey, statesEqual, emptyState } from "../world-state.ts";
import { zeroHeuristic } from "../heuristic.ts";
import { aStarSearch } from "../a-star.ts";
import { validatePlan } from "../plan-validator.ts";
import { TaskNetwork } from "../task-network.ts";
import { HTNDecomposer } from "../htn-decomposer.ts";
import { MemoCache, memoizeHeuristic } from "../memo-cache.ts";
import { StateCache } from "../state-cache.ts";
import { clusterGoals } from "../optimization.ts";
import type { PlannerState, SearchNode } from "../types.ts";

describe("edge cases — empty goals", () => {
  test("goal already satisfied returns empty plan", () => {
    const graph = new ActionGraph();
    graph.addAction(action("a", "test").set({ x: 1 }).build());

    const initial = createState({ done: true });
    const goal = (s: PlannerState) => s.done === true;

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.actions.length).toBe(0);
  });
});

describe("edge cases — impossible states", () => {
  test("no actions available returns empty incomplete plan", () => {
    const graph = new ActionGraph();
    const initial = createState({ x: 0 });
    const goal = (s: PlannerState) => s.x === 99;

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(false);
    expect(result.exhaustive).toBe(true);
  });

  test("all preconditions unsatisfied returns incomplete plan", () => {
    const graph = new ActionGraph();
    graph.addAction(
      action("a", "needs-magic")
        .requireEquals("magic", true)
        .set({ x: 99 })
        .build(),
    );

    const initial = createState({ magic: false, x: 0 });
    const goal = (s: PlannerState) => s.x === 99;

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(false);
  });
});

describe("edge cases — circular dependencies", () => {
  test("A* handles cycles without infinite loop", () => {
    const graph = new ActionGraph();
    // Create a cycle: A→B→A, with an exit B→C
    graph.addActions([
      action("ab", "A-to-B")
        .requireEquals("pos", "A")
        .set({ pos: "B" })
        .cost(1)
        .build(),
      action("ba", "B-to-A")
        .requireEquals("pos", "B")
        .set({ pos: "A" })
        .cost(1)
        .build(),
      action("bc", "B-to-C")
        .requireEquals("pos", "B")
        .set({ pos: "C" })
        .cost(1)
        .build(),
    ]);

    const initial = createState({ pos: "A" });
    const goal = (s: PlannerState) => s.pos === "C";

    const result = aStarSearch(graph, initial, goal, zeroHeuristic, {
      maxExpansions: 100,
    });
    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.actions.map((a) => a.id)).toEqual(["ab", "bc"]);
  });
});

describe("world state utilities", () => {
  test("stateKey is deterministic regardless of key order", () => {
    const s1 = createState({ b: 2, a: 1 });
    const s2 = createState({ a: 1, b: 2 });
    expect(stateKey(s1)).toBe(stateKey(s2));
  });

  test("statesEqual works correctly", () => {
    const s1 = createState({ x: 1, y: "hello" });
    const s2 = createState({ x: 1, y: "hello" });
    const s3 = createState({ x: 2, y: "hello" });
    expect(statesEqual(s1, s2)).toBe(true);
    expect(statesEqual(s1, s3)).toBe(false);
  });

  test("emptyState is frozen", () => {
    const empty = emptyState();
    expect(Object.keys(empty).length).toBe(0);
    expect(Object.isFrozen(empty)).toBe(true);
  });
});

describe("memo cache", () => {
  test("memoized heuristic caches results", () => {
    let callCount = 0;
    const h = (state: PlannerState, _goal: (s: PlannerState) => boolean) => {
      callCount++;
      return Object.keys(state).length;
    };

    const memoized = memoizeHeuristic(h, 100);
    const state = createState({ a: 1 });
    const goal = () => true;

    const v1 = memoized(state, goal);
    const v2 = memoized(state, goal);

    expect(v1).toBe(v2);
    expect(callCount).toBe(1); // Only called once
  });

  test("MemoCache respects maxSize", () => {
    const cache = new MemoCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // Should evict "a"

    expect(cache.has("a")).toBe(false);
    expect(cache.has("d")).toBe(true);
    expect(cache.size).toBe(3);
  });
});

describe("state cache", () => {
  test("caches states and tracks best g-score", () => {
    const cache = new StateCache();
    const node1: SearchNode = {
      state: createState({ x: 1 }),
      stateKey: "x=1",
      parent: null,
      action: null,
      gScore: 10,
      fScore: 15,
    };

    cache.put(node1);
    expect(cache.has("x=1")).toBe(true);
    expect(cache.hasBetterOrEqual("x=1", 10)).toBe(true);
    expect(cache.hasBetterOrEqual("x=1", 5)).toBe(false);

    // Better g-score should update
    const node2 = { ...node1, gScore: 5, fScore: 10 };
    cache.put(node2);
    expect(cache.hasBetterOrEqual("x=1", 5)).toBe(true);
  });
});

describe("goal clustering", () => {
  test("clusters goals with overlapping keys", () => {
    const goals = [
      { id: "g1", goal: (s: PlannerState) => s.a === 1, relevantKeys: ["a", "b"] },
      { id: "g2", goal: (s: PlannerState) => s.b === 2, relevantKeys: ["b", "c"] },
      { id: "g3", goal: (s: PlannerState) => s.d === 3, relevantKeys: ["d"] },
    ];

    const clusters = clusterGoals(goals);
    // g1 and g2 share key "b", so they cluster together
    // g3 is independent
    expect(clusters.length).toBe(2);

    const bigCluster = clusters.find((c) => c.goalIds.length === 2);
    const smallCluster = clusters.find((c) => c.goalIds.length === 1);
    expect(bigCluster).toBeDefined();
    expect(smallCluster).toBeDefined();
    expect(bigCluster!.goalIds.sort()).toEqual(["g1", "g2"]);
    expect(smallCluster!.goalIds).toEqual(["g3"]);
  });
});

describe("HTN edge cases", () => {
  test("decomposition of unknown task returns failure", () => {
    const network = new TaskNetwork();
    const decomposer = new HTNDecomposer(network);
    const result = decomposer.decompose("nonexistent", createState({}));
    expect(result.success).toBe(false);
  });

  test("empty network produces no actions", () => {
    const network = new TaskNetwork();
    const decomposer = new HTNDecomposer(network);
    const result = decomposer.fullDecomposition(createState({}));
    expect(result.success).toBe(false);
  });
});

describe("validation edge cases", () => {
  test("empty plan validates successfully", () => {
    const plan = { actions: [], totalCost: 0, isComplete: true };
    const state = createState({});
    const result = validatePlan(plan, state);
    expect(result.valid).toBe(true);
  });

  test("validation preserves original state", () => {
    const plan = {
      actions: [
        action("a", "modify").set({ x: 999 }).build(),
      ],
      totalCost: 1,
      isComplete: true,
    };

    const state = createState({ x: 0 });
    validatePlan(plan, state);
    expect(state.x).toBe(0); // Original untouched
  });
});

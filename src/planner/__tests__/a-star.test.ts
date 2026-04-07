import { describe, test, expect } from "bun:test";
import { aStarSearch } from "../a-star.ts";
import { ActionGraph } from "../action-graph.ts";
import { action } from "../action.ts";
import { createState } from "../world-state.ts";
import { zeroHeuristic, stateDiffHeuristic } from "../heuristic.ts";
import { AnytimePlanner } from "../anytime-planner.ts";
import type { PlannerState } from "../types.ts";

describe("A* search", () => {
  test("finds plan for simple linear chain", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("s1", "step1")
        .requireEquals("phase", "start")
        .set({ phase: "mid" })
        .cost(1)
        .build(),
      action("s2", "step2")
        .requireEquals("phase", "mid")
        .set({ phase: "goal" })
        .cost(1)
        .build(),
    ]);

    const initial = createState({ phase: "start" });
    const goal = (s: PlannerState) => s.phase === "goal";

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.actions.length).toBe(2);
    expect(result.plan.totalCost).toBe(2);
    expect(result.plan.actions[0].id).toBe("s1");
    expect(result.plan.actions[1].id).toBe("s2");
  });

  test("finds optimal path among alternatives", () => {
    const graph = new ActionGraph();
    // Expensive direct path
    graph.addAction(
      action("direct", "direct-path")
        .requireEquals("at", "A")
        .set({ at: "C" })
        .cost(10)
        .build(),
    );
    // Cheap two-step path
    graph.addActions([
      action("ab", "A-to-B")
        .requireEquals("at", "A")
        .set({ at: "B" })
        .cost(2)
        .build(),
      action("bc", "B-to-C")
        .requireEquals("at", "B")
        .set({ at: "C" })
        .cost(3)
        .build(),
    ]);

    const initial = createState({ at: "A" });
    const goal = (s: PlannerState) => s.at === "C";
    const result = aStarSearch(graph, initial, goal, zeroHeuristic);

    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.totalCost).toBe(5);
    expect(result.plan.actions.map((a) => a.id)).toEqual(["ab", "bc"]);
  });

  test("returns empty plan when initial state satisfies goal", () => {
    const graph = new ActionGraph();
    const initial = createState({ done: true });
    const goal = (s: PlannerState) => s.done === true;

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.actions.length).toBe(0);
    expect(result.plan.totalCost).toBe(0);
  });

  test("returns incomplete plan when goal is unreachable", () => {
    const graph = new ActionGraph();
    graph.addAction(
      action("a1", "only-action")
        .requireEquals("x", 1)
        .set({ x: 2 })
        .build(),
    );

    const initial = createState({ x: 0 });
    const goal = (s: PlannerState) => s.x === 99;

    const result = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(result.plan.isComplete).toBe(false);
    expect(result.exhaustive).toBe(true);
  });

  test("respects maxExpansions budget", () => {
    const graph = new ActionGraph();
    // Create a large branching graph
    for (let i = 0; i < 50; i++) {
      graph.addAction(
        action(`a${i}`, `action-${i}`)
          .set({ [`visited_${i}`]: true })
          .cost(1)
          .build(),
      );
    }

    const initial = createState({});
    const goal = (_s: PlannerState) => false; // Unreachable

    const result = aStarSearch(graph, initial, goal, zeroHeuristic, {
      maxExpansions: 5,
    });
    expect(result.nodesExpanded).toBeLessThanOrEqual(5);
    expect(result.exhaustive).toBe(false);
  });

  test("heuristic guides search efficiently", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("right", "go-right")
        .requireEquals("x", 0)
        .set({ x: 1 })
        .cost(1)
        .build(),
      action("wrong", "go-wrong")
        .requireEquals("x", 0)
        .set({ x: -1 })
        .cost(1)
        .build(),
      action("finish", "finish")
        .requireEquals("x", 1)
        .set({ x: 2, done: true })
        .cost(1)
        .build(),
    ]);

    const goalState = createState({ x: 2, done: true });
    const heuristic = stateDiffHeuristic(goalState);
    const initial = createState({ x: 0, done: false });
    const goal = (s: PlannerState) => s.x === 2 && s.done === true;

    const result = aStarSearch(graph, initial, goal, heuristic);
    expect(result.plan.isComplete).toBe(true);
    expect(result.plan.actions.map((a) => a.id)).toEqual(["right", "finish"]);
  });
});

describe("budget-bounded anytime search", () => {
  test("returns best plan within budget and improves with more time", () => {
    const graph = new ActionGraph();

    // Create a simple graph where there are two paths
    graph.addActions([
      // Expensive direct path
      action("direct", "direct")
        .requireEquals("pos", "start")
        .set({ pos: "goal" })
        .cost(10)
        .build(),
      // Cheap two-step path
      action("step1", "step1")
        .requireEquals("pos", "start")
        .set({ pos: "mid" })
        .cost(2)
        .build(),
      action("step2", "step2")
        .requireEquals("pos", "mid")
        .set({ pos: "goal" })
        .cost(2)
        .build(),
    ]);

    const initial = createState({ pos: "start" });
    const goal = (s: PlannerState) => s.pos === "goal";

    const planner = new AnytimePlanner(graph, zeroHeuristic);
    const result = planner.search(initial, goal, {
      timeBudgetMs: 5000,
    });

    expect(result.searchResult.plan.isComplete).toBe(true);
    // Should find the cheaper path
    expect(result.searchResult.plan.totalCost).toBe(4);
  });

  test("anytime planner can be resumed for improvement", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("a", "action-a")
        .requireEquals("state", "init")
        .set({ state: "done" })
        .cost(5)
        .build(),
    ]);

    const initial = createState({ state: "init" });
    const goal = (s: PlannerState) => s.state === "done";

    const planner = new AnytimePlanner(graph, zeroHeuristic);

    // Initial search
    const first = planner.search(initial, goal, { timeBudgetMs: 100 });
    expect(first.searchResult.plan.isComplete).toBe(true);

    // Resume
    const second = planner.resume(initial, goal, { timeBudgetMs: 100 });
    expect(second.searchResult.plan.isComplete).toBe(true);
    expect(second.iterations).toBeGreaterThan(first.iterations);
  });
});

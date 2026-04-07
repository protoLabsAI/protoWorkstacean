import { describe, test, expect } from "bun:test";
import { ActionGraph } from "../action-graph.ts";
import { action } from "../action.ts";
import { createState } from "../world-state.ts";

describe("action graph", () => {
  test("empty graph returns no applicable actions", () => {
    const graph = new ActionGraph();
    const state = createState({ x: 1 });
    expect(graph.getApplicableActions(state)).toEqual([]);
  });

  test("returns actions whose preconditions are met", () => {
    const graph = new ActionGraph();
    const a1 = action("a1", "action1")
      .requireEquals("ready", true)
      .set({ done: true })
      .build();
    const a2 = action("a2", "action2")
      .requireEquals("ready", false)
      .set({ done: true })
      .build();

    graph.addActions([a1, a2]);
    const state = createState({ ready: true });

    const applicable = graph.getApplicableActions(state);
    expect(applicable.length).toBe(1);
    expect(applicable[0].id).toBe("a1");
  });

  test("getSuccessors returns action + result state", () => {
    const graph = new ActionGraph();
    const a = action("a1", "set-done")
      .requireEquals("status", "pending")
      .set({ status: "done" })
      .build();

    graph.addAction(a);
    const state = createState({ status: "pending" });
    const successors = graph.getSuccessors(state);

    expect(successors.length).toBe(1);
    expect(successors[0].action.id).toBe("a1");
    expect(successors[0].resultState.status).toBe("done");
  });

  test("removeAction works", () => {
    const graph = new ActionGraph();
    const a = action("a1", "test").build();
    graph.addAction(a);
    expect(graph.size).toBe(1);

    graph.removeAction("a1");
    expect(graph.size).toBe(0);
  });

  test("multiple actions applicable from same state", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("a1", "first").set({ path: "a" }).build(),
      action("a2", "second").set({ path: "b" }).build(),
    ]);

    const state = createState({});
    const applicable = graph.getApplicableActions(state);
    expect(applicable.length).toBe(2);
  });

  test("action graph search finds valid plan (multi-step)", () => {
    const graph = new ActionGraph();

    // Simple 3-step chain: start → step1 → step2 → goal
    graph.addActions([
      action("s1", "step1")
        .requireEquals("phase", "start")
        .set({ phase: "step1" })
        .cost(1)
        .build(),
      action("s2", "step2")
        .requireEquals("phase", "step1")
        .set({ phase: "step2" })
        .cost(1)
        .build(),
      action("s3", "step3")
        .requireEquals("phase", "step2")
        .set({ phase: "goal" })
        .cost(1)
        .build(),
    ]);

    const initial = createState({ phase: "start" });
    let current = initial;
    const path: string[] = [];

    // Manually walk the graph
    for (let step = 0; step < 3; step++) {
      const successors = graph.getSuccessors(current);
      expect(successors.length).toBe(1);
      path.push(successors[0].action.id);
      current = successors[0].resultState;
    }

    expect(path).toEqual(["s1", "s2", "s3"]);
    expect(current.phase).toBe("goal");
  });
});

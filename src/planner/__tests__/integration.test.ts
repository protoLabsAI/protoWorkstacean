import { describe, test, expect } from "bun:test";
import { ActionGraph } from "../action-graph.ts";
import { action } from "../action.ts";
import { createState } from "../world-state.ts";
import { zeroHeuristic } from "../heuristic.ts";
import { aStarSearch } from "../a-star.ts";
import { validatePlan, validateNoSideEffects } from "../plan-validator.ts";
import { ReplanManager } from "../replan-manager.ts";
import { HTNDecomposer } from "../htn-decomposer.ts";
import { TaskNetwork } from "../task-network.ts";
import { L0L1Bridge } from "../../matcher/l0-l1-bridge.ts";
import type { L0RuleMatcher } from "../../matcher/l0-l1-bridge.ts";
import type { PlannerState, CompositeTask } from "../types.ts";

describe("plan validation", () => {
  test("validates valid plan without side effects", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("a", "step-a")
        .requireEquals("status", "init")
        .set({ status: "processing" })
        .build(),
      action("b", "step-b")
        .requireEquals("status", "processing")
        .set({ status: "done" })
        .build(),
    ]);

    const initial = createState({ status: "init" });
    const goal = (s: PlannerState) => s.status === "done";
    const result = aStarSearch(graph, initial, goal, zeroHeuristic);

    // Validate plan
    const validation = validatePlan(result.plan, initial, goal);
    expect(validation.valid).toBe(true);
    expect(validation.failedAtIndex).toBe(-1);
    expect(validation.finalState.status).toBe("done");

    // Verify no side effects
    const sideEffects = validateNoSideEffects(result.plan, initial);
    expect(sideEffects.preserved).toBe(true);
  });

  test("detects precondition violation during validation", () => {
    const graph = new ActionGraph();
    const plan = {
      actions: [
        action("a", "requires-ready")
          .requireEquals("ready", true)
          .set({ done: true })
          .build(),
      ],
      totalCost: 1,
      isComplete: true,
    };

    const state = createState({ ready: false });
    const validation = validatePlan(plan, state);

    expect(validation.valid).toBe(false);
    expect(validation.failedAtIndex).toBe(0);
    expect(validation.error).toContain("Precondition failed");
  });

  test("detects goal not satisfied after execution", () => {
    const plan = {
      actions: [
        action("a", "set-x").set({ x: 1 }).build(),
      ],
      totalCost: 1,
      isComplete: true,
    };

    const state = createState({ x: 0 });
    const goal = (s: PlannerState) => s.x === 99;
    const validation = validatePlan(plan, state, goal);

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("does not satisfy goal");
  });
});

describe("replan on state change", () => {
  test("replanning occurs and recovers when world state changes", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("a", "step-a")
        .requireEquals("blocked", false)
        .set({ phase: "mid" })
        .cost(1)
        .build(),
      action("b", "step-b")
        .requireEquals("phase", "mid")
        .requireEquals("blocked", false)
        .set({ phase: "done" })
        .cost(1)
        .build(),
      // Alternative path that works even when blocked
      action("c", "bypass")
        .requireEquals("phase", "mid")
        .requireEquals("blocked", true)
        .set({ phase: "done" })
        .cost(3)
        .build(),
    ]);

    const goal = (s: PlannerState) => s.phase === "done";
    const manager = new ReplanManager(graph, zeroHeuristic, goal);

    // Original plan: a → b
    const originalPlan = {
      actions: [
        graph.getAllActions()[0], // step-a
        graph.getAllActions()[1], // step-b
      ],
      totalCost: 2,
      isComplete: true,
    };

    // After executing step-a, world state changes: blocked becomes true
    const expectedState = createState({ blocked: false, phase: "mid" });
    const actualState = createState({ blocked: true, phase: "mid" });

    const result = manager.checkAndReplan(
      originalPlan,
      1, // executed 1 step
      expectedState,
      actualState,
      { timeBudgetMs: 5000 },
    );

    expect(result.success).toBe(true);
    // New plan should use the bypass action
    const lastAction = result.plan.actions[result.plan.actions.length - 1];
    expect(lastAction.id).toBe("c");
  });

  test("no replan needed when state unchanged", () => {
    const graph = new ActionGraph();
    const goal = (s: PlannerState) => s.done === true;
    const manager = new ReplanManager(graph, zeroHeuristic, goal);

    const plan = {
      actions: [action("a", "test").set({ done: true }).build()],
      totalCost: 1,
      isComplete: true,
    };

    const state = createState({ x: 1 });
    const result = manager.checkAndReplan(plan, 0, state, state, {
      timeBudgetMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.replanFromIndex).toBe(-1);
  });
});

describe("HTN decomposition", () => {
  test("decomposes portfolio→project→domain→action hierarchy", () => {
    const network = new TaskNetwork();

    // Primitive actions at bottom level
    const restartService = action("restart", "restart-service")
      .level("action")
      .requireEquals("service.status", "down")
      .set({ "service.status": "healthy" })
      .cost(2)
      .build();

    const runTests = action("tests", "run-tests")
      .level("action")
      .requireEquals("service.status", "healthy")
      .set({ "tests.passed": true })
      .cost(3)
      .build();

    network.addPrimitiveAction(restartService);
    network.addPrimitiveAction(runTests);

    // Domain-level composite: "fix service"
    const fixService: CompositeTask = {
      id: "fix-service",
      name: "Fix Service",
      level: "domain",
      decompose: (_state) => ["restart", "tests"],
    };
    network.addCompositeTask(fixService);

    // Project-level composite: "stabilize project"
    const stabilizeProject: CompositeTask = {
      id: "stabilize-project",
      name: "Stabilize Project",
      level: "project",
      decompose: (_state) => ["fix-service"],
    };
    network.addCompositeTask(stabilizeProject);

    // Portfolio-level composite: "improve health"
    const improveHealth: CompositeTask = {
      id: "improve-health",
      name: "Improve Portfolio Health",
      level: "portfolio",
      decompose: (_state) => ["stabilize-project"],
    };
    network.addCompositeTask(improveHealth);

    const decomposer = new HTNDecomposer(network);
    const state = createState({ "service.status": "down" });

    // Full decomposition from portfolio level
    const result = decomposer.decompose("improve-health", state);
    expect(result.success).toBe(true);
    expect(result.actions.length).toBe(2);
    expect(result.actions[0].id).toBe("restart");
    expect(result.actions[1].id).toBe("tests");
  });

  test("decomposition fails when precondition not met", () => {
    const network = new TaskNetwork();

    const guarded: CompositeTask = {
      id: "guarded",
      name: "Guarded Task",
      level: "domain",
      precondition: (s) => s.allowed === true,
      decompose: () => [],
    };
    network.addCompositeTask(guarded);

    const decomposer = new HTNDecomposer(network);
    const state = createState({ allowed: false });

    const result = decomposer.decompose("guarded", state);
    expect(result.success).toBe(false);
  });
});

describe("L0 → L1 fallback", () => {
  test("L1 planner is invoked when L0 rule matcher returns no match", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("fix", "fix-issue")
        .requireEquals("broken", true)
        .set({ broken: false, fixed: true })
        .cost(5)
        .build(),
    ]);

    const network = new TaskNetwork();
    network.addPrimitiveAction(graph.getAllActions()[0]);

    // L0 matcher that never matches
    const noMatchMatcher: L0RuleMatcher = {
      match: () => ({ matched: false, reason: "no matching rule" }),
    };

    const bridge = new L0L1Bridge(
      noMatchMatcher,
      [...graph.getAllActions()],
      [],
    );

    const state = createState({ broken: true });
    const goal = (s: PlannerState) => s.fixed === true;

    const result = bridge.resolve(state, goal);
    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan!.actions.length).toBe(1);
    expect(result.plan!.actions[0].id).toBe("fix");
  });

  test("L0 match is used directly when available", () => {
    const matchAction = action("l0-action", "L0 Match")
      .set({ resolved: true })
      .cost(1)
      .build();

    const alwaysMatchMatcher: L0RuleMatcher = {
      match: () => ({ matched: true, action: matchAction }),
    };

    const bridge = new L0L1Bridge(alwaysMatchMatcher, [], []);

    const state = createState({});
    const goal = (s: PlannerState) => s.resolved === true;

    const result = bridge.resolve(state, goal);
    expect(result.success).toBe(true);
    expect(result.plan!.actions[0].id).toBe("l0-action");
  });
});

describe("full planning pipeline", () => {
  test("end-to-end: define actions → plan → validate → execute", () => {
    const graph = new ActionGraph();
    graph.addActions([
      action("provision", "provision-server")
        .requireEquals("server", "none")
        .set({ server: "provisioned" })
        .cost(3)
        .build(),
      action("deploy", "deploy-app")
        .requireEquals("server", "provisioned")
        .set({ server: "deployed", app: "running" })
        .cost(2)
        .build(),
      action("verify", "verify-health")
        .requireEquals("app", "running")
        .set({ verified: true })
        .cost(1)
        .build(),
    ]);

    const initial = createState({
      server: "none",
      app: "none",
      verified: false,
    });
    const goal = (s: PlannerState) => s.verified === true;

    // Step 1: Plan
    const searchResult = aStarSearch(graph, initial, goal, zeroHeuristic);
    expect(searchResult.plan.isComplete).toBe(true);
    expect(searchResult.plan.actions.length).toBe(3);

    // Step 2: Validate
    const validation = validatePlan(searchResult.plan, initial, goal);
    expect(validation.valid).toBe(true);
    expect(validation.finalState.verified).toBe(true);

    // Step 3: Verify no side effects
    const sideEffects = validateNoSideEffects(searchResult.plan, initial);
    expect(sideEffects.preserved).toBe(true);
    expect(initial.server).toBe("none"); // Original state untouched
  });
});

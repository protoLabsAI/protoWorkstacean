import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionRegistry } from "../planner/action-registry.ts";
import { ExecutorRegistry } from "../executor/executor-registry.ts";
import { PlannerPluginL0 } from "./planner-plugin-l0.ts";
import { TOPICS } from "../event-bus/topics.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type { BusMessage } from "../../lib/types.ts";
import type { ActionDispatchPayload } from "../event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { Action } from "../planner/types/action.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../executor/types.ts";

const makeWorldState = (overrides: Partial<WorldState> = {}): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
  ...overrides,
});

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "test-action",
  name: "Test Action",
  description: "Test",
  goalId: "test-goal",
  tier: "tier_0",
  preconditions: [],
  effects: [],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

describe("PlannerPluginL0", () => {
  let bus: InMemoryEventBus;
  let registry: ActionRegistry;
  let planner: PlannerPluginL0;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ActionRegistry();
    planner = new PlannerPluginL0(registry, {
      loopDetector: { maxAttempts: 3, windowMinutes: 5 },
      oscillationCooldownMs: 1000,
    });
    planner.install(bus);
  });

  test("dispatches a matching action on world state update", () => {
    const action = makeAction({ preconditions: [] });
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg);
    });

    const worldState = makeWorldState();
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "corr-1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });

    expect(dispatched).toHaveLength(1);
    const payload = dispatched[0].payload as ActionDispatchPayload;
    expect(payload.actionId).toBe("test-action");
    expect(payload.goalId).toBe("test-goal");
    expect(payload.type).toBe("dispatch");
  });

  test("does not dispatch when preconditions fail", () => {
    const action = makeAction({
      preconditions: [{ path: "domains.board", operator: "exists" }],
    });
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg);
    });

    // No board domain in world state
    const worldState = makeWorldState({ domains: {} });
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "corr-1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });

    expect(dispatched).toHaveLength(0);
  });

  test("dispatches when preconditions pass", () => {
    const action = makeAction({
      preconditions: [{ path: "domains.board", operator: "exists" }],
    });
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg);
    });

    // Board domain exists
    const worldState = makeWorldState({
      domains: {
        board: {
          data: {
            projectSlug: "test",
            openIssues: 1,
            inProgress: 1,
            done: 0,
            issues: [],
            efficiency: 0.5,
            distribution: { feature: 1, defect: 0, risk: 0, debt: 0 },
          },
          metadata: {
            collectedAt: Date.now(),
            domain: "board",
            tickNumber: 1,
          },
        },
      },
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "corr-1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });

    expect(dispatched).toHaveLength(1);
  });

  test("escalates and applies cooldown after oscillation threshold", () => {
    const action = makeAction();
    registry.register(action);

    const escalated: BusMessage[] = [];
    const oscillations: BusMessage[] = [];
    bus.subscribe(TOPICS.PLANNER_ESCALATE, "test", (msg) => { escalated.push(msg); });
    bus.subscribe(TOPICS.WORLD_ACTION_OSCILLATION, "test", (msg) => { oscillations.push(msg); });

    // Record 3 failures to trigger oscillation
    const loopDetector = planner.getLoopDetector();
    loopDetector.record("test-goal", "test-action", false);
    loopDetector.record("test-goal", "test-action", false);
    loopDetector.record("test-goal", "test-action", false);

    // Evaluate — should detect oscillation
    planner.evaluate(makeWorldState(), "corr-1");

    expect(escalated).toHaveLength(1);
    expect(oscillations).toHaveLength(1);
    expect(planner.getCooldownManager().isOnCooldown("test-goal", "test-action")).toBe(true);
  });

  test("skips action that is on cooldown", () => {
    const action = makeAction();
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => { dispatched.push(msg); });

    // Set a cooldown on the action
    planner.getCooldownManager().setCooldown("test-goal", "test-action", 60_000);

    planner.evaluate(makeWorldState(), "corr-1");

    expect(dispatched).toHaveLength(0);
  });

  test("records outcome in loop detector on autonomous.outcome.#", () => {
    const action = makeAction();
    registry.register(action);

    // Simulate a failure outcome from a GOAP-originated skill dispatch
    const outcomePayload: AutonomousOutcomePayload = {
      correlationId: "corr-1",
      systemActor: "goap",
      skill: "test-action",
      actionId: "test-action",
      goalId: "test-goal",
      success: false,
      error: "Precondition failed at dispatch",
      taskState: "failed",
      durationMs: 5,
    };

    bus.publish("autonomous.outcome.goap.test-action", {
      id: "1",
      correlationId: "corr-1",
      topic: "autonomous.outcome.goap.test-action",
      timestamp: Date.now(),
      payload: outcomePayload,
    });

    const history = planner.getLoopDetector().getHistory("test-goal", "test-action");
    expect(history).toHaveLength(1);
    expect(history[0].succeeded).toBe(false);
  });

  test("dispatches only highest-priority matching action when multiple match", () => {
    registry.register(makeAction({ id: "low-prio", priority: 0, goalId: "g1" }));
    registry.register(makeAction({ id: "high-prio", priority: 10, goalId: "g2" }));

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    planner.evaluate(makeWorldState(), "corr-1");

    // Both should be dispatched (different goals)
    expect(dispatched).toHaveLength(2);
    // High priority should come first
    expect(dispatched[0].actionId).toBe("high-prio");
  });

  test("goal.violated: skips action when preconditions fail against cached world state", () => {
    const action = makeAction({
      goalId: "guarded-goal",
      id: "guarded-action",
      preconditions: [{ path: "extensions.domain_available", operator: "eq", value: true }],
    });
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => { dispatched.push(msg); });

    // Seed world state with domain_available = false
    const worldState = makeWorldState({ extensions: { domain_available: false } });
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "ws-1",
      correlationId: "corr-ws",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });

    // Clear dispatches from world state update (preconditions fail there too)
    dispatched.length = 0;

    // Fire goal violation
    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: { type: "world.goal.violated", violation: { goalId: "guarded-goal", description: "test", severity: "warn", timestamp: Date.now() } },
    });

    expect(dispatched).toHaveLength(0);
  });

  test("goal.violated: dispatches action when preconditions pass against cached world state", () => {
    const action = makeAction({
      goalId: "guarded-goal",
      id: "guarded-action",
      preconditions: [{ path: "extensions.domain_available", operator: "eq", value: true }],
    });
    registry.register(action);

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => { dispatched.push(msg); });

    // Seed world state with domain_available = true
    const worldState = makeWorldState({ extensions: { domain_available: true } });
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "ws-1",
      correlationId: "corr-ws",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });

    // Clear dispatches from world state update
    dispatched.length = 0;

    // Fire goal violation — goal is now in-flight from world state update, clear it
    planner["inFlightGoals"].clear();

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: { type: "world.goal.violated", violation: { goalId: "guarded-goal", description: "test", severity: "warn", timestamp: Date.now() } },
    });

    expect(dispatched).toHaveLength(1);
    const payload = dispatched[0].payload as ActionDispatchPayload;
    expect(payload.actionId).toBe("guarded-action");
  });

  test("uninstall removes subscriptions", () => {
    const action = makeAction();
    registry.register(action);

    planner.uninstall();

    const dispatched: BusMessage[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => { dispatched.push(msg); });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "corr-1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    expect(dispatched).toHaveLength(0);
  });
});

// Stub executor used for effect-registration tests
const stubExecutor: IExecutor = {
  type: "stub",
  execute: (_req: SkillRequest): Promise<SkillResult> =>
    Promise.resolve({ text: "", isError: false, correlationId: _req.correlationId }),
};

describe("PlannerPluginL0 — effect-based candidate selection", () => {
  let bus: InMemoryEventBus;
  let registry: ActionRegistry;
  let executorRegistry: ExecutorRegistry;
  let planner: PlannerPluginL0;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ActionRegistry();
    executorRegistry = new ExecutorRegistry();
    planner = new PlannerPluginL0(registry, {
      loopDetector: { maxAttempts: 3, windowMinutes: 5 },
      oscillationCooldownMs: 1000,
      executorRegistry,
    });
    planner.install(bus);
  });

  test("dispatches skill from ExecutorRegistry when violation has desiredEffect", () => {
    executorRegistry.register("fix_blocked_prs", stubExecutor);
    executorRegistry.registerEffect("fix_blocked_prs", undefined, [
      { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
    ]);

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: {
        type: "world.goal.violated",
        violation: {
          goalId: "ci-health",
          goalType: "Threshold",
          severity: "high",
          description: "Too many blocked PRs",
          message: "blockedPRs > 0",
          actual: 3,
          expected: 0,
          timestamp: Date.now(),
          desiredEffect: { domain: "ci", path: "data.blockedPRs", targetValue: 0 },
        },
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionId).toBe("effect::fix_blocked_prs::ci::data.blockedPRs");
    expect(dispatched[0].goalId).toBe("ci-health");
    expect(dispatched[0].action.meta.skillHint).toBe("fix_blocked_prs");
  });

  test("dispatches highest-confidence candidate first when multiple effects match", () => {
    executorRegistry.register("skill-a", stubExecutor);
    executorRegistry.register("skill-b", stubExecutor);
    executorRegistry.registerEffect("skill-a", undefined, [
      { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.5 },
    ]);
    executorRegistry.registerEffect("skill-b", undefined, [
      { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
    ]);

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: {
        type: "world.goal.violated",
        violation: {
          goalId: "ci-health",
          goalType: "Threshold",
          severity: "high",
          description: "Too many blocked PRs",
          message: "blockedPRs > 0",
          actual: 3,
          expected: 0,
          timestamp: Date.now(),
          desiredEffect: { domain: "ci", path: "data.blockedPRs", targetValue: 0 },
        },
      },
    });

    // Only one dispatch: inFlightGoals prevents the second candidate
    expect(dispatched).toHaveLength(1);
    // skill-b has higher confidence so it wins
    expect(dispatched[0].action.meta.skillHint).toBe("skill-b");
  });

  test("falls back to ActionRegistry when violation has no desiredEffect", () => {
    const action = makeAction({ goalId: "legacy-goal", id: "legacy-action" });
    registry.register(action);

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: {
        type: "world.goal.violated",
        violation: {
          goalId: "legacy-goal",
          goalType: "Invariant",
          severity: "medium",
          description: "Legacy violation",
          message: "something is wrong",
          actual: false,
          expected: true,
          timestamp: Date.now(),
          // no desiredEffect — should use ActionRegistry
        },
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionId).toBe("legacy-action");
  });

  test("dispatches nothing when desiredEffect has no matching effects in registry", () => {
    // No effects registered for this domain/path

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: {
        type: "world.goal.violated",
        violation: {
          goalId: "unknown-goal",
          goalType: "Threshold",
          severity: "low",
          description: "No handler",
          message: "no skill handles this",
          actual: 5,
          expected: 0,
          timestamp: Date.now(),
          desiredEffect: { domain: "unknown", path: "data.value", targetValue: 0 },
        },
      },
    });

    expect(dispatched).toHaveLength(0);
  });

  test("synthesized action carries agentName as agentId in meta", () => {
    executorRegistry.register("ava_fix", stubExecutor, { agentName: "ava" });
    executorRegistry.registerEffect("ava_fix", "ava", [
      { domain: "ci", path: "data.failedChecks", expectedDelta: -1, confidence: 0.85 },
    ]);

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish("world.goal.violated", {
      id: "gv-1",
      correlationId: "corr-gv",
      topic: "world.goal.violated",
      timestamp: Date.now(),
      payload: {
        type: "world.goal.violated",
        violation: {
          goalId: "ci-checks",
          goalType: "Threshold",
          severity: "high",
          description: "CI checks failing",
          message: "failedChecks > 0",
          actual: 2,
          expected: 0,
          timestamp: Date.now(),
          desiredEffect: { domain: "ci", path: "data.failedChecks", targetValue: 0 },
        },
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action.meta.agentId).toBe("ava");
    expect(dispatched[0].action.meta.skillHint).toBe("ava_fix");
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionRegistry } from "../planner/action-registry.ts";
import { PlannerPluginL0 } from "./planner-plugin-l0.ts";
import { TOPICS } from "../event-bus/topics.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type { BusMessage } from "../../lib/types.ts";
import type { ActionDispatchPayload, ActionOutcomePayload } from "../event-bus/action-events.ts";
import type { Action } from "../planner/types/action.ts";

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

  test("records outcome in loop detector on world.action.outcome", () => {
    const action = makeAction();
    registry.register(action);

    // Simulate a failure outcome
    const outcomePayload: ActionOutcomePayload = {
      type: "outcome",
      actionId: "test-action",
      goalId: "test-goal",
      correlationId: "corr-1",
      timestamp: Date.now(),
      success: false,
      error: "Precondition failed at dispatch",
      durationMs: 5,
    };

    bus.publish(TOPICS.WORLD_ACTION_OUTCOME, {
      id: "1",
      correlationId: "corr-1",
      topic: TOPICS.WORLD_ACTION_OUTCOME,
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

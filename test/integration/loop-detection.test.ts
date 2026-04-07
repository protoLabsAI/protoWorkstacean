/**
 * Integration test: loop detection triggering escalation.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionRegistry } from "../../src/planner/action-registry.ts";
import { PlannerPluginL0 } from "../../src/plugins/planner-plugin-l0.ts";
import { ActionDispatcherPlugin } from "../../src/plugins/action-dispatcher-plugin.ts";
import { TOPICS } from "../../src/event-bus/topics.ts";
import type {
  ActionOscillationPayload,
  PlannerEscalatePayload,
} from "../../src/event-bus/action-events.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type { Action } from "../../src/planner/types/action.ts";

const makeWorldState = (): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
});

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "loop-action",
  name: "Loop Test Action",
  description: "Used for loop detection tests",
  goalId: "loop-goal",
  tier: "tier_0",
  preconditions: [],
  effects: [],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

describe("Loop detection integration", () => {
  let bus: InMemoryEventBus;
  let registry: ActionRegistry;
  let planner: PlannerPluginL0;
  let dispatcher: ActionDispatcherPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ActionRegistry();
    planner = new PlannerPluginL0(registry, {
      loopDetector: { maxAttempts: 3, windowMinutes: 5 },
      oscillationCooldownMs: 500,
    });
    dispatcher = new ActionDispatcherPlugin({ wipLimit: 5 });
    dispatcher.install(bus);
    planner.install(bus);
  });

  test("N failures within window trigger oscillation event and escalation", () => {
    const action = makeAction();
    registry.register(action);

    const oscillations: ActionOscillationPayload[] = [];
    const escalations: PlannerEscalatePayload[] = [];

    bus.subscribe(TOPICS.WORLD_ACTION_OSCILLATION, "test", (msg) => {
      oscillations.push(msg.payload as ActionOscillationPayload);
    });
    bus.subscribe(TOPICS.PLANNER_ESCALATE, "test", (msg) => {
      escalations.push(msg.payload as PlannerEscalatePayload);
    });

    // Inject 3 failures directly into the loop detector
    const loopDetector = planner.getLoopDetector();
    loopDetector.record("loop-goal", "loop-action", false);
    loopDetector.record("loop-goal", "loop-action", false);
    loopDetector.record("loop-goal", "loop-action", false);

    // Now evaluate — should detect oscillation and NOT dispatch
    planner.evaluate(makeWorldState(), "test-corr");

    expect(oscillations).toHaveLength(1);
    expect(oscillations[0].goalId).toBe("loop-goal");
    expect(oscillations[0].actionId).toBe("loop-action");
    expect(oscillations[0].history.length).toBeGreaterThanOrEqual(3);

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalateTo).toBe("tier_1");
    expect(escalations[0].goalId).toBe("loop-goal");
  });

  test("cooldown is applied after oscillation — no dispatch during cooldown", () => {
    const action = makeAction();
    registry.register(action);

    const dispatched: unknown[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => dispatched.push(msg.payload));

    // Trigger oscillation
    const loopDetector = planner.getLoopDetector();
    loopDetector.record("loop-goal", "loop-action", false);
    loopDetector.record("loop-goal", "loop-action", false);
    loopDetector.record("loop-goal", "loop-action", false);
    planner.evaluate(makeWorldState(), "c1");

    // Should be on cooldown now
    expect(planner.getCooldownManager().isOnCooldown("loop-goal", "loop-action")).toBe(true);

    // Another evaluate — should NOT dispatch (on cooldown)
    planner.evaluate(makeWorldState(), "c2");
    expect(dispatched).toHaveLength(0);
  });

  test("below threshold does not escalate", () => {
    const action = makeAction();
    registry.register(action);

    const dispatched: unknown[] = [];
    const escalations: unknown[] = [];

    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => dispatched.push(msg.payload));
    bus.subscribe(TOPICS.PLANNER_ESCALATE, "test", (msg) => escalations.push(msg.payload));

    // Only 2 failures — below threshold of 3
    const loopDetector = planner.getLoopDetector();
    loopDetector.record("loop-goal", "loop-action", false);
    loopDetector.record("loop-goal", "loop-action", false);

    planner.evaluate(makeWorldState(), "c1");

    expect(escalations).toHaveLength(0);
    expect(dispatched).toHaveLength(1); // still dispatches
  });

  test("oscillation event contains full failure history", () => {
    const action = makeAction();
    registry.register(action);

    const oscillations: ActionOscillationPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_OSCILLATION, "test", (msg) => {
      oscillations.push(msg.payload as ActionOscillationPayload);
    });

    const loopDetector = planner.getLoopDetector();
    for (let i = 0; i < 4; i++) {
      loopDetector.record("loop-goal", "loop-action", false);
    }

    planner.evaluate(makeWorldState(), "c1");

    expect(oscillations).toHaveLength(1);
    expect(oscillations[0].history).toHaveLength(4);
    expect(oscillations[0].history.every((h) => !h.succeeded)).toBe(true);
  });
});

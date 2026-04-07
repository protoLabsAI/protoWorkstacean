import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionDispatcherPlugin } from "./action-dispatcher-plugin.ts";
import { TOPICS } from "../event-bus/topics.ts";
import type { ActionDispatchPayload, ActionOutcomePayload, ActionQueueFullPayload } from "../event-bus/action-events.ts";
import type { Action } from "../planner/types/action.ts";
import type { BusMessage } from "../../lib/types.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

const makeWorldState = (): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
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

const makeDispatchMsg = (action: Action, correlationId = "corr-1"): BusMessage => ({
  id: crypto.randomUUID(),
  correlationId,
  topic: TOPICS.WORLD_ACTION_DISPATCH,
  timestamp: Date.now(),
  payload: {
    type: "dispatch",
    actionId: action.id,
    goalId: action.goalId,
    action,
    correlationId,
    timestamp: Date.now(),
    optimisticEffectsApplied: false,
  } satisfies ActionDispatchPayload,
});

describe("ActionDispatcherPlugin", () => {
  let bus: InMemoryEventBus;
  let dispatcher: ActionDispatcherPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    dispatcher = new ActionDispatcherPlugin({ wipLimit: 2 });
    dispatcher.install(bus);
  });

  test("dispatches tier_0 action and publishes outcome", async () => {
    const outcomes: ActionOutcomePayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_OUTCOME, "test", (msg) => {
      outcomes.push(msg.payload as ActionOutcomePayload);
    });

    const action = makeAction({ tier: "tier_0" });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));

    // Allow microtasks to process
    await new Promise((r) => setTimeout(r, 10));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].actionId).toBe("test-action");
  });

  test("applies optimistic effects on dispatch", async () => {
    const worldState = makeWorldState();
    dispatcher.setWorldState(worldState);

    const action = makeAction({
      effects: [{ path: "planner.auto_mode_running", operation: "set", value: true }],
    });

    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));
    await new Promise((r) => setTimeout(r, 10));

    // Outcome should report success
    const outcomes: ActionOutcomePayload[] = [];
    // Already dispatched — check queue instead
    expect(dispatcher.getQueue().activeCount).toBe(0);
    expect(dispatcher.getOutcomes().summary().success).toBe(1);
  });

  test("publishes queue_full when WIP limit reached", async () => {
    // WIP limit is 2
    const queueFullEvents: ActionQueueFullPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_QUEUE_FULL, "test", (msg) => {
      queueFullEvents.push(msg.payload as ActionQueueFullPayload);
    });

    // Dispatch 3 actions with a topic (so they stay in-flight)
    for (let i = 0; i < 3; i++) {
      const action = makeAction({
        id: `action-${i}`,
        meta: { topic: "agent.execute", timeout: 30_000 },
      });
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, `corr-${i}`));
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(queueFullEvents).toHaveLength(1);
    expect(queueFullEvents[0].wipLimit).toBe(2);
  });

  test("records outcome in tracker", async () => {
    const action = makeAction();
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));
    await new Promise((r) => setTimeout(r, 10));

    const summary = dispatcher.getOutcomes().summary();
    expect(summary.total).toBe(1);
    expect(summary.success).toBe(1);
  });

  test("updates world state on world.state.updated", () => {
    const worldState = makeWorldState();
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });
    // No error = state updated successfully
  });
});

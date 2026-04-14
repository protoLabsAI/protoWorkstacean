import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { PlanningOrchestrator } from "./planning-orchestrator.ts";
import { TOPICS } from "../event-bus/topics.ts";
import type { ActionDispatchPayload } from "../event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type { Action } from "./types/action.ts";

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "test-action",
  name: "Test",
  description: "",
  goalId: "test-goal",
  tier: "tier_0",
  preconditions: [],
  effects: [],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

const makeWorldState = (): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
});

describe("PlanningOrchestrator", () => {
  let bus: InMemoryEventBus;
  let orchestrator: PlanningOrchestrator;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    orchestrator = new PlanningOrchestrator({
      dispatcher: { wipLimit: 5 },
    });
  });

  test("installs both plugins", () => {
    expect(orchestrator.isInstalled()).toBe(false);
    orchestrator.install(bus);
    expect(orchestrator.isInstalled()).toBe(true);
  });

  test("install is idempotent", () => {
    orchestrator.install(bus);
    orchestrator.install(bus); // should not throw
    expect(orchestrator.isInstalled()).toBe(true);
  });

  test("uninstall stops both plugins", () => {
    orchestrator.install(bus);
    orchestrator.uninstall();
    expect(orchestrator.isInstalled()).toBe(false);
  });

  test("registry is accessible", () => {
    const registry = orchestrator.getRegistry();
    expect(registry).toBeDefined();
    expect(registry.size).toBe(0);
  });

  test("dispatches action end-to-end after install", async () => {
    orchestrator.install(bus);

    const action = makeAction();
    orchestrator.getRegistry().register(action);

    const outcomes: AutonomousOutcomePayload[] = [];
    bus.subscribe("autonomous.outcome.goap.test-action", "test", (msg) => {
      outcomes.push(msg.payload as AutonomousOutcomePayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].goalId).toBe("test-goal");
  });

  test("does not dispatch after uninstall", async () => {
    orchestrator.install(bus);

    const action = makeAction();
    orchestrator.getRegistry().register(action);

    orchestrator.uninstall();

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toHaveLength(0);
  });
});

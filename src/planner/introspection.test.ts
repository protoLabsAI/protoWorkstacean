import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionRegistry } from "./action-registry.ts";
import { PlannerPluginL0 } from "../plugins/planner-plugin-l0.ts";
import { ActionDispatcherPlugin } from "../plugins/action-dispatcher-plugin.ts";
import { PlannerIntrospection } from "./introspection.ts";
import { DebugLogger } from "./debug-logger.ts";
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

describe("PlannerIntrospection", () => {
  let bus: InMemoryEventBus;
  let registry: ActionRegistry;
  let planner: PlannerPluginL0;
  let dispatcher: ActionDispatcherPlugin;
  let introspection: PlannerIntrospection;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ActionRegistry();
    planner = new PlannerPluginL0(registry);
    dispatcher = new ActionDispatcherPlugin({ wipLimit: 3 });
    planner.install(bus);
    dispatcher.install(bus);
    introspection = new PlannerIntrospection(registry, planner, dispatcher, bus);
  });

  test("getStatus returns empty registry info when no actions registered", () => {
    const status = introspection.getStatus();
    expect(status.registeredActions).toHaveLength(0);
    expect(status.outcomes.total).toBe(0);
    expect(status.loopStatus).toHaveLength(0);
  });

  test("getStatus includes registered actions", () => {
    registry.register(makeAction({ id: "a1", goalId: "g1", cost: 5 }));
    registry.register(makeAction({ id: "a2", goalId: "g2" }));

    const status = introspection.getStatus();
    expect(status.registeredActions).toHaveLength(2);

    const a1 = status.registeredActions.find((a) => a.id === "a1");
    expect(a1?.goalId).toBe("g1");
    expect(a1?.cost).toBe(5);
  });

  test("getStatus includes queue info", () => {
    const status = introspection.getStatus();
    expect(status.queue.activeCount).toBe(0);
    expect(status.queue.pendingCount).toBe(0);
  });

  test("getStatus reports loop detection status", () => {
    registry.register(makeAction());
    // Simulate failures
    planner.getLoopDetector().record("test-goal", "test-action", false);
    planner.getLoopDetector().record("test-goal", "test-action", false);

    const status = introspection.getStatus();
    const loopEntry = status.loopStatus.find((l) => l.key === "test-goal:test-action");
    expect(loopEntry?.recentFailureCount).toBe(2);
    expect(loopEntry?.isOscillating).toBe(false); // not yet at threshold (default 3)
  });

  test("getStatus reports oscillation when threshold reached", () => {
    registry.register(makeAction());
    planner.getLoopDetector().record("test-goal", "test-action", false);
    planner.getLoopDetector().record("test-goal", "test-action", false);
    planner.getLoopDetector().record("test-goal", "test-action", false);

    const status = introspection.getStatus();
    const loopEntry = status.loopStatus.find((l) => l.key === "test-goal:test-action");
    expect(loopEntry?.isOscillating).toBe(true);
  });

  test("getRecentOutcomes returns empty initially", () => {
    expect(introspection.getRecentOutcomes()).toHaveLength(0);
  });

  test("getPendingActions returns empty when queue is empty", () => {
    expect(introspection.getPendingActions()).toHaveLength(0);
  });
});

describe("DebugLogger", () => {
  test("captures log entries", () => {
    const logger = new DebugLogger("test-component");
    logger.info("test message", "corr-1");
    logger.warn("warning", "corr-2", { key: "value" });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toBe("test message");
    expect(entries[0].correlationId).toBe("corr-1");
    expect(entries[1].level).toBe("warn");
    expect(entries[1].data).toEqual({ key: "value" });
  });

  test("getEntriesAtLevel filters correctly", () => {
    const logger = new DebugLogger("test");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(logger.getEntriesAtLevel("warn")).toHaveLength(2);
    expect(logger.getEntriesAtLevel("error")).toHaveLength(1);
    expect(logger.getEntriesAtLevel("debug")).toHaveLength(4);
  });

  test("clear removes all entries", () => {
    const logger = new DebugLogger("test");
    logger.info("msg");
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  test("respects maxHistory limit", () => {
    const logger = new DebugLogger("test", 3);
    for (let i = 0; i < 5; i++) {
      logger.info(`msg ${i}`);
    }
    expect(logger.getEntries()).toHaveLength(3);
    // Should have the most recent entries
    expect(logger.getEntries()[2].message).toBe("msg 4");
  });
});

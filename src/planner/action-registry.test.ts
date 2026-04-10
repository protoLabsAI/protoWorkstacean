import { describe, test, expect, beforeEach } from "bun:test";
import { ActionRegistry, ActionRegistryError } from "./action-registry.ts";
import type { Action } from "./types/action.ts";

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "test-action",
  name: "Test Action",
  description: "A test action",
  goalId: "test-goal",
  tier: "tier_0",
  preconditions: [],
  effects: [],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

describe("ActionRegistry", () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  test("registers a valid action", () => {
    const action = makeAction();
    registry.register(action);
    expect(registry.get("test-action")).toEqual(action);
    expect(registry.size).toBe(1);
  });

  test("throws on duplicate registration", () => {
    registry.register(makeAction());
    expect(() => registry.register(makeAction())).toThrow(ActionRegistryError);
  });

  test("upsert replaces existing action", () => {
    registry.register(makeAction({ cost: 0 }));
    registry.upsert(makeAction({ cost: 5 }));
    expect(registry.get("test-action")?.cost).toBe(5);
  });

  test("unregister removes action", () => {
    registry.register(makeAction());
    registry.unregister("test-action");
    expect(registry.get("test-action")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test("getAll returns all actions", () => {
    registry.register(makeAction({ id: "a1" }));
    registry.register(makeAction({ id: "a2" }));
    expect(registry.getAll()).toHaveLength(2);
  });

  test("getByGoal filters correctly", () => {
    registry.register(makeAction({ id: "a1", goalId: "goal-1" }));
    registry.register(makeAction({ id: "a2", goalId: "goal-2" }));
    registry.register(makeAction({ id: "a3", goalId: "goal-1" }));
    expect(registry.getByGoal("goal-1")).toHaveLength(2);
    expect(registry.getByGoal("goal-2")).toHaveLength(1);
    expect(registry.getByGoal("goal-x")).toHaveLength(0);
  });

  test("getTier0 returns only tier_0 actions", () => {
    registry.register(makeAction({ id: "a0", tier: "tier_0" }));
    registry.register(makeAction({ id: "a1", tier: "tier_1" }));
    registry.register(makeAction({ id: "a2", tier: "tier_2" }));
    expect(registry.getTier0()).toHaveLength(1);
    expect(registry.getTier0()[0].id).toBe("a0");
  });

  test("totalCost sums costs for a goal", () => {
    registry.register(makeAction({ id: "a1", goalId: "g", cost: 3 }));
    registry.register(makeAction({ id: "a2", goalId: "g", cost: 7 }));
    expect(registry.totalCost("g")).toBe(10);
  });

  test("agentIds returns unique agent IDs", () => {
    registry.register(makeAction({ id: "a1", meta: { agentId: "ava" } }));
    registry.register(makeAction({ id: "a2", meta: { agentId: "quinn" } }));
    registry.register(makeAction({ id: "a3", meta: { agentId: "ava" } }));
    const ids = registry.agentIds().sort();
    expect(ids).toEqual(["ava", "quinn"]);
  });

  describe("validation", () => {
    test("throws on empty id", () => {
      expect(() => registry.register(makeAction({ id: "" }))).toThrow(ActionRegistryError);
    });

    test("throws on empty name", () => {
      expect(() => registry.register(makeAction({ name: "" }))).toThrow(ActionRegistryError);
    });

    test("throws on empty goalId", () => {
      expect(() => registry.register(makeAction({ goalId: "" }))).toThrow(ActionRegistryError);
    });

    test("throws on invalid tier", () => {
      expect(() =>
        registry.register(makeAction({ tier: "tier_99" as "tier_0" }))
      ).toThrow(ActionRegistryError);
    });

    test("throws on negative cost", () => {
      expect(() => registry.register(makeAction({ cost: -1 }))).toThrow(ActionRegistryError);
    });

    test("throws on invalid precondition operator", () => {
      expect(() =>
        registry.register(
          makeAction({
            preconditions: [{ path: "foo", operator: "bad" as "eq" }],
          })
        )
      ).toThrow(ActionRegistryError);
    });

    test("throws on empty precondition path", () => {
      expect(() =>
        registry.register(
          makeAction({
            preconditions: [{ path: "", operator: "exists" }],
          })
        )
      ).toThrow(ActionRegistryError);
    });

    test("throws on invalid effect operation", () => {
      expect(() =>
        registry.register(
          makeAction({
            effects: [{ path: "foo", operation: "bad" as "set" }],
          })
        )
      ).toThrow(ActionRegistryError);
    });

    test("accepts valid preconditions and effects", () => {
      const action = makeAction({
        preconditions: [
          { path: "domains.board.data.inProgress", operator: "gt", value: 0 },
          { path: "domains.services", operator: "exists" },
        ],
        effects: [
          { path: "planner.auto_mode_running", operation: "set", value: true },
        ],
      });
      expect(() => registry.register(action)).not.toThrow();
    });
  });
});

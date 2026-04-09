import { describe, test, expect } from "bun:test";
import { applyEffects } from "./state-updater.ts";
import { StateRollbackRegistry } from "./state-rollback.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

const makeWorldState = (extensions: Record<string, unknown> = {}): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions,
  snapshotVersion: 1,
});

describe("applyEffects", () => {
  test("returns original state when no effects", () => {
    const state = makeWorldState();
    const { updatedState, rollback } = applyEffects(state, []);
    expect(updatedState).toBe(state); // same reference since no effects
    expect(rollback()).toStrictEqual(state);
  });

  test("set operation adds a value", () => {
    const state = makeWorldState();
    const { updatedState } = applyEffects(state, [
      { path: "planner.auto_mode_running", operation: "set", value: true },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["auto_mode_running"]).toBe(true);
  });

  test("set operation does not mutate original", () => {
    const state = makeWorldState();
    applyEffects(state, [
      { path: "planner.auto_mode_running", operation: "set", value: true },
    ]);
    expect(state.extensions).toEqual({});
  });

  test("increment from zero", () => {
    const state = makeWorldState();
    const { updatedState } = applyEffects(state, [
      { path: "planner.dispatch_count", operation: "increment", value: 1 },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["dispatch_count"]).toBe(1);
  });

  test("increment existing value", () => {
    const state = makeWorldState({ planner: { dispatch_count: 5 } });
    const { updatedState } = applyEffects(state, [
      { path: "planner.dispatch_count", operation: "increment", value: 3 },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["dispatch_count"]).toBe(8);
  });

  test("decrement operation", () => {
    const state = makeWorldState({ planner: { pending: 3 } });
    const { updatedState } = applyEffects(state, [
      { path: "planner.pending", operation: "decrement", value: 1 },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["pending"]).toBe(2);
  });

  test("delete operation removes key", () => {
    const state = makeWorldState({ planner: { auto_mode_running: true } });
    const { updatedState } = applyEffects(state, [
      { path: "planner.auto_mode_running", operation: "delete" },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["auto_mode_running"]).toBeUndefined();
  });

  test("rollback restores original state", () => {
    const state = makeWorldState({ x: 1 });
    const { rollback } = applyEffects(state, [
      { path: "x", operation: "set", value: 99 },
    ]);
    const restored = rollback();
    expect(restored.extensions).toEqual({ x: 1 });
  });

  test("multiple effects applied in order", () => {
    const state = makeWorldState();
    const { updatedState } = applyEffects(state, [
      { path: "planner.count", operation: "set", value: 0 },
      { path: "planner.count", operation: "increment", value: 5 },
      { path: "planner.running", operation: "set", value: true },
    ]);
    const ext = updatedState.extensions as Record<string, Record<string, unknown>>;
    expect(ext["planner"]["count"]).toBe(5);
    expect(ext["planner"]["running"]).toBe(true);
  });
});

describe("StateRollbackRegistry", () => {
  test("registers and rolls back", () => {
    const registry = new StateRollbackRegistry();
    const original = makeWorldState({ x: 1 });
    registry.register("corr-1", "action-1", () => original);

    const restored = registry.rollback("corr-1");
    expect(restored).toBe(original);
    expect(registry.size).toBe(0);
  });

  test("rollback returns undefined for unknown correlationId", () => {
    const registry = new StateRollbackRegistry();
    expect(registry.rollback("unknown")).toBeUndefined();
  });

  test("commit removes entry", () => {
    const registry = new StateRollbackRegistry();
    registry.register("corr-1", "action-1", () => makeWorldState());
    registry.commit("corr-1");
    expect(registry.rollback("corr-1")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test("pending returns all uncommitted entries", () => {
    const registry = new StateRollbackRegistry();
    registry.register("corr-1", "action-1", () => makeWorldState());
    registry.register("corr-2", "action-2", () => makeWorldState());
    expect(registry.pending()).toHaveLength(2);
  });

  test("clearAll resets registry", () => {
    const registry = new StateRollbackRegistry();
    registry.register("corr-1", "action-1", () => makeWorldState());
    registry.clearAll();
    expect(registry.size).toBe(0);
  });
});

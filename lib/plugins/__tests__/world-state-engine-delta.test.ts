/**
 * Arc 5.3 tests — WorldStateEngine subscribes to world.state.delta and
 * applies agent-declared deltas in-process.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { WorldStateEngine } from "../world-state-engine.ts";
import type { BusMessage } from "../../types.ts";

/**
 * Seed the engine's internal state directly so tests don't depend on
 * poll timers firing. We access the internal worldState via a registered
 * domain's collector that completes synchronously, then trigger one manual
 * collect via the private tick path — but that's fragile, so we take an
 * escape hatch: `(engine as any).worldState` is the shared reference.
 */
function seedDomain(engine: WorldStateEngine, domain: string, data: Record<string, unknown>): void {
  const state = (engine as unknown as { worldState: {
    domains: Record<string, { data: Record<string, unknown>; metadata: Record<string, unknown> }>;
    extensions: Record<string, unknown>;
    timestamp: number;
  } }).worldState;
  state.domains[domain] = { data, metadata: { collectedAt: Date.now(), domain, tickNumber: 0 } };
  state.extensions[`${domain}_available`] = true;
}

describe("WorldStateEngine — world.state.delta (Arc 5.3)", () => {
  let bus: InMemoryEventBus;
  let engine: WorldStateEngine;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    engine = new WorldStateEngine({ snapshotIntervalMs: 60_000_000 });
    engine.install(bus);
    seedDomain(engine, "ci", { blockedPRs: 5, projects: ["a", "b"] });
  });

  afterEach(() => {
    engine.uninstall();
  });

  function publishDelta(deltas: unknown[]): void {
    bus.publish("world.state.delta", {
      id: crypto.randomUUID(),
      correlationId: "c1",
      topic: "world.state.delta",
      timestamp: Date.now(),
      payload: { deltas },
    });
  }

  function readCi(): Record<string, unknown> | undefined {
    return (engine.getWorldState({ domain: "ci" }) as { data?: Record<string, unknown> } | null)?.data;
  }

  test("applies 'set' op to a simple path", () => {
    publishDelta([{ domain: "ci", path: "data.blockedPRs", op: "set", value: 3 }]);
    expect(readCi()?.blockedPRs).toBe(3);
  });

  test("applies 'inc' op to an existing numeric (decrement via negative value)", () => {
    publishDelta([{ domain: "ci", path: "data.blockedPRs", op: "inc", value: -2 }]);
    expect(readCi()?.blockedPRs).toBe(3);
  });

  test("applies 'push' op to an existing array", () => {
    publishDelta([{ domain: "ci", path: "data.projects", op: "push", value: "c" }]);
    expect(readCi()?.projects).toEqual(["a", "b", "c"]);
  });

  test("publishes world.state.updated exactly when a delta is applied", () => {
    const updates: BusMessage[] = [];
    bus.subscribe("world.state.updated", "test", (msg) => { updates.push(msg); });

    publishDelta([{ domain: "ci", path: "data.blockedPRs", op: "set", value: 0 }]);
    expect(updates.length).toBe(1);
  });

  test("ignores delta targeting unknown domain — no mutation, no event", () => {
    const updates: BusMessage[] = [];
    bus.subscribe("world.state.updated", "test", (msg) => { updates.push(msg); });

    publishDelta([{ domain: "nonexistent", path: "data.foo", op: "set", value: 1 }]);
    expect(updates.length).toBe(0);
  });

  test("applies the valid sibling when one entry is malformed", () => {
    publishDelta([
      { domain: 5, path: "data.bad", op: "set", value: 0 },            // bad domain type
      { domain: "ci", path: "data.blockedPRs", op: "set", value: 7 },  // valid
      { domain: "ci", path: "data.blockedPRs", op: "fly", value: 0 },  // bad op
    ]);
    expect(readCi()?.blockedPRs).toBe(7);
  });

  test("ignores empty delta array — no event fired", () => {
    const updates: BusMessage[] = [];
    bus.subscribe("world.state.updated", "test", (msg) => { updates.push(msg); });

    publishDelta([]);
    expect(updates.length).toBe(0);
  });

  test("rejects 'inc' on non-numeric target without throwing", () => {
    publishDelta([{ domain: "ci", path: "data.projects", op: "inc", value: 1 }]);
    // projects is an array, inc should fail silently
    expect(readCi()?.projects).toEqual(["a", "b"]);
  });

  test("rejects 'push' on non-array target without throwing", () => {
    publishDelta([{ domain: "ci", path: "data.blockedPRs", op: "push", value: "x" }]);
    expect(readCi()?.blockedPRs).toBe(5);
  });
});

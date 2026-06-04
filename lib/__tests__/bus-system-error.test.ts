import { describe, expect, test } from "bun:test";
import { InMemoryEventBus } from "../bus.ts";
import type { BusMessage } from "../types";

const msg = (topic: string): BusMessage => ({ id: crypto.randomUUID(), correlationId: "c", topic, timestamp: 0, payload: {} });

describe("bus emits system.error when a handler throws (#800)", () => {
  test("a throwing subscriber → system.error event (siblings unaffected)", () => {
    const bus = new InMemoryEventBus();
    const errors: BusMessage[] = [];
    bus.subscribe("system.error", "test", (m) => { errors.push(m); });
    let siblingRan = false;
    bus.subscribe("topic.x", "boom-plugin", () => { throw new Error("kaboom"); });
    bus.subscribe("topic.x", "ok-plugin", () => { siblingRan = true; });

    bus.publish("topic.x", msg("topic.x"));

    expect(siblingRan).toBe(true); // sibling isolation preserved
    expect(errors).toHaveLength(1);
    const p = errors[0].payload as Record<string, unknown>;
    expect(p.source).toBe("bus-handler");
    expect(p.plugin).toBe("boom-plugin");
    expect(String(p.error)).toContain("kaboom");
  });

  test("a throw in the system.error handler itself does NOT loop", () => {
    const bus = new InMemoryEventBus();
    let calls = 0;
    bus.subscribe("system.error", "loopy", () => { calls++; throw new Error("in handler"); });
    bus.subscribe("topic.y", "boom", () => { throw new Error("orig"); });

    expect(() => bus.publish("topic.y", msg("topic.y"))).not.toThrow();
    // system.error fired once (from topic.y); its handler threw but did NOT
    // re-emit another system.error → no infinite loop.
    expect(calls).toBe(1);
  });
});

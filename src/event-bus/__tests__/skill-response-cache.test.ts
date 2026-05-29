import { describe, test, expect, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { SkillResponseCache, SkillResponseCachePlugin } from "../skill-response-cache.ts";
import type { AgentSkillResponsePayload } from "../payloads.ts";

function publishResponse(bus: InMemoryEventBus, correlationId: string, payload: Partial<AgentSkillResponsePayload>) {
  const topic = `agent.skill.response.${correlationId}`;
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId,
    topic,
    timestamp: Date.now(),
    payload: { correlationId, ...payload },
  });
}

describe("SkillResponseCache", () => {
  let plugin: SkillResponseCachePlugin | undefined;
  afterEach(() => { plugin?.uninstall(); plugin = undefined; });

  function install(bus: InMemoryEventBus, opts?: { ttlMs?: number; maxEntries?: number }) {
    const cache = new SkillResponseCache(opts);
    plugin = new SkillResponseCachePlugin(cache);
    plugin.install(bus);
    return cache;
  }

  test("captures dispatcher-inline-shaped terminal responses", async () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus);
    publishResponse(bus, "c1", { content: "in-process answer", taskState: "completed" });
    const got = cache.get("c1");
    expect(got?.content).toBe("in-process answer");
    expect(got?.taskState).toBe("completed");
  });

  test("captures TaskTracker-shaped terminal responses (same subscriber, both paths)", async () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus);
    publishResponse(bus, "c2", { content: "a2a answer", taskState: "completed", taskId: "t9", contextId: "ctx" });
    const got = cache.get("c2");
    expect(got?.content).toBe("a2a answer");
    expect(got?.taskId).toBe("t9");
  });

  test("preserves error payloads", async () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus);
    publishResponse(bus, "c3", { error: "boom", taskState: "failed" });
    expect(cache.get("c3")?.error).toBe("boom");
  });

  test("expires entries past the TTL", async () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus, { ttlMs: 10 });
    publishResponse(bus, "c4", { content: "ephemeral" });
    expect(cache.get("c4")?.content).toBe("ephemeral");
    await new Promise((r) => setTimeout(r, 25));
    expect(cache.get("c4")).toBeUndefined();
  });

  test("evicts the oldest entry past the size cap", async () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus, { maxEntries: 2 });
    publishResponse(bus, "a", { content: "1" });
    publishResponse(bus, "b", { content: "2" });
    publishResponse(bus, "c", { content: "3" }); // pushes "a" out
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.content).toBe("2");
    expect(cache.get("c")?.content).toBe("3");
  });

  test("returns undefined for an unseen correlationId", () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus);
    expect(cache.get("never")).toBeUndefined();
  });

  test("stops recording after uninstall", () => {
    const bus = new InMemoryEventBus();
    const cache = install(bus);
    plugin?.uninstall();
    plugin = undefined;
    publishResponse(bus, "c5", { content: "after teardown" });
    expect(cache.get("c5")).toBeUndefined();
  });
});

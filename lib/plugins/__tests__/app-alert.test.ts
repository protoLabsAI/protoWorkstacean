import { describe, expect, test } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { AppAlertPlugin } from "../app-alert.ts";

function emitError(bus: InMemoryEventBus, payload: Record<string, unknown>) {
  bus.publish("system.error", {
    id: crypto.randomUUID(), correlationId: "c", topic: "system.error", timestamp: 0, payload,
  });
}

describe("AppAlertPlugin", () => {
  test("posts a throttled message to the ops webhook per error-key", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      posts.push(JSON.parse(init!.body!).content);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    let t = 1000;
    const bus = new InMemoryEventBus();
    const plugin = new AppAlertPlugin({ webhookUrl: "https://ops", throttleMs: 60_000, now: () => t, fetchImpl });
    plugin.install(bus);

    emitError(bus, { source: "bus-handler", plugin: "discord", error: "boom" });
    emitError(bus, { source: "bus-handler", plugin: "discord", error: "boom again" }); // same key, throttled
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("discord");

    t += 61_000; // past throttle window
    emitError(bus, { source: "bus-handler", plugin: "discord", error: "later" });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(2);
    plugin.uninstall();
  });

  test("a failing webhook never throws back into the bus", async () => {
    const bus = new InMemoryEventBus();
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const plugin = new AppAlertPlugin({ webhookUrl: "https://ops", fetchImpl });
    plugin.install(bus);
    expect(() => emitError(bus, { source: "x", error: "y" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    plugin.uninstall();
  });

  test("no webhook configured → no post, no throw", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new AppAlertPlugin({ webhookUrl: undefined });
    plugin.install(bus);
    expect(() => emitError(bus, { source: "x", error: "y" })).not.toThrow();
    plugin.uninstall();
  });
});

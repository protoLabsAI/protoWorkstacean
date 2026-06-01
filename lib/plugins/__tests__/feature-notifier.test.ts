/**
 * FeatureNotifierPlugin turns protoMaker feature.completed/failed events into
 * a push to the project's dev channel, resolved via the injected
 * ChannelRegistry. (The old workspace-plugin version never loaded in the
 * container — it imported app internals from a bind-mount outside the module
 * tree; this is the first-party replacement.)
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { FeatureNotifierPlugin } from "../feature-notifier.ts";
import type { ChannelRegistry, Channel } from "../../channels/channel-registry.ts";
import type { BusMessage } from "../../types.ts";

/** Minimal ChannelRegistry stub — only getProjectChannel is exercised. */
function stubRegistry(map: Record<string, Partial<Channel>>): ChannelRegistry {
  return {
    getProjectChannel: (slug: string, kind: string) => map[`${slug}:${kind}`] as Channel | undefined,
  } as unknown as ChannelRegistry;
}

function publish(bus: InMemoryEventBus, topic: string, payload: Record<string, unknown>): void {
  bus.publish(topic, { id: "t", correlationId: "c", topic, timestamp: 0, payload });
}

describe("FeatureNotifierPlugin", () => {
  test("feature.completed → push to the project's dev channel with shipped copy", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureNotifierPlugin({
      channelRegistry: stubRegistry({ "protoworkstacean:dev": { channelId: "12345" } }),
    });
    plugin.install(bus);

    const pushed: BusMessage[] = [];
    bus.subscribe("message.outbound.discord.push.12345", "test", (m) => { pushed.push(m); });

    publish(bus, "feature.completed", { projectSlug: "protoworkstacean", featureTitle: "Streaming heartbeat", featureId: "WS-42" });

    expect(pushed.length).toBe(1);
    const p = pushed[0]!.payload as { content: string; channel: string };
    expect(p.channel).toBe("12345");
    expect(p.content).toContain("Feature shipped");
    expect(p.content).toContain("Streaming heartbeat");
  });

  test("feature.failed → ❌ copy with the error", () => {
    const bus = new InMemoryEventBus();
    new FeatureNotifierPlugin({ channelRegistry: stubRegistry({ "pm:dev": { channelId: "999" } }) }).install(bus);

    const pushed: BusMessage[] = [];
    bus.subscribe("message.outbound.discord.push.999", "test", (m) => { pushed.push(m); });

    publish(bus, "feature.failed", { projectSlug: "pm", featureTitle: "Board sync", error: "merge conflict" });

    expect(pushed.length).toBe(1);
    const content = (pushed[0]!.payload as { content: string }).content;
    expect(content).toContain("Feature failed");
    expect(content).toContain("merge conflict");
  });

  test("missing projectSlug or no channel binding → no push", () => {
    const bus = new InMemoryEventBus();
    new FeatureNotifierPlugin({ channelRegistry: stubRegistry({}) }).install(bus);

    const pushed: BusMessage[] = [];
    bus.subscribe("message.outbound.discord.push.#", "test", (m) => { pushed.push(m); });

    publish(bus, "feature.completed", { featureTitle: "no slug" });          // missing projectSlug
    publish(bus, "feature.completed", { projectSlug: "unbound", featureTitle: "x" }); // no binding
    expect(pushed.length).toBe(0);
  });

  test("no bot channelId but a webhook → falls back to webhook (no bus push)", () => {
    const bus = new InMemoryEventBus();
    new FeatureNotifierPlugin({
      channelRegistry: stubRegistry({ "orbis:dev": { webhook: "https://example.invalid/hook" } }),
    }).install(bus);

    const pushed: BusMessage[] = [];
    bus.subscribe("message.outbound.discord.push.#", "test", (m) => { pushed.push(m); });

    // Webhook path does a fetch() (which will fail to an invalid host, caught) —
    // the point is it does NOT publish a Discord push when there's no channelId.
    publish(bus, "feature.completed", { projectSlug: "orbis", featureTitle: "y" });
    expect(pushed.length).toBe(0);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { OperatorRoutingPlugin } from "../operator-routing.ts";
import type { OperatorMessageRequest } from "../operator-routing.ts";
import type { IdentityRegistry } from "../../identity/identity-registry.ts";

function stubRegistry(adminDiscordId: string | null): IdentityRegistry {
  return {
    adminIds: (platform: string) => (platform === "discord" && adminDiscordId ? [adminDiscordId] : []),
  } as unknown as IdentityRegistry;
}

describe("OperatorRoutingPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: OperatorRoutingPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(() => {
    plugin?.uninstall();
  });

  function publishReq(req: OperatorMessageRequest): void {
    bus.publish("operator.message.request", {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: "operator.message.request",
      timestamp: Date.now(),
      payload: req,
    });
  }

  test("routes to Discord DM for the admin user's Discord ID from users.yaml", async () => {
    plugin = new OperatorRoutingPlugin(stubRegistry("123456789"));
    plugin.install(bus);

    const received: Array<{ topic: string; payload: unknown }> = [];
    bus.subscribe("message.outbound.discord.dm.user.#", "test", msg => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    publishReq({
      type: "operator_message_request",
      correlationId: "c1",
      message: "test message",
      urgency: "normal",
      from: "ava",
    });

    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("message.outbound.discord.dm.user.123456789");
    const payload = received[0].payload as { content: string; agentId: string; urgency: string };
    expect(payload.content).toContain("test message");
    expect(payload.content).toContain("ava");
    expect(payload.agentId).toBe("ava");
    expect(payload.urgency).toBe("normal");
  });

  test("prepends urgency badge on high + urgent", async () => {
    plugin = new OperatorRoutingPlugin(stubRegistry("123"));
    plugin.install(bus);

    const received: Array<{ content: string }> = [];
    bus.subscribe("message.outbound.discord.dm.user.#", "test", msg => {
      received.push(msg.payload as { content: string });
    });

    publishReq({ type: "operator_message_request", correlationId: "c1", message: "x", urgency: "high", from: "ava" });
    publishReq({ type: "operator_message_request", correlationId: "c2", message: "x", urgency: "urgent", from: "ava" });
    publishReq({ type: "operator_message_request", correlationId: "c3", message: "x", urgency: "low", from: "ava" });

    await new Promise(r => setTimeout(r, 20));
    expect(received[0].content).toContain("⚠️");
    expect(received[1].content).toContain("🚨");
    expect(received[2].content).not.toContain("⚠️");
    expect(received[2].content).not.toContain("🚨");
  });

  test("prepends [topic] when topic is set", async () => {
    plugin = new OperatorRoutingPlugin(stubRegistry("123"));
    plugin.install(bus);

    const received: Array<{ content: string }> = [];
    bus.subscribe("message.outbound.discord.dm.user.#", "test", msg => {
      received.push(msg.payload as { content: string });
    });

    publishReq({
      type: "operator_message_request",
      correlationId: "c1",
      message: "delete the A records",
      urgency: "normal",
      topic: "todo",
      from: "ava",
    });

    await new Promise(r => setTimeout(r, 10));
    expect(received[0].content).toContain("**[todo]**");
    expect(received[0].content).toContain("delete the A records");
  });

  test("drops with warning when no admin user has a Discord ID mapped", async () => {
    plugin = new OperatorRoutingPlugin(stubRegistry(null));
    plugin.install(bus);

    const received: Array<{ topic: string }> = [];
    bus.subscribe("message.outbound.#", "test", msg => {
      received.push({ topic: msg.topic });
    });

    publishReq({
      type: "operator_message_request",
      correlationId: "c1",
      message: "test",
      urgency: "normal",
      from: "ava",
    });

    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});

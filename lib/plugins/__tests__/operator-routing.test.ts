import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { OperatorRoutingPlugin } from "../operator-routing.ts";
import type { OperatorMessageRequest } from "../operator-routing.ts";

describe("OperatorRoutingPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: OperatorRoutingPlugin;
  const originalEnv = process.env.OPERATOR_DISCORD_USER_ID;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new OperatorRoutingPlugin();
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    if (originalEnv !== undefined) process.env.OPERATOR_DISCORD_USER_ID = originalEnv;
    else delete process.env.OPERATOR_DISCORD_USER_ID;
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

  test("routes to Discord DM topic when OPERATOR_DISCORD_USER_ID is set", async () => {
    process.env.OPERATOR_DISCORD_USER_ID = "123456789";

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
    process.env.OPERATOR_DISCORD_USER_ID = "123";

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
    process.env.OPERATOR_DISCORD_USER_ID = "123";

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

  test("drops with warning when no channels are configured", async () => {
    delete process.env.OPERATOR_DISCORD_USER_ID;

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

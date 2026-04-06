import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../lib/bus";
import { EchoPlugin } from "../lib/plugins/echo";
import type { BusMessage } from "../lib/types";

describe("EchoPlugin", () => {
  let bus: InMemoryEventBus;
  let echo: EchoPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    echo = new EchoPlugin();
    echo.install(bus);
  });

  test("echo replies to inbound message", () => {
    let replyReceived: BusMessage | null = null;

    // Subscribe to outbound to capture the echo reply
    bus.subscribe("message.outbound.#", "test", (msg) => {
      replyReceived = msg;
    });

    // Publish an inbound message
    const inboundMsg: BusMessage = {
      id: "test-123",
      correlationId: "test-123",
      topic: "message.inbound.signal.+1234",
      timestamp: Date.now(),
      payload: { sender: "+1234", content: "hello" },
    };

    bus.publish(inboundMsg.topic, inboundMsg);

    expect(replyReceived).not.toBeNull();
    expect(replyReceived!.correlationId).toBe("test-123");
    expect(replyReceived!.topic).toBe("message.outbound.signal.+1234");
    expect((replyReceived!.payload as { content: string }).content).toBe("Echo: hello");
  });

  test("echo preserves correlation id", () => {
    let capturedCorrelationId: string | null = null;

    bus.subscribe("message.outbound.#", "test", (msg) => {
      capturedCorrelationId = msg.correlationId;
    });

    const inboundMsg: BusMessage = {
      id: "original-id",
      correlationId: "correlation-abc",
      topic: "message.inbound.signal.+5678",
      timestamp: Date.now(),
      payload: { sender: "+5678", content: "test" },
    };

    bus.publish(inboundMsg.topic, inboundMsg);

    expect(capturedCorrelationId).not.toBeNull();
    expect(capturedCorrelationId!).toBe("correlation-abc");
  });

  test("echo ignores messages without sender/content", () => {
    let called = false;

    bus.subscribe("message.outbound.#", "test", () => {
      called = true;
    });

    const inboundMsg: BusMessage = {
      id: "no-payload",
      correlationId: "no-payload",
      topic: "message.inbound.signal.+9999",
      timestamp: Date.now(),
      payload: {},
    };

    bus.publish(inboundMsg.topic, inboundMsg);

    expect(called).toBe(false);
  });
});
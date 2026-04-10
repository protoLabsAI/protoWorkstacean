import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../lib/bus";
import type { BusMessage } from "../lib/types";

describe("InMemoryEventBus", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  test("basic pub/sub", () => {
    let received: BusMessage | null = null;
    bus.subscribe("message.test", "test-plugin", (msg) => {
      received = msg;
    });

    const msg: BusMessage = {
      id: "123",
      correlationId: "123",
      topic: "message.test",
      timestamp: Date.now(),
      payload: { content: "hello" },
    };

    bus.publish("message.test", msg);
    expect(received).not.toBeNull();
    expect(received!.id).toBe(msg.id);
    expect(received!.topic).toBe(msg.topic);
    expect(received!.payload).toEqual(msg.payload);
  });

  test("wildcard # matches everything", () => {
    let count = 0;
    bus.subscribe("#", "logger", () => {
      count++;
    });

    bus.publish("message.inbound", {
      id: "1",
      correlationId: "1",
      topic: "message.inbound",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("command.test", {
      id: "2",
      correlationId: "2",
      topic: "command.test",
      timestamp: Date.now(),
      payload: {},
    });

    expect(count).toBe(2);
  });

  test("wildcard # matches nested topics", () => {
    const received: string[] = [];
    bus.subscribe("message.#", "agent", (msg) => {
      received.push(msg.topic);
    });

    bus.publish("message.inbound.signal.123", {
      id: "1",
      correlationId: "1",
      topic: "message.inbound.signal.123",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.outbound.signal.456", {
      id: "2",
      correlationId: "2",
      topic: "message.outbound.signal.456",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("command.test", {
      id: "3",
      correlationId: "3",
      topic: "command.test",
      timestamp: Date.now(),
      payload: {},
    });

    expect(received).toEqual([
      "message.inbound.signal.123",
      "message.outbound.signal.456",
    ]);
  });

  test("wildcard * matches single level", () => {
    const received: string[] = [];
    bus.subscribe("message.*.signal.123", "test", (msg) => {
      received.push(msg.topic);
    });

    bus.publish("message.inbound.signal.123", {
      id: "1",
      correlationId: "1",
      topic: "message.inbound.signal.123",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.outbound.signal.123", {
      id: "2",
      correlationId: "2",
      topic: "message.outbound.signal.123",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.foo.bar.signal.123", {
      id: "3",
      correlationId: "3",
      topic: "message.foo.bar.signal.123",
      timestamp: Date.now(),
      payload: {},
    });

    expect(received).toEqual([
      "message.inbound.signal.123",
      "message.outbound.signal.123",
    ]);
  });

  test("exact match works", () => {
    const received: string[] = [];
    bus.subscribe("message.outbound.signal.#", "signal", (msg) => {
      received.push(msg.topic);
    });

    bus.publish("message.outbound.signal.+1234", {
      id: "1",
      correlationId: "1",
      topic: "message.outbound.signal.+1234",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.outbound.signal.+5678", {
      id: "2",
      correlationId: "2",
      topic: "message.outbound.signal.+5678",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.inbound.signal.+1234", {
      id: "3",
      correlationId: "3",
      topic: "message.inbound.signal.+1234",
      timestamp: Date.now(),
      payload: {},
    });

    expect(received).toEqual([
      "message.outbound.signal.+1234",
      "message.outbound.signal.+5678",
    ]);
  });

  test("unsubscribe removes handler", () => {
    let count = 0;
    const id = bus.subscribe("message.test", "test", () => {
      count++;
    });

    bus.publish("message.test", {
      id: "1",
      correlationId: "1",
      topic: "message.test",
      timestamp: Date.now(),
      payload: {},
    });

    bus.unsubscribe(id);

    bus.publish("message.test", {
      id: "2",
      correlationId: "2",
      topic: "message.test",
      timestamp: Date.now(),
      payload: {},
    });

    expect(count).toBe(1);
  });

  test("topics() returns all subscribed patterns", () => {
    bus.subscribe("message.#", "agent", () => {});
    bus.subscribe("command.#", "cli", () => {});
    bus.subscribe("skill.#", "windmill", () => {});

    const topics = bus.topics();
    expect(topics.map(t => t.pattern)).toEqual([
      "command.#",
      "message.#",
      "skill.#",
    ]);
  });

  test("topics() tracks subscriber count", () => {
    bus.subscribe("message.#", "agent", () => {});
    bus.subscribe("message.#", "cli", () => {});

    const topics = bus.topics();
    const messageTopic = topics.find(t => t.pattern === "message.#");
    expect(messageTopic?.subscribers).toBe(2);
  });

  test("consumers() returns all consumers", () => {
    bus.subscribe("message.#", "agent", () => {});
    bus.subscribe("command.#", "cli", () => {});

    const consumers = bus.consumers();
    expect(consumers.length).toBe(2);
    expect(consumers.map(c => c.name).sort()).toEqual(["agent", "cli"]);
  });

  test("consumers() tracks subscriptions per consumer", () => {
    bus.subscribe("message.#", "agent", () => {});
    bus.subscribe("command.#", "agent", () => {});

    const consumers = bus.consumers();
    const agent = consumers.find(c => c.name === "agent");
    expect(agent?.subscriptions.sort()).toEqual(["command.#", "message.#"]);
  });

  test("multiple handlers for same pattern", () => {
    const results: string[] = [];
    bus.subscribe("message.test", "plugin1", () => {
      results.push("plugin1");
    });
    bus.subscribe("message.test", "plugin2", () => {
      results.push("plugin2");
    });

    bus.publish("message.test", {
      id: "1",
      correlationId: "1",
      topic: "message.test",
      timestamp: Date.now(),
      payload: {},
    });

    expect(results.sort()).toEqual(["plugin1", "plugin2"]);
  });

  test("handler error doesn't crash bus", () => {
    let called = false;
    bus.subscribe("message.test", "bad", () => {
      throw new Error("oops");
    });
    bus.subscribe("message.test", "good", () => {
      called = true;
    });

    bus.publish("message.test", {
      id: "1",
      correlationId: "1",
      topic: "message.test",
      timestamp: Date.now(),
      payload: {},
    });

    expect(called).toBe(true);
  });
});

describe("Topic matching edge cases", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  test("# only at end of pattern is invalid", () => {
    let called = false;
    bus.subscribe("#.message", "test", () => {
      called = true;
    });

    bus.publish("anything.message", {
      id: "1",
      correlationId: "1",
      topic: "anything.message",
      timestamp: Date.now(),
      payload: {},
    });

    expect(called).toBe(false);
  });

  test("single level topic matches exactly", () => {
    const received: string[] = [];
    bus.subscribe("message", "test", (msg) => {
      received.push(msg.topic);
    });

    bus.publish("message", {
      id: "1",
      correlationId: "1",
      topic: "message",
      timestamp: Date.now(),
      payload: {},
    });

    bus.publish("message.inbound", {
      id: "2",
      correlationId: "2",
      topic: "message.inbound",
      timestamp: Date.now(),
      payload: {},
    });

    expect(received).toEqual(["message"]);
  });

  test("# matches single level topic", () => {
    const received: string[] = [];
    bus.subscribe("#", "test", (msg) => {
      received.push(msg.topic);
    });

    bus.publish("message", {
      id: "1",
      correlationId: "1",
      topic: "message",
      timestamp: Date.now(),
      payload: {},
    });

    expect(received).toEqual(["message"]);
  });
});

describe("Integration: CLI → Signal flow", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  test("CLI publishes to signal outbound topic", () => {
    let signalReceived: BusMessage | null = null;

    // Signal plugin subscribes to outbound
    bus.subscribe("message.outbound.signal.#", "signal", (msg) => {
      signalReceived = msg;
    });

    // CLI publishes a message
    const msg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "message.outbound.signal.+1234",
      timestamp: Date.now(),
      payload: { content: "hello from CLI" },
    };

    bus.publish(msg.topic, msg);

    expect(signalReceived).not.toBeNull();
    expect(signalReceived!.id).toBe(msg.id);
    expect(signalReceived!.topic).toBe(msg.topic);
    expect(signalReceived!.payload).toEqual(msg.payload);
  });

  test("Signal inbound reaches agent subscriber", () => {
    let agentReceived: BusMessage | null = null;

    // Agent subscribes to inbound
    bus.subscribe("message.inbound.#", "agent", (msg) => {
      agentReceived = msg;
    });

    // Signal publishes inbound message
    const msg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "message.inbound.signal.+5678",
      timestamp: Date.now(),
      payload: { sender: "+5678", content: "hello" },
      source: { interface: "signal", userId: "+5678" },
      reply: { topic: "message.outbound.signal.+5678" },
    };

    bus.publish(msg.topic, msg);

    expect(agentReceived).not.toBeNull();
    expect(agentReceived!.id).toBe(msg.id);
    expect(agentReceived!.topic).toBe(msg.topic);
    expect(agentReceived!.payload).toEqual(msg.payload);
    expect(agentReceived!.reply).toEqual({ topic: "message.outbound.signal.+5678" });
  });
});
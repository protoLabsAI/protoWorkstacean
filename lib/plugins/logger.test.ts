import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { LoggerPlugin } from "./logger";
import type { BusMessage, LoggerTurnQueryRequest, LoggerTurnQueryResponse } from "../types";

const TEST_DATA_DIR = "/tmp/logger-test-" + process.pid;

function makeBus() {
  const subs: Array<{ pattern: string; handler: (msg: BusMessage) => void }> = [];
  return {
    subscribe(pattern: string, _name: string, handler: (msg: BusMessage) => void) {
      subs.push({ pattern, handler });
      return "sub-id";
    },
    unsubscribe() {},
    publish(topic: string, msg: BusMessage) {
      for (const sub of subs) {
        if (sub.pattern === "#" || sub.pattern === topic) {
          sub.handler(msg);
        }
      }
    },
    topics() { return []; },
    consumers() { return []; },
  };
}

function makeRequest(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    id: "req-1",
    correlationId: "corr-1",
    topic: "agent.skill.request",
    timestamp: Date.now(),
    payload: { skill: "chat", content: "Hello agent" },
    source: { interface: "discord", userId: "user-abc", channelId: "ch-1" },
    reply: { topic: "agent.skill.response.run-1" },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    id: "res-1",
    correlationId: "corr-1",
    topic: "agent.skill.response.run-1",
    timestamp: Date.now() + 100,
    payload: { content: "Hi there!", correlationId: "corr-1" },
    ...overrides,
  };
}

describe("LoggerPlugin.getRecentTurnsForUser", () => {
  let plugin: LoggerPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    plugin = new LoggerPlugin(TEST_DATA_DIR);
    bus = makeBus();
    plugin.install(bus as never);
  });

  afterEach(() => {
    plugin.uninstall();
    try { rmSync(TEST_DATA_DIR, { recursive: true }); } catch {}
  });

  test("returns empty array when no events exist", () => {
    const turns = plugin.getRecentTurnsForUser("user-abc", "", 10, 60_000);
    expect(turns).toEqual([]);
  });

  test("returns user and assistant turns for a matching request+response", () => {
    const req = makeRequest();
    const res = makeResponse();

    bus.publish(req.topic, req);
    bus.publish(res.topic, res);

    const turns = plugin.getRecentTurnsForUser("user-abc", "", 10, 60_000);

    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toBe("Hello agent");
    expect(turns[0].channelId).toBe("ch-1");
    expect(turns[0].timestamp).toBe(req.timestamp);

    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("Hi there!");
    expect(turns[1].channelId).toBe("ch-1");
  });

  test("returns only user turn when no response exists", () => {
    const req = makeRequest();
    bus.publish(req.topic, req);

    const turns = plugin.getRecentTurnsForUser("user-abc", "", 10, 60_000);

    expect(turns.length).toBe(1);
    expect(turns[0].role).toBe("user");
  });

  test("excludes events from other users", () => {
    bus.publish("agent.skill.request", makeRequest({ source: { interface: "discord", userId: "other-user" } }));

    const turns = plugin.getRecentTurnsForUser("user-abc", "", 10, 60_000);
    expect(turns).toEqual([]);
  });

  test("excludes events older than maxAgeMs", () => {
    const oldTimestamp = Date.now() - 120_000; // 2 min ago
    bus.publish("agent.skill.request", makeRequest({ timestamp: oldTimestamp }));

    const turns = plugin.getRecentTurnsForUser("user-abc", "", 10, 60_000); // 1 min window
    expect(turns).toEqual([]);
  });

  test("filters by agentName when targets are specified", () => {
    const reqTargeted = makeRequest({
      id: "req-targeted",
      correlationId: "corr-targeted",
      payload: { skill: "chat", content: "Hello protomaker", targets: ["protomaker"] },
    });
    const reqOther = makeRequest({
      id: "req-other",
      correlationId: "corr-other",
      payload: { skill: "chat", content: "Hello quinn", targets: ["quinn"] },
    });

    bus.publish(reqTargeted.topic, reqTargeted);
    bus.publish(reqOther.topic, reqOther);

    const turns = plugin.getRecentTurnsForUser("user-abc", "protomaker", 10, 60_000);

    expect(turns.length).toBe(1);
    expect(turns[0].text).toBe("Hello protomaker");
  });

  test("includes events with empty targets when agentName filter is set", () => {
    // Empty targets = any agent — should be included even when agentName filter is set
    const req = makeRequest({
      payload: { skill: "chat", content: "Hello", targets: [] },
    });
    bus.publish(req.topic, req);

    const turns = plugin.getRecentTurnsForUser("user-abc", "protomaker", 10, 60_000);
    expect(turns.length).toBe(1);
  });

  test("respects limit parameter", () => {
    // Insert 3 different correlationIds
    for (let i = 0; i < 3; i++) {
      bus.publish("agent.skill.request", makeRequest({
        id: `req-${i}`,
        correlationId: `corr-${i}`,
        timestamp: Date.now() + i,
        payload: { skill: "chat", content: `Message ${i}` },
      }));
    }

    const turns = plugin.getRecentTurnsForUser("user-abc", "", 2, 60_000);
    // 2 correlationIds * 1 user turn each = 2 turns
    expect(turns.length).toBe(2);
  });
});

describe("LoggerPlugin bus-based logger.turn.query capability", () => {
  let plugin: LoggerPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    plugin = new LoggerPlugin(TEST_DATA_DIR);
    bus = makeBus();
    plugin.install(bus as never);
  });

  afterEach(() => {
    plugin.uninstall();
    try { rmSync(TEST_DATA_DIR, { recursive: true }); } catch {}
  });

  test("responds to logger.turn.query with turns published to replyTopic", () => {
    const req = makeRequest();
    const res = makeResponse();
    bus.publish(req.topic, req);
    bus.publish(res.topic, res);

    let received: LoggerTurnQueryResponse | null = null;
    bus.subscribe("logger.turn.query.response.test", "test", (msg: BusMessage) => {
      received = msg.payload as LoggerTurnQueryResponse;
    });

    const queryRequest: LoggerTurnQueryRequest = {
      type: "logger.turn.query",
      userId: "user-abc",
      agentName: "",
      limit: 10,
      maxAgeMs: 60_000,
      replyTopic: "logger.turn.query.response.test",
    };

    bus.publish("logger.turn.query", {
      id: "q-1",
      correlationId: "corr-q-1",
      topic: "logger.turn.query",
      timestamp: Date.now(),
      payload: queryRequest,
    });

    expect(received).not.toBeNull();
    expect(received!.type).toBe("logger.turn.query.response");
    expect(received!.turns.length).toBe(2);
    expect(received!.turns[0].role).toBe("user");
    expect(received!.turns[0].text).toBe("Hello agent");
    expect(received!.turns[1].role).toBe("assistant");
    expect(received!.turns[1].text).toBe("Hi there!");
  });

  test("responds with empty turns when no matching events", () => {
    let received: LoggerTurnQueryResponse | null = null;
    bus.subscribe("logger.turn.query.response.empty", "test", (msg: BusMessage) => {
      received = msg.payload as LoggerTurnQueryResponse;
    });

    const queryRequest: LoggerTurnQueryRequest = {
      type: "logger.turn.query",
      userId: "nobody",
      agentName: "",
      limit: 10,
      maxAgeMs: 60_000,
      replyTopic: "logger.turn.query.response.empty",
    };

    bus.publish("logger.turn.query", {
      id: "q-2",
      correlationId: "corr-q-2",
      topic: "logger.turn.query",
      timestamp: Date.now(),
      payload: queryRequest,
    });

    expect(received).not.toBeNull();
    expect(received!.turns).toEqual([]);
  });
});

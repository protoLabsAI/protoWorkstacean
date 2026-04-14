import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { HITLPlugin } from "./hitl";
import type { BusMessage, HITLRequest, HITLResponse, HITLRenderer } from "../types";

function makeBus() {
  const subs = new Map<string, Array<(msg: BusMessage) => void>>();
  const published: BusMessage[] = [];
  return {
    subscribe(_pattern: string, _name: string, handler: (msg: BusMessage) => void) {
      const id = crypto.randomUUID();
      const existing = subs.get(_pattern) ?? [];
      existing.push(handler);
      subs.set(_pattern, existing);
      return id;
    },
    unsubscribe() {},
    publish(topic: string, msg: BusMessage) {
      published.push({ ...msg, topic });
      // Deliver to all subscribers whose pattern matches
      for (const [pattern, handlers] of subs) {
        if (topicMatches(pattern, topic)) {
          for (const h of handlers) h({ ...msg, topic });
        }
      }
    },
    topics() { return []; },
    consumers() { return []; },
    published,
  };
}

/** Minimal wildcard match: '#' matches any number of segments. */
function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern.endsWith(".#")) {
    const prefix = pattern.slice(0, -2);
    return topic.startsWith(prefix + ".") || topic === prefix;
  }
  return false;
}

function makeHITLRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    type: "hitl_request",
    correlationId: "corr-test",
    title: "Test request",
    summary: "A test HITL request",
    options: ["approve", "reject"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    replyTopic: "hitl.response.test.corr-test",
    sourceMeta: { interface: "discord", channelId: "ch-1" },
    ...overrides,
  };
}

function makeBusMessage(payload: unknown, topic: string): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: "corr-test",
    topic,
    timestamp: Date.now(),
    payload,
  };
}

describe("HITLPlugin — auto-approve (ttlMs: 0, onTimeout: 'approve')", () => {
  let plugin: HITLPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    plugin = new HITLPlugin("/tmp/test-workspace");
    bus = makeBus();
    plugin.install(bus as never);
  });

  afterEach(() => {
    plugin.uninstall();
  });

  test("publishes auto-approved HITLResponse immediately", () => {
    const req = makeHITLRequest({ ttlMs: 0, onTimeout: "approve" });
    bus.publish("hitl.request.corr-test", makeBusMessage(req, "hitl.request.corr-test"));

    const autoResponse = bus.published.find(
      m => m.topic === req.replyTopic,
    );
    expect(autoResponse).toBeDefined();
    const resp = autoResponse!.payload as HITLResponse;
    expect(resp.type).toBe("hitl_response");
    expect(resp.decision).toBe("approve");
    expect(resp.decidedBy).toBe("auto-approve");
    expect(resp.correlationId).toBe(req.correlationId);
  });

  test("does not add auto-approve request to pendingRequests", () => {
    const req = makeHITLRequest({ ttlMs: 0, onTimeout: "approve" });
    bus.publish("hitl.request.corr-test", makeBusMessage(req, "hitl.request.corr-test"));

    expect(plugin.getPendingRequests()).toHaveLength(0);
  });

  test("calls renderer.render() for notification display", async () => {
    const renders: HITLRequest[] = [];

    const renderer: HITLRenderer = {
      render: async (r) => {
        renders.push(r);
      },
    };
    plugin.registerRenderer("discord", renderer);

    const req = makeHITLRequest({ ttlMs: 0, onTimeout: "approve" });
    bus.publish("hitl.request.corr-test", makeBusMessage(req, "hitl.request.corr-test"));

    // render is async — give it a tick
    await Promise.resolve();

    expect(renders).toHaveLength(1);
    expect(renders[0]?.correlationId).toBe(req.correlationId);
  });

  test("normal request (no ttlMs) still goes to pendingRequests", () => {
    const req = makeHITLRequest();
    bus.publish("hitl.request.corr-test", makeBusMessage(req, "hitl.request.corr-test"));

    const pending = plugin.getPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.correlationId).toBe(req.correlationId);
  });

  test("request with onTimeout: 'approve' but non-zero ttlMs goes to pendingRequests", () => {
    const req = makeHITLRequest({ ttlMs: 5000, onTimeout: "approve" });
    bus.publish("hitl.request.corr-test", makeBusMessage(req, "hitl.request.corr-test"));

    expect(plugin.getPendingRequests()).toHaveLength(1);
  });
});

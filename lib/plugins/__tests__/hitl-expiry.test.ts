/**
 * Arc 7.2 tests — HITL TTL policies drive auto-approve / auto-reject / escalate
 * on expiry. Tests the sweepExpired hook directly with a controlled `now`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { HITLPlugin } from "../hitl.ts";
import type { HITLRequest, HITLResponse, BusMessage } from "../../types.ts";

function makeRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    type: "hitl_request",
    correlationId: "test-1",
    title: "Approve?",
    summary: "test",
    options: ["approve", "reject"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    replyTopic: "hitl.response.test-1",
    sourceMeta: { interface: "discord" },
    ...overrides,
  };
}

function publishRequest(bus: InMemoryEventBus, req: HITLRequest): void {
  bus.publish(`hitl.request.${req.correlationId}`, {
    id: crypto.randomUUID(),
    correlationId: req.correlationId,
    topic: `hitl.request.${req.correlationId}`,
    timestamp: Date.now(),
    payload: req,
  });
}

describe("HITLPlugin — TTL sweep (Arc 7.2)", () => {
  let bus: InMemoryEventBus;
  let plugin: HITLPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new HITLPlugin("/tmp");
    plugin.resetForTesting();
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    plugin.resetForTesting();
  });

  test("onTimeout='approve' publishes synthetic approve HITLResponse on expiry", async () => {
    const responses: HITLResponse[] = [];
    bus.subscribe("hitl.response.timeout-approve", "test", (msg: BusMessage) => {
      responses.push(msg.payload as HITLResponse);
    });

    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const req = makeRequest({
      correlationId: "timeout-approve",
      onTimeout: "approve",
      expiresAt: pastExpiry,
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    plugin.sweepExpired(bus, Date.now());
    expect(responses).toHaveLength(1);
    expect(responses[0].decision).toBe("approve");
    expect(responses[0].decidedBy).toBe("auto-approve");
    expect(responses[0].correlationId).toBe("timeout-approve");
  });

  test("onTimeout='reject' publishes synthetic reject HITLResponse on expiry", async () => {
    const responses: HITLResponse[] = [];
    bus.subscribe("hitl.response.timeout-reject", "test", (msg: BusMessage) => {
      responses.push(msg.payload as HITLResponse);
    });

    const req = makeRequest({
      correlationId: "timeout-reject",
      onTimeout: "reject",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    plugin.sweepExpired(bus, Date.now());
    expect(responses).toHaveLength(1);
    expect(responses[0].decision).toBe("reject");
    expect(responses[0].decidedBy).toBe("auto-reject");
  });

  test("onTimeout='escalate' fires hitl.expired.* instead of auto-response", async () => {
    const responses: HITLResponse[] = [];
    const expired: BusMessage[] = [];
    bus.subscribe("hitl.response.timeout-escalate", "test", (msg: BusMessage) => {
      responses.push(msg.payload as HITLResponse);
    });
    bus.subscribe("hitl.expired.timeout-escalate", "test", (msg: BusMessage) => {
      expired.push(msg);
    });

    const req = makeRequest({
      correlationId: "timeout-escalate",
      onTimeout: "escalate",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    plugin.sweepExpired(bus, Date.now());
    expect(responses).toHaveLength(0);
    expect(expired).toHaveLength(1);
  });

  test("unset onTimeout falls through to escalate behavior", async () => {
    const expired: BusMessage[] = [];
    bus.subscribe("hitl.expired.default-escalate", "test", (msg: BusMessage) => {
      expired.push(msg);
    });

    const req = makeRequest({
      correlationId: "default-escalate",
      // onTimeout omitted
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    plugin.sweepExpired(bus, Date.now());
    expect(expired).toHaveLength(1);
  });

  test("unexpired requests are left alone", async () => {
    const responses: HITLResponse[] = [];
    const expired: BusMessage[] = [];
    bus.subscribe("hitl.response.still-alive", "test", (msg: BusMessage) => {
      responses.push(msg.payload as HITLResponse);
    });
    bus.subscribe("hitl.expired.still-alive", "test", (msg: BusMessage) => {
      expired.push(msg);
    });

    const req = makeRequest({
      correlationId: "still-alive",
      onTimeout: "approve",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    plugin.sweepExpired(bus, Date.now());
    expect(responses).toHaveLength(0);
    expect(expired).toHaveLength(0);
    expect(plugin.getPendingRequests()).toHaveLength(1);
  });

  test("sweep removes expired request from pending list", async () => {
    const req = makeRequest({
      correlationId: "cleanup",
      onTimeout: "approve",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));
    expect(plugin.getPendingRequests()).toHaveLength(1);

    plugin.sweepExpired(bus, Date.now());
    expect(plugin.getPendingRequests()).toHaveLength(0);
  });

  test("sweep with nowMs in the past does NOT expire anything", async () => {
    const req = makeRequest({
      correlationId: "past-sweep",
      onTimeout: "approve",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    publishRequest(bus, req);
    await new Promise(r => setTimeout(r, 5));

    // Sweep at an earlier moment — before expiresAt
    plugin.sweepExpired(bus, Date.now() - 10_000);
    expect(plugin.getPendingRequests()).toHaveLength(1);
  });
});

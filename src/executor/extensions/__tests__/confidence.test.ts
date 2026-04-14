/**
 * Tests for the confidence-v1 extension interceptor.
 */

import { describe, test, expect } from "bun:test";
import type { EventBus, BusMessage } from "../../../../lib/types.ts";
import { CONFIDENCE_URI, type ActionConfidencePayload } from "../confidence.ts";

/** Minimal in-memory EventBus for testing. */
function makeBus(): EventBus & { published: Array<{ topic: string; msg: BusMessage }> } {
  const published: Array<{ topic: string; msg: BusMessage }> = [];
  return {
    published,
    publish(topic: string, msg: BusMessage) {
      published.push({ topic, msg });
    },
    subscribe(_pattern: string, _name: string, _handler: (m: BusMessage) => void): string {
      return crypto.randomUUID();
    },
    unsubscribe(_id: string) {},
    topics() { return []; },
    consumers() { return []; },
  };
}

/** Mirror the interceptor logic for isolated unit testing. */
function makeAfterHook(bus: ReturnType<typeof makeBus>) {
  return (
    ctx: { agentName: string; skill: string; correlationId: string; metadata: Record<string, unknown> },
    result: { text: string; data?: Record<string, unknown> },
  ) => {
    const conf = result.data?.["x-confidence"] as
      | { confidence?: number; explanation?: string }
      | undefined;
    if (!conf || typeof conf.confidence !== "number") return;
    const confidence = Math.max(0, Math.min(1, conf.confidence));
    const topic = "world.action.confidence";
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: ctx.correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        correlationId: ctx.correlationId,
        agentName: ctx.agentName,
        skill: ctx.skill,
        confidence,
        explanation: conf.explanation,
      } satisfies ActionConfidencePayload,
    });
  };
}

describe("confidence-v1 extension", () => {
  test("CONFIDENCE_URI is correct", () => {
    expect(CONFIDENCE_URI).toBe("https://protolabs.ai/a2a/ext/confidence-v1");
  });

  test("after hook publishes world.action.confidence when confidence data is present", () => {
    const bus = makeBus();
    const after = makeAfterHook(bus);

    after(
      { agentName: "test-agent", skill: "summarize", correlationId: "corr-123", metadata: {} },
      { text: "done", data: { "x-confidence": { confidence: 0.72, explanation: "mostly sure" } } },
    );

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].topic).toBe("world.action.confidence");
    const payload = bus.published[0].msg.payload as ActionConfidencePayload;
    expect(payload.confidence).toBe(0.72);
    expect(payload.explanation).toBe("mostly sure");
    expect(payload.correlationId).toBe("corr-123");
    expect(payload.agentName).toBe("test-agent");
    expect(payload.skill).toBe("summarize");
  });

  test("after hook clamps confidence to [0, 1]", () => {
    const bus = makeBus();
    const after = makeAfterHook(bus);
    const ctx = { agentName: "a", skill: "s", correlationId: "c", metadata: {} };

    after(ctx, { text: "", data: { "x-confidence": { confidence: 1.5 } } });
    expect((bus.published[0].msg.payload as ActionConfidencePayload).confidence).toBe(1.0);

    after(ctx, { text: "", data: { "x-confidence": { confidence: -0.2 } } });
    expect((bus.published[1].msg.payload as ActionConfidencePayload).confidence).toBe(0.0);
  });

  test("after hook emits nothing when confidence data is absent", () => {
    const bus = makeBus();
    const after = makeAfterHook(bus);
    const ctx = { agentName: "a", skill: "s", correlationId: "c", metadata: {} };

    after(ctx, { text: "", data: {} });
    after(ctx, { text: "" }); // no data at all
    after(ctx, { text: "", data: { "x-confidence": { explanation: "oops" } } }); // no confidence number

    expect(bus.published).toHaveLength(0);
  });
});

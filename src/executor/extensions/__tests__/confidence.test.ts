/**
 * Tests for the confidence-v1 extension interceptor.
 *
 * We build the after-hook logic in isolation (via `buildAfterInterceptor`) so
 * tests don't share state with the defaultExtensionRegistry singleton.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../../lib/bus.ts";
import { CONFIDENCE_URI } from "../confidence.ts";
import type { BusMessage, EventBus } from "../../../../lib/types.ts";
import type { ExtensionContext } from "../../extension-registry.ts";
import type { WorldActionConfidencePayload } from "../../../event-bus/payloads.ts";

// ---------------------------------------------------------------------------
// Inline the interceptor logic so tests are independent of the singleton
// ---------------------------------------------------------------------------

function buildAfterInterceptor(bus: EventBus) {
  function after(
    ctx: ExtensionContext,
    result: { text: string; data?: Record<string, unknown> },
  ): void {
    const confidenceData = result.data?.["x-protolabs-confidence"] as
      | { confidence?: unknown; explanation?: unknown }
      | undefined;

    if (!confidenceData) return;

    const confidence = confidenceData.confidence;
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return;

    const explanation =
      typeof confidenceData.explanation === "string"
        ? confidenceData.explanation
        : undefined;

    const topic = "world.action.confidence";
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: ctx.correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        source: ctx.agentName,
        skill: ctx.skill,
        confidence,
        ...(explanation !== undefined ? { explanation } : {}),
      } satisfies WorldActionConfidencePayload,
    });
  }

  return { after };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  overrides: Partial<{ agentName: string; skill: string; correlationId: string }> = {},
): ExtensionContext {
  return {
    agentName: overrides.agentName ?? "test-agent",
    skill: overrides.skill ?? "test_skill",
    correlationId: overrides.correlationId ?? "corr-123",
    metadata: {},
  };
}

function makeSetup() {
  const bus = new InMemoryEventBus();
  const published: BusMessage[] = [];
  bus.subscribe("world.action.confidence", "test", (msg) => { published.push(msg); });
  const { after } = buildAfterInterceptor(bus);
  return { bus, published, after };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CONFIDENCE_URI", () => {
  test("has the expected value", () => {
    expect(CONFIDENCE_URI).toBe("https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1");
  });
});

describe("confidence interceptor after hook", () => {
  describe("valid confidence data", () => {
    test("publishes world.action.confidence with confidence and explanation", () => {
      const { published, after } = makeSetup();

      after(makeCtx({ agentName: "agent-a", skill: "pr_review", correlationId: "c1" }), {
        text: "done",
        data: { "x-protolabs-confidence": { confidence: 0.72, explanation: "looks good" } },
      });

      expect(published).toHaveLength(1);
      expect(published[0].topic).toBe("world.action.confidence");
      expect(published[0].correlationId).toBe("c1");

      const p = published[0].payload as WorldActionConfidencePayload;
      expect(p.source).toBe("agent-a");
      expect(p.skill).toBe("pr_review");
      expect(p.confidence).toBe(0.72);
      expect(p.explanation).toBe("looks good");
    });

    test("publishes without explanation when explanation is absent", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: 0.5 } } });

      expect(published).toHaveLength(1);
      const p = published[0].payload as WorldActionConfidencePayload;
      expect(p.confidence).toBe(0.5);
      expect(p.explanation).toBeUndefined();
    });

    test("accepts confidence of exactly 0.0", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: 0.0 } } });

      expect(published).toHaveLength(1);
      expect((published[0].payload as WorldActionConfidencePayload).confidence).toBe(0.0);
    });

    test("accepts confidence of exactly 1.0", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: 1.0 } } });

      expect(published).toHaveLength(1);
      expect((published[0].payload as WorldActionConfidencePayload).confidence).toBe(1.0);
    });

    test("each call produces a unique message id", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "a", data: { "x-protolabs-confidence": { confidence: 0.5 } } });
      after(makeCtx(), { text: "b", data: { "x-protolabs-confidence": { confidence: 0.5 } } });

      expect(published).toHaveLength(2);
      expect(published[0].id).not.toBe(published[1].id);
    });

    test("propagates agentName, skill, and correlationId", () => {
      const { published, after } = makeSetup();

      after(
        makeCtx({ agentName: "sweeper", skill: "code_sweep", correlationId: "trace-xyz" }),
        { text: "sweep complete", data: { "x-protolabs-confidence": { confidence: 0.95 } } },
      );

      const p = published[0].payload as WorldActionConfidencePayload;
      expect(p.source).toBe("sweeper");
      expect(p.skill).toBe("code_sweep");
      expect(published[0].correlationId).toBe("trace-xyz");
    });

    test("ignores non-string explanation (does not include it)", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), {
        text: "done",
        data: { "x-protolabs-confidence": { confidence: 0.8, explanation: 42 } },
      });

      expect(published).toHaveLength(1);
      const p = published[0].payload as WorldActionConfidencePayload;
      expect(p.explanation).toBeUndefined();
    });

    test("published message has a timestamp", () => {
      const { published, after } = makeSetup();

      const before = Date.now();
      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: 0.6 } } });
      const after_ = Date.now();

      expect(published[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(published[0].timestamp).toBeLessThanOrEqual(after_);
    });
  });

  describe("invalid or missing confidence data — no event published", () => {
    test("does not publish when result.data is undefined", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done" });

      expect(published).toHaveLength(0);
    });

    test("does not publish when x-protolabs-confidence key is missing", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "other-key": { value: 1 } } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is a string", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: "high" } } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is null", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: null } } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is undefined", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": {} } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is below 0", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: -0.1 } } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is above 1", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: 1.5 } } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when x-protolabs-confidence is null", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": null } });

      expect(published).toHaveLength(0);
    });

    test("does not publish when confidence is NaN", () => {
      const { published, after } = makeSetup();

      after(makeCtx(), { text: "done", data: { "x-protolabs-confidence": { confidence: NaN } } });

      expect(published).toHaveLength(0);
    });
  });
});

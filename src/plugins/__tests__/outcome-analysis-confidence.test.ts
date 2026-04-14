/**
 * Tests for OutcomeAnalysisPlugin confidence-weighted failure tracking.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { EventBus, BusMessage } from "../../../lib/types.ts";
import { OutcomeAnalysisPlugin } from "../outcome-analysis-plugin.ts";

function makeBus(): EventBus & {
  handlers: Map<string, Array<(m: BusMessage) => void>>;
  emit(topic: string, payload: unknown): void;
} {
  const handlers = new Map<string, Array<(m: BusMessage) => void>>();
  return {
    handlers,
    emit(topic: string, payload: unknown) {
      const msg: BusMessage = {
        id: crypto.randomUUID(),
        correlationId: typeof (payload as Record<string, unknown>)?.correlationId === "string"
          ? (payload as Record<string, unknown>).correlationId as string
          : crypto.randomUUID(),
        topic,
        timestamp: Date.now(),
        payload,
      };
      for (const [pattern, cbs] of handlers.entries()) {
        if (topic === pattern || topic.startsWith(pattern.replace("*", ""))) {
          for (const cb of cbs) cb(msg);
        }
      }
    },
    publish(_topic: string, _msg: BusMessage) {},
    subscribe(pattern: string, _name: string, handler: (m: BusMessage) => void): string {
      if (!handlers.has(pattern)) handlers.set(pattern, []);
      handlers.get(pattern)!.push(handler);
      return crypto.randomUUID();
    },
    unsubscribe(_id: string) {},
    topics() { return []; },
    consumers() { return []; },
  };
}

describe("OutcomeAnalysisPlugin — confidence weighting", () => {
  let bus: ReturnType<typeof makeBus>;
  let plugin: OutcomeAnalysisPlugin;

  beforeEach(() => {
    bus = makeBus();
    plugin = new OutcomeAnalysisPlugin();
    plugin.install(bus);
  });

  test("failure with no confidence counts as weight 1.0", () => {
    bus.emit("world.action.outcome", {
      type: "outcome",
      actionId: "act-1",
      goalId: "g",
      correlationId: "corr-no-conf",
      timestamp: Date.now(),
      success: false,
      durationMs: 100,
    });

    const stats = plugin.getActionStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].weightedFailure).toBe(1.0);
    expect(stats[0].failure).toBe(1);
  });

  test("high-confidence failure has weight = confidence", () => {
    const correlationId = "corr-high";
    // Publish confidence first, then outcome.
    bus.emit("world.action.confidence", {
      source: "agent",
      skill: "act",
      correlationId,
      confidence: 0.9,
    });
    bus.emit("world.action.outcome", {
      type: "outcome",
      actionId: "act-1",
      goalId: "g",
      correlationId,
      timestamp: Date.now(),
      success: false,
      durationMs: 100,
    });

    const stats = plugin.getActionStats();
    expect(stats[0].weightedFailure).toBeCloseTo(0.9);
    expect(stats[0].failure).toBe(1);
  });

  test("low-confidence failure has lower weight than high-confidence failure", () => {
    // High-confidence failure
    const corrHigh = "corr-hc";
    bus.emit("world.action.confidence", { correlationId: corrHigh, confidence: 0.9 });
    bus.emit("world.action.outcome", {
      actionId: "act-a",
      goalId: "g",
      correlationId: corrHigh,
      success: false,
      durationMs: 10,
    });

    // Low-confidence failure
    const corrLow = "corr-lc";
    bus.emit("world.action.confidence", { correlationId: corrLow, confidence: 0.2 });
    bus.emit("world.action.outcome", {
      actionId: "act-b",
      goalId: "g",
      correlationId: corrLow,
      success: false,
      durationMs: 10,
    });

    const statsA = plugin.getActionStats().find(s => s.actionId === "act-a")!;
    const statsB = plugin.getActionStats().find(s => s.actionId === "act-b")!;
    expect(statsA.weightedFailure).toBeGreaterThan(statsB.weightedFailure);
  });

  test("success outcomes are not affected by confidence weighting", () => {
    const corrId = "corr-ok";
    bus.emit("world.action.confidence", { correlationId: corrId, confidence: 0.5 });
    bus.emit("world.action.outcome", {
      actionId: "act-ok",
      goalId: "g",
      correlationId: corrId,
      success: true,
      durationMs: 50,
    });

    const stats = plugin.getActionStats().find(s => s.actionId === "act-ok")!;
    expect(stats.success).toBe(1);
    expect(stats.weightedFailure).toBe(0);
    expect(stats.weightedSuccessRate).toBe(1.0);
  });

  test("confidence score is consumed once — does not carry over to next outcome", () => {
    const corrId = "corr-once";
    bus.emit("world.action.confidence", { correlationId: corrId, confidence: 0.8 });

    // First outcome uses confidence 0.8.
    bus.emit("world.action.outcome", {
      actionId: "act-1",
      goalId: "g",
      correlationId: corrId,
      success: false,
      durationMs: 10,
    });

    // Second outcome with SAME correlationId — confidence already consumed, defaults to 1.0.
    bus.emit("world.action.outcome", {
      actionId: "act-1",
      goalId: "g",
      correlationId: corrId,
      success: false,
      durationMs: 10,
    });

    const stats = plugin.getActionStats().find(s => s.actionId === "act-1")!;
    // First failure = 0.8, second failure = 1.0 (default).
    expect(stats.weightedFailure).toBeCloseTo(1.8);
  });

  test("weightedSuccessRate is lower than successRate when failures are high-confidence", () => {
    const corrId = "corr-hc2";
    // 1 success, 1 high-confidence failure
    bus.emit("world.action.outcome", {
      actionId: "act-x",
      goalId: "g",
      correlationId: "corr-success",
      success: true,
      durationMs: 10,
    });
    bus.emit("world.action.confidence", { correlationId: corrId, confidence: 0.95 });
    bus.emit("world.action.outcome", {
      actionId: "act-x",
      goalId: "g",
      correlationId: corrId,
      success: false,
      durationMs: 10,
    });

    const stats = plugin.getActionStats().find(s => s.actionId === "act-x")!;
    // Raw: 1/2 = 0.5
    expect(stats.successRate).toBeCloseTo(0.5);
    // Weighted: 1 / (1 + 0.95) ≈ 0.513 — slightly above 0.5
    // Actually 1/(1+0.95+0) = 1/1.95 ≈ 0.513
    expect(stats.weightedSuccessRate).toBeCloseTo(1 / (1 + 0.95));
  });
});

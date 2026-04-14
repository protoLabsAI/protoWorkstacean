/**
 * Confidence-weighting tests for OutcomeAnalysisPlugin.
 *
 * Verifies that world.action.confidence events from the confidence-v1
 * extension are used to weight failure signals when evaluating action
 * quality alerts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { OutcomeAnalysisPlugin } from "../outcome-analysis-plugin.ts";
import type { BusMessage } from "../../../lib/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcomeMsg(overrides: {
  actionId: string;
  success: boolean;
  error?: string;
  correlationId?: string;
}): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: overrides.correlationId ?? crypto.randomUUID(),
    topic: "world.action.outcome",
    timestamp: Date.now(),
    payload: {
      actionId: overrides.actionId,
      success: overrides.success,
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    },
  };
}

function makeConfidenceMsg(overrides: {
  confidence: number;
  correlationId: string;
  source?: string;
  skill?: string;
  explanation?: string;
}): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: overrides.correlationId,
    topic: "world.action.confidence",
    timestamp: Date.now(),
    payload: {
      source: overrides.source ?? "agent",
      skill: overrides.skill ?? "test_skill",
      confidence: overrides.confidence,
      ...(overrides.explanation !== undefined ? { explanation: overrides.explanation } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let bus: InMemoryEventBus;
let plugin: OutcomeAnalysisPlugin;

beforeEach(() => {
  bus = new InMemoryEventBus();
  plugin = new OutcomeAnalysisPlugin();
  plugin.install(bus);
});

afterEach(() => {
  plugin.uninstall();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutcomeAnalysisPlugin — confidence weighting", () => {
  describe("weightedFailure accumulation", () => {
    test("failure without confidence contributes 1.0 to weightedFailure", () => {
      const correlationId = crypto.randomUUID();
      bus.publish("world.action.outcome", makeOutcomeMsg({
        actionId: "act-1",
        success: false,
        correlationId,
      }));

      const stats = plugin.getActionStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].weightedFailure).toBe(1.0);
    });

    test("failure with confidence 0.9 contributes 0.9 to weightedFailure", () => {
      const correlationId = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.9, correlationId }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBeCloseTo(0.9);
    });

    test("failure with confidence 0.2 contributes 0.2 to weightedFailure", () => {
      const correlationId = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.2, correlationId }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBeCloseTo(0.2);
    });

    test("successes do not contribute to weightedFailure", () => {
      const correlationId = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.95, correlationId }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: true, correlationId }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBe(0);
    });

    test("timeouts do not contribute to weightedFailure", () => {
      const correlationId = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.8, correlationId }));
      bus.publish("world.action.outcome", makeOutcomeMsg({
        actionId: "act-1",
        success: false,
        error: "operation timeout exceeded",
        correlationId,
      }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBe(0);
      expect(stats[0].timeout).toBe(1);
    });

    test("multiple failures accumulate weighted values correctly", () => {
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const c3 = crypto.randomUUID();

      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.9, correlationId: c1 }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: c1 }));

      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.4, correlationId: c2 }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: c2 }));

      // No confidence for this one — defaults to 1.0
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: c3 }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBeCloseTo(0.9 + 0.4 + 1.0);
    });

    test("confidence event is consumed once and not reused for subsequent outcomes", () => {
      const correlationId = crypto.randomUUID();
      const otherId = crypto.randomUUID();

      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.6, correlationId }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId }));

      // Second failure for same action but different correlationId — should default to 1.0
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: otherId }));

      const stats = plugin.getActionStats();
      expect(stats[0].weightedFailure).toBeCloseTo(0.6 + 1.0);
    });
  });

  describe("adjustedRate calculation", () => {
    test("adjustedRate equals successRate when no confidence is attached", () => {
      // 5 successes, 5 failures (no confidence) → both rates = 0.5
      for (let i = 0; i < 5; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: true }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false }));
      }

      const [s] = plugin.getActionStats();
      expect(s.successRate).toBeCloseTo(0.5);
      expect(s.adjustedRate).toBeCloseTo(0.5);
    });

    test("high-confidence failures lower adjustedRate more than raw successRate", () => {
      // 5 successes, 5 high-confidence failures
      for (let i = 0; i < 5; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: true }));
      }
      for (let i = 0; i < 5; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.9, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: c }));
      }

      const [s] = plugin.getActionStats();
      // successRate = 5/10 = 0.5
      // adjustedRate = 5 / (5 + 5*0.9 + 0) = 5 / 9.5 ≈ 0.526
      expect(s.successRate).toBeCloseTo(0.5);
      expect(s.adjustedRate).toBeCloseTo(5 / (5 + 4.5));
    });

    test("low-confidence failures raise adjustedRate compared to all-or-nothing", () => {
      // 5 successes, 5 low-confidence failures
      for (let i = 0; i < 5; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: true }));
      }
      for (let i = 0; i < 5; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.2, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false, correlationId: c }));
      }

      const [s] = plugin.getActionStats();
      // successRate = 5/10 = 0.5
      // adjustedRate = 5 / (5 + 5*0.2 + 0) = 5 / 6.0 ≈ 0.833
      expect(s.successRate).toBeCloseTo(0.5);
      expect(s.adjustedRate).toBeCloseTo(5 / (5 + 1.0));
    });

    test("adjustedRate is 0 when all outcomes are failures", () => {
      for (let i = 0; i < 3; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-1", success: false }));
      }

      const [s] = plugin.getActionStats();
      expect(s.adjustedRate).toBe(0);
    });

    test("adjustedRate is 0 when stats are empty", () => {
      // getActionStats on empty plugin returns []
      expect(plugin.getActionStats()).toHaveLength(0);
    });
  });

  describe("alert threshold uses adjustedRate", () => {
    test("does not alert when adjustedRate is above threshold despite successRate below it", () => {
      // 10 successes, 10 very low-confidence failures
      // successRate = 0.5 (would trigger naive alert)
      // adjustedRate = 10/(10+10*0.05) = 10/10.5 ≈ 0.95 (should NOT alert)
      for (let i = 0; i < 10; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-low-conf", success: true }));
      }
      for (let i = 0; i < 10; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.05, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-low-conf", success: false, correlationId: c }));
      }

      const alerts: BusMessage[] = [];
      bus.subscribe("ops.alert.action_quality", "test", (msg) => { alerts.push(msg); });

      // Trigger analysis directly
      (plugin as unknown as { _runAnalysis(): void })._runAnalysis();

      expect(alerts).toHaveLength(0);
    });

    test("alerts when adjustedRate is below threshold with high-confidence failures", () => {
      // 3 successes, 10 high-confidence failures
      // adjustedRate = 3/(3+10*1.0+0) = 3/13 ≈ 0.23 → should alert
      for (let i = 0; i < 3; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-hi-conf", success: true }));
      }
      for (let i = 0; i < 10; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 1.0, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-hi-conf", success: false, correlationId: c }));
      }

      const alerts: BusMessage[] = [];
      bus.subscribe("ops.alert.action_quality", "test", (msg) => { alerts.push(msg); });

      (plugin as unknown as { _runAnalysis(): void })._runAnalysis();

      expect(alerts).toHaveLength(1);
      const p = alerts[0].payload as Record<string, unknown>;
      expect(p.actionId).toBe("act-hi-conf");
    });

    test("alert payload includes weightedFailure", () => {
      for (let i = 0; i < 3; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-wf", success: true }));
      }
      for (let i = 0; i < 10; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.8, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-wf", success: false, correlationId: c }));
      }

      const alerts: BusMessage[] = [];
      bus.subscribe("ops.alert.action_quality", "test", (msg) => { alerts.push(msg); });

      (plugin as unknown as { _runAnalysis(): void })._runAnalysis();

      expect(alerts).toHaveLength(1);
      const p = alerts[0].payload as Record<string, unknown>;
      expect(typeof p.weightedFailure).toBe("number");
      expect(p.weightedFailure as number).toBeCloseTo(8.0);
    });
  });

  describe("getActionStats sorting", () => {
    test("sorts by adjustedRate ascending (worst first)", () => {
      // act-bad: 2 success, 10 high-confidence failures → low adjustedRate
      for (let i = 0; i < 2; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-bad", success: true }));
      }
      for (let i = 0; i < 10; i++) {
        const c = crypto.randomUUID();
        bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.9, correlationId: c }));
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-bad", success: false, correlationId: c }));
      }

      // act-good: 9 success, 1 low-confidence failure → high adjustedRate
      for (let i = 0; i < 9; i++) {
        bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-good", success: true }));
      }
      const c = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.1, correlationId: c }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-good", success: false, correlationId: c }));

      const stats = plugin.getActionStats();
      expect(stats[0].actionId).toBe("act-bad");
      expect(stats[1].actionId).toBe("act-good");
      expect(stats[0].adjustedRate).toBeLessThan(stats[1].adjustedRate);
    });
  });

  describe("mixed outcomes with confidence", () => {
    test("tracks success, failure, timeout, and weightedFailure independently", () => {
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-mixed", success: true }));

      const c1 = crypto.randomUUID();
      bus.publish("world.action.confidence", makeConfidenceMsg({ confidence: 0.7, correlationId: c1 }));
      bus.publish("world.action.outcome", makeOutcomeMsg({ actionId: "act-mixed", success: false, correlationId: c1 }));

      bus.publish("world.action.outcome", makeOutcomeMsg({
        actionId: "act-mixed",
        success: false,
        error: "timeout exceeded",
      }));

      const [s] = plugin.getActionStats();
      expect(s.success).toBe(1);
      expect(s.failure).toBe(1);
      expect(s.timeout).toBe(1);
      expect(s.total).toBe(3);
      expect(s.weightedFailure).toBeCloseTo(0.7);
    });
  });
});

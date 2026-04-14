import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import {
  ConfidenceStore,
  registerConfidenceExtension,
  CONFIDENCE_URI,
} from "../extensions/confidence.ts";
import { defaultExtensionRegistry } from "../extension-registry.ts";
import type { ExtensionContext } from "../extension-registry.ts";

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    agentName: "quinn",
    skill: "pr_review",
    correlationId: "corr-1",
    metadata: { systemActor: "goap" },
    ...overrides,
  };
}

describe("ConfidenceStore", () => {
  test("records samples and averages correctly", () => {
    const s = new ConfidenceStore();
    for (const [conf, ok] of [[0.9, true], [0.6, true], [0.3, false]] as const) {
      s.record({
        systemActor: "goap", agentName: "quinn", skill: "pr_review",
        confidence: conf, success: ok, completedAt: Date.now(), correlationId: "c",
      });
    }
    const sum = s.summary("quinn", "pr_review");
    expect(sum?.sampleCount).toBe(3);
    expect(sum?.avgConfidence).toBeCloseTo(0.6, 2);
    expect(sum?.avgConfidenceOnSuccess).toBeCloseTo(0.75, 2);
    expect(sum?.avgConfidenceOnFailure).toBeCloseTo(0.3, 2);
  });

  test("flags high-confidence failures as calibration warnings", () => {
    const s = new ConfidenceStore();
    // High confidence + failure = bad calibration
    s.record({
      systemActor: "goap", agentName: "quinn", skill: "pr_review",
      confidence: 0.95, success: false, completedAt: Date.now(), correlationId: "c1",
    });
    s.record({
      systemActor: "goap", agentName: "quinn", skill: "pr_review",
      confidence: 0.4, success: false, completedAt: Date.now(), correlationId: "c2",
    });
    const sum = s.summary("quinn", "pr_review");
    expect(sum?.highConfFailures).toBe(1); // only the 0.95 one crosses the 0.8 threshold
  });

  test("respects maxPerKey cap (FIFO)", () => {
    const s = new ConfidenceStore(3);
    for (let i = 0; i < 5; i++) {
      s.record({
        systemActor: "goap", agentName: "a", skill: "s",
        confidence: i * 0.25, success: true, completedAt: 0, correlationId: `c${i}`,
      });
    }
    const sum = s.summary("a", "s");
    expect(sum?.sampleCount).toBe(3);
    // Retained i=2,3,4 → confidences 0.5, 0.75, 1.0 → avg 0.75
    expect(sum?.avgConfidence).toBeCloseTo(0.75, 2);
  });

  test("allSummaries enumerates every (agent, skill) key", () => {
    const s = new ConfidenceStore();
    s.record({ systemActor: "goap", agentName: "quinn", skill: "a", confidence: 1, success: true, completedAt: 0, correlationId: "c" });
    s.record({ systemActor: "goap", agentName: "frank", skill: "b", confidence: 0.5, success: true, completedAt: 0, correlationId: "c" });
    expect(s.allSummaries().length).toBe(2);
  });

  test("summary undefined for unseen key", () => {
    expect(new ConfidenceStore().summary("none", "none")).toBeUndefined();
  });
});

describe("confidence-v1 extension interceptor", () => {
  let bus: InMemoryEventBus;
  let store: ConfidenceStore;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    store = new ConfidenceStore();
    registerConfidenceExtension(bus, store);
  });

  test("registered on defaultExtensionRegistry", () => {
    const uris = defaultExtensionRegistry.list().map(e => e.uri);
    expect(uris).toContain(CONFIDENCE_URI);
  });

  test("after() records confidence + publishes event", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === CONFIDENCE_URI)?.interceptor;
    const events: unknown[] = [];
    bus.subscribe("autonomous.confidence.#", "test", (msg) => { events.push(msg); });

    interceptor!.after?.(makeCtx(), {
      text: "review complete",
      data: { confidence: 0.82, confidenceExplanation: "high coverage, low ambiguity", success: true },
    });

    expect(store.size).toBe(1);
    const sum = store.summary("quinn", "pr_review");
    expect(sum?.avgConfidence).toBeCloseTo(0.82, 2);
    expect(events).toHaveLength(1);
  });

  test("clamps out-of-range confidence to [0, 1]", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === CONFIDENCE_URI)?.interceptor;
    interceptor!.after?.(makeCtx(), { text: "", data: { confidence: 1.5, success: true } });
    interceptor!.after?.(makeCtx({ correlationId: "c2" }), { text: "", data: { confidence: -0.2, success: true } });
    const sum = store.summary("quinn", "pr_review");
    expect(sum?.sampleCount).toBe(2);
    // 1.5 clamped to 1, -0.2 clamped to 0 → avg 0.5
    expect(sum?.avgConfidence).toBeCloseTo(0.5, 2);
  });

  test("no record when confidence is missing", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === CONFIDENCE_URI)?.interceptor;
    interceptor!.after?.(makeCtx(), { text: "", data: { success: true } });
    expect(store.size).toBe(0);
  });

  test("before() stamps x-confidence-skill on metadata", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === CONFIDENCE_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-confidence-skill"]).toBe("pr_review");
  });
});

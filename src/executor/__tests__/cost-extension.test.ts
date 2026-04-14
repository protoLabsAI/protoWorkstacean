import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import {
  CostStore,
  registerCostExtension,
  COST_URI,
  defaultCostStore,
} from "../extensions/cost.ts";
import {
  defaultExtensionRegistry,
} from "../extension-registry.ts";
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

describe("CostStore", () => {
  test("records samples and keys by (agent, skill)", () => {
    const s = new CostStore();
    s.record({
      systemActor: "goap",
      agentName: "quinn",
      skill: "pr_review",
      tokensIn: 1000,
      tokensOut: 2000,
      wallMs: 5000,
      success: true,
      completedAt: Date.now(),
      correlationId: "c1",
    });
    const summary = s.summary("quinn", "pr_review");
    expect(summary?.sampleCount).toBe(1);
    expect(summary?.avgTokensIn).toBe(1000);
    expect(summary?.avgTokensOut).toBe(2000);
    expect(summary?.avgWallMs).toBe(5000);
    expect(summary?.successRate).toBe(1);
  });

  test("averages multiple samples", () => {
    const s = new CostStore();
    for (const [inT, outT, ms, ok] of [[1000, 2000, 5000, true], [2000, 4000, 7000, false]] as const) {
      s.record({
        systemActor: "goap", agentName: "quinn", skill: "pr_review",
        tokensIn: inT, tokensOut: outT, wallMs: ms,
        success: ok, completedAt: Date.now(), correlationId: "c",
      });
    }
    const summary = s.summary("quinn", "pr_review");
    expect(summary?.sampleCount).toBe(2);
    expect(summary?.avgTokensIn).toBe(1500);
    expect(summary?.avgTokensOut).toBe(3000);
    expect(summary?.avgWallMs).toBe(6000);
    expect(summary?.successRate).toBe(0.5);
  });

  test("respects maxPerKey cap (FIFO eviction)", () => {
    const s = new CostStore(3);
    for (let i = 0; i < 5; i++) {
      s.record({
        systemActor: "goap", agentName: "a", skill: "s",
        tokensIn: i, tokensOut: 0, wallMs: 0,
        success: true, completedAt: Date.now(), correlationId: `c${i}`,
      });
    }
    const sum = s.summary("a", "s");
    expect(sum?.sampleCount).toBe(3);
    // Retained samples should be i=2,3,4 → avg 3
    expect(sum?.avgTokensIn).toBe(3);
  });

  test("allSummaries returns every (agent, skill) pair seen", () => {
    const s = new CostStore();
    s.record({ systemActor: "goap", agentName: "quinn", skill: "pr_review", wallMs: 1, success: true, completedAt: 0, correlationId: "c" });
    s.record({ systemActor: "goap", agentName: "frank", skill: "deploy", wallMs: 2, success: true, completedAt: 0, correlationId: "c" });
    expect(s.allSummaries().length).toBe(2);
  });

  test("summary is undefined for unseen keys", () => {
    expect(new CostStore().summary("none", "none")).toBeUndefined();
  });
});

describe("cost-v1 extension interceptor", () => {
  let bus: InMemoryEventBus;
  let store: CostStore;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    store = new CostStore();
    registerCostExtension(bus, store);
  });

  test("interceptor is registered on defaultExtensionRegistry", () => {
    const uris = defaultExtensionRegistry.list().map(e => e.uri);
    expect(uris).toContain(COST_URI);
  });

  test("after() records sample + publishes autonomous.cost.# event", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === COST_URI)?.interceptor;
    expect(interceptor).toBeDefined();

    const events: unknown[] = [];
    bus.subscribe("autonomous.cost.#", "test", (msg) => { events.push(msg); });

    const ctx = makeCtx();
    interceptor!.after?.(ctx, {
      text: "done",
      data: {
        usage: { input_tokens: 1500, output_tokens: 3000 },
        durationMs: 12345,
        success: true,
      },
    });

    expect(store.size).toBe(1);
    const sum = store.summary("quinn", "pr_review");
    expect(sum?.avgTokensIn).toBe(1500);
    expect(sum?.avgTokensOut).toBe(3000);
    expect(sum?.avgWallMs).toBe(12345);
    expect(events).toHaveLength(1);
  });

  test("before() stamps x-cost-skill on metadata", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === COST_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-cost-skill"]).toBe("pr_review");
  });

  test("failure samples count against successRate", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === COST_URI)?.interceptor;
    for (let i = 0; i < 3; i++) {
      interceptor!.after?.(makeCtx({ correlationId: `c${i}` }), {
        text: "",
        data: { usage: { input_tokens: 100 }, durationMs: 1, success: i === 0 },
      });
    }
    const sum = store.summary("quinn", "pr_review");
    expect(sum?.sampleCount).toBe(3);
    expect(sum?.successRate).toBeCloseTo(1 / 3, 3);
  });
});

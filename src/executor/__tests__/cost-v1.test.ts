/**
 * Tests for the x-protolabscost-v1 extension.
 *
 * Each test calls registerCostV1Extension() which overwrites the singleton entry
 * (Map.set on the same URI), so each test gets a fresh interceptor closure with
 * isolated estimates/stats/startTimes state.
 *
 * Covers:
 *   - Extension registers with the expected URI
 *   - before() stamps estimates onto metadata when an estimate is registered
 *   - before() is a no-op when no estimate is registered
 *   - after() publishes autonomous.cost.<agentName> with correct fields
 *   - after() updates running averages across multiple calls (EMA)
 *   - after() handles missing token usage gracefully
 */

import { describe, test, expect } from "bun:test";
import { defaultExtensionRegistry } from "../extension-registry.ts";
import {
  COST_V1_URI,
  registerCostV1Extension,
  type CostActualPayload,
} from "../extensions/cost-v1.ts";
import type { BusMessage } from "../../../lib/types.ts";

function makeBus() {
  const published: Array<{ topic: string; msg: BusMessage }> = [];
  return {
    published,
    publish(topic: string, msg: BusMessage) {
      published.push({ topic, msg });
    },
    subscribe(_topic: string, _id: string, _cb: unknown) { return () => {}; },
    unsubscribe(_topic: string, _id: string) {},
  };
}

/** Get the most-recently-registered cost-v1 interceptor from the singleton. */
function getInterceptor() {
  const def = defaultExtensionRegistry.list().find(d => d.uri === COST_V1_URI);
  if (!def?.interceptor) throw new Error("cost-v1 interceptor not registered");
  return def.interceptor;
}

function makeCtx(agentName: string, skill: string, correlationId = "corr-1") {
  return { agentName, skill, correlationId, metadata: {} as Record<string, unknown> };
}

describe("registerCostV1Extension", () => {
  test("registers with the expected URI", () => {
    const bus = makeBus();
    const handle = registerCostV1Extension(bus as never);
    expect(handle).toHaveProperty("registerEstimate");
    expect(handle).toHaveProperty("getStats");
    const def = defaultExtensionRegistry.list().find(d => d.uri === COST_V1_URI);
    expect(def).toBeDefined();
    expect(def?.interceptor).toBeDefined();
  });

  test("before() stamps estimates when registered, after() publishes event", async () => {
    const bus = makeBus();
    const handle = registerCostV1Extension(bus as never);
    handle.registerEstimate("researcher", "deep_research", {
      avgTokensIn: 2000,
      avgTokensOut: 8000,
      avgWallMs: 300_000,
    });
    const interceptor = getInterceptor();

    const ctx = makeCtx("researcher", "deep_research", "corr-abc");
    interceptor.before!(ctx);

    expect(ctx.metadata["x-cost-v1-estimated-tokens-in"]).toBe(2000);
    expect(ctx.metadata["x-cost-v1-estimated-tokens-out"]).toBe(8000);
    expect(ctx.metadata["x-cost-v1-estimated-wall-ms"]).toBe(300_000);

    await new Promise(r => setTimeout(r, 5));

    interceptor.after!(ctx, {
      text: "result",
      data: { usage: { input_tokens: 1800, output_tokens: 7200 } },
    });

    expect(bus.published).toHaveLength(1);
    const { topic, msg } = bus.published[0];
    expect(topic).toBe("autonomous.cost.researcher");
    expect(msg.correlationId).toBe("corr-abc");
    expect(msg.topic).toBe("autonomous.cost.researcher");

    const p = msg.payload as CostActualPayload;
    expect(p.source).toBe("researcher");
    expect(p.skill).toBe("deep_research");
    expect(p.estimatedTokensIn).toBe(2000);
    expect(p.estimatedTokensOut).toBe(8000);
    expect(p.estimatedWallMs).toBe(300_000);
    expect(p.actualTokensIn).toBe(1800);
    expect(p.actualTokensOut).toBe(7200);
    expect(p.actualWallMs).toBeGreaterThan(0);
    expect(p.sampleCount).toBe(1);
    // First sample: EMA initialises to the sample itself
    expect(p.runningAvgTokensIn).toBe(1800);
    expect(p.runningAvgTokensOut).toBe(7200);
  });

  test("before() is a no-op when no estimate is registered", () => {
    const bus = makeBus();
    registerCostV1Extension(bus as never);
    const interceptor = getInterceptor();

    const ctx = makeCtx("unknown-agent", "unknown_skill", "corr-no-est");
    interceptor.before!(ctx);
    expect(ctx.metadata["x-cost-v1-estimated-tokens-in"]).toBeUndefined();

    interceptor.after!(ctx, { text: "ok", data: {} });

    expect(bus.published).toHaveLength(1);
    const p = bus.published[0].msg.payload as CostActualPayload;
    expect(p.estimatedTokensIn).toBe(0);
    expect(p.estimatedTokensOut).toBe(0);
    expect(p.actualTokensIn).toBeUndefined();
    expect(p.actualTokensOut).toBeUndefined();
  });

  test("after() updates running averages via EMA across multiple calls", () => {
    const bus = makeBus();
    const handle = registerCostV1Extension(bus as never);
    handle.registerEstimate("frank", "deploy", {
      avgTokensIn: 500,
      avgTokensOut: 200,
      avgWallMs: 10_000,
    });
    const interceptor = getInterceptor();

    // First call
    const ctx1 = makeCtx("frank", "deploy", "corr-f1");
    interceptor.before!(ctx1);
    interceptor.after!(ctx1, { text: "ok", data: { usage: { input_tokens: 400, output_tokens: 150 } } });

    const s1 = handle.getStats("frank", "deploy");
    expect(s1?.count).toBe(1);
    expect(s1?.avgTokensIn).toBe(400);  // first sample exact
    expect(s1?.avgTokensOut).toBe(150);

    // Second call
    const ctx2 = makeCtx("frank", "deploy", "corr-f2");
    interceptor.before!(ctx2);
    interceptor.after!(ctx2, { text: "ok", data: { usage: { input_tokens: 600, output_tokens: 250 } } });

    const s2 = handle.getStats("frank", "deploy");
    expect(s2?.count).toBe(2);
    // EMA: prev * 0.8 + sample * 0.2
    expect(s2?.avgTokensIn).toBeCloseTo(400 * 0.8 + 600 * 0.2);
    expect(s2?.avgTokensOut).toBeCloseTo(150 * 0.8 + 250 * 0.2);
  });

  test("after() does not update token averages when usage is absent", () => {
    const bus = makeBus();
    const handle = registerCostV1Extension(bus as never);
    const interceptor = getInterceptor();

    const ctx = makeCtx("ava", "chat", "corr-no-usage");
    interceptor.before!(ctx);
    interceptor.after!(ctx, { text: "ok" });

    const stats = handle.getStats("ava", "chat");
    expect(stats?.count).toBe(1);
    // token averages stay at 0 because no usage was reported
    expect(stats?.avgTokensIn).toBe(0);
    expect(stats?.avgTokensOut).toBe(0);
    // wallMs was observed
    expect(stats?.avgWallMs).toBeGreaterThanOrEqual(0);
  });

  test("getStats returns undefined for unseen agent+skill", () => {
    const bus = makeBus();
    const handle = registerCostV1Extension(bus as never);
    expect(handle.getStats("nobody", "noskill")).toBeUndefined();
  });
});

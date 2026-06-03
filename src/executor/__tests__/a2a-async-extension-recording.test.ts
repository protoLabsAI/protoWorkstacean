import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { A2AExecutor } from "../executors/a2a-executor.ts";
import { CostStore, registerCostExtension } from "../extensions/cost.ts";
import { ConfidenceStore, registerConfidenceExtension } from "../extensions/confidence.ts";

// Regression for the async-completion telemetry gap (follow-up to #763/#764):
// when a streaming agent hands off to TaskTracker polling, execute() returns
// non-terminal and SKIPS its after-hooks, so the cost-v1/confidence-v1 samples
// must be recorded on the async terminal completion instead. TaskTracker calls
// A2AExecutor.recordTerminalExtensions for exactly that.

describe("A2AExecutor.recordTerminalExtensions — async completion path", () => {
  let bus: InMemoryEventBus;
  let costStore: CostStore;
  let confStore: ConfidenceStore;
  let exec: A2AExecutor;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    costStore = new CostStore();
    confStore = new ConfidenceStore();
    registerCostExtension(bus, costStore);
    registerConfidenceExtension(bus, confStore);
    exec = new A2AExecutor({ name: "roxy", url: "http://roxy:7870/a2a", streaming: true, pushNotifications: false });
  });

  test("records real cost + confidence from a terminal result.data", async () => {
    const costEvents: unknown[] = [];
    const confEvents: unknown[] = [];
    bus.subscribe("autonomous.cost.#", "t", (m) => { costEvents.push(m); });
    bus.subscribe("autonomous.confidence.#", "t", (m) => { confEvents.push(m); });

    await exec.recordTerminalExtensions("portfolio_sitrep", "corr-async", {
      usage: { input_tokens: 54339, output_tokens: 1969 },
      costUsd: 0.006221,
      success: true,
      confidence: 0.92,
      confidenceExplanation: "consistent across sources",
    });

    const cost = costStore.summary("roxy", "portfolio_sitrep");
    expect(cost?.sampleCount).toBe(1);
    expect(cost?.avgTokensIn).toBe(54339);
    expect(cost?.avgTokensOut).toBe(1969);
    expect(cost?.avgCostUsd).toBe(0.006221);

    const conf = confStore.summary("roxy", "portfolio_sitrep");
    expect(conf?.sampleCount).toBe(1);
    expect(conf?.avgConfidenceOnSuccess).toBe(0.92);

    expect(costEvents).toHaveLength(1);
    expect(confEvents).toHaveLength(1);
  });

  test("no-ops on undefined data (nothing recorded)", async () => {
    await exec.recordTerminalExtensions("portfolio_sitrep", "corr-x", undefined);
    expect(costStore.size).toBe(0);
    expect(confStore.size).toBe(0);
  });

  test("records cost but not confidence when only cost is present", async () => {
    await exec.recordTerminalExtensions("board_sweep", "corr-y", {
      usage: { input_tokens: 100, output_tokens: 50 },
      costUsd: 0.001,
      success: true,
    });
    expect(costStore.summary("roxy", "board_sweep")?.sampleCount).toBe(1);
    expect(confStore.summary("roxy", "board_sweep")).toBeUndefined();
  });
});

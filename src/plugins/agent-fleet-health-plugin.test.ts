import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { AgentFleetHealthPlugin } from "./agent-fleet-health-plugin.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { BusMessage } from "../../lib/types.ts";

const makeOutcomeMsg = (payload: Partial<AutonomousOutcomePayload> & { systemActor: string; skill: string }): BusMessage => ({
  id: crypto.randomUUID(),
  correlationId: payload.correlationId ?? crypto.randomUUID(),
  topic: "autonomous.outcome.completed",
  timestamp: Date.now(),
  payload: {
    correlationId: payload.correlationId ?? crypto.randomUUID(),
    systemActor: payload.systemActor,
    skill: payload.skill,
    success: payload.success ?? true,
    durationMs: payload.durationMs ?? 500,
    taskState: payload.taskState,
    usage: payload.usage,
  } satisfies AutonomousOutcomePayload,
});

describe("AgentFleetHealthPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: AgentFleetHealthPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new AgentFleetHealthPlugin();
    plugin.install(bus);
  });

  test("returns empty agents array when no outcomes recorded", () => {
    const snapshot = plugin.getFleetHealth();
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.windowHours).toBe(24);
    expect(snapshot.collectedAt).toBeGreaterThan(0);
  });

  test("records a successful outcome and computes successRate=1", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: true,
      durationMs: 1000,
    }));

    // allow async handler to settle
    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.agents).toHaveLength(1);
    const agent = snapshot.agents[0];
    expect(agent.agentName).toBe("ava");
    expect(agent.successRate).toBe(1);
    expect(agent.totalOutcomes).toBe(1);
    expect(agent.recentFailures).toHaveLength(0);
    expect(agent.p50LatencyMs).toBe(1000);
    expect(agent.p95LatencyMs).toBe(1000);
  });

  test("records a failed outcome and computes successRate=0", async () => {
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({
      systemActor: "quinn",
      skill: "sweep",
      success: false,
      durationMs: 300,
      taskState: "failed",
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.agents).toHaveLength(1);
    const agent = snapshot.agents[0];
    expect(agent.agentName).toBe("quinn");
    expect(agent.successRate).toBe(0);
    expect(agent.recentFailures).toHaveLength(1);
    expect(agent.recentFailures[0].skill).toBe("sweep");
  });

  test("computes successRate across mixed outcomes", async () => {
    for (let i = 0; i < 3; i++) {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 200,
      }));
    }
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: false,
      durationMs: 100,
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "ava")!;
    expect(agent.totalOutcomes).toBe(4);
    expect(agent.successRate).toBeCloseTo(0.75, 5);
  });

  test("computes p50 and p95 latency correctly", async () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    for (const d of durations) {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "bot",
        skill: "run",
        success: true,
        durationMs: d,
      }));
    }

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "bot")!;
    // p50 = index floor(10 * 0.5) = 5 → 600 (0-indexed sorted)
    expect(agent.p50LatencyMs).toBe(600);
    // p95 = index floor(10 * 0.95) = 9 → 1000
    expect(agent.p95LatencyMs).toBe(1000);
  });

  test("computes costPerSuccessfulOutcome from token usage", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: true,
      durationMs: 500,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "ava")!;
    // costPerSuccessfulOutcome > 0 when usage is provided
    expect(agent.costPerSuccessfulOutcome).toBeGreaterThan(0);
  });

  test("costPerSuccessfulOutcome is 0 when all outcomes are failures", async () => {
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: false,
      durationMs: 200,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "ava")!;
    expect(agent.costPerSuccessfulOutcome).toBe(0);
  });

  test("tracks multiple agents independently", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: true, durationMs: 100 }));
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "quinn", skill: "sweep", success: false, durationMs: 200 }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.agents).toHaveLength(2);
    const ava = snapshot.agents.find(a => a.agentName === "ava")!;
    const quinn = snapshot.agents.find(a => a.agentName === "quinn")!;
    expect(ava.successRate).toBe(1);
    expect(quinn.successRate).toBe(0);
  });

  test("recentFailures lists at most 10 entries, most recent first", async () => {
    const timestamps: number[] = [];
    for (let i = 0; i < 15; i++) {
      const correlationId = `corr-${i}`;
      bus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "bot",
        skill: "run",
        success: false,
        correlationId,
        durationMs: 100,
      }));
      timestamps.push(Date.now());
      await new Promise(r => setTimeout(r, 1)); // ensure distinct timestamps
    }

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "bot")!;
    expect(agent.recentFailures).toHaveLength(10);
    // most-recent first
    for (let i = 0; i < agent.recentFailures.length - 1; i++) {
      expect(agent.recentFailures[i].timestamp).toBeGreaterThanOrEqual(agent.recentFailures[i + 1].timestamp);
    }
  });

  test("uninstall cleans up subscription", () => {
    plugin.uninstall();
    // After uninstall, publishing should not throw or add records
    expect(() => {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: true, durationMs: 100 }));
    }).not.toThrow();
    const snapshot = plugin.getFleetHealth();
    expect(snapshot.agents).toHaveLength(0);
  });
});

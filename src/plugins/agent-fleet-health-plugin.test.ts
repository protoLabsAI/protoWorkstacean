import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { AgentFleetHealthPlugin } from "./agent-fleet-health-plugin.ts";
import { FleetStateRepository } from "../knowledge/fleet-state.ts";
import { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../executor/types.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { BusMessage } from "../../lib/types.ts";

/** Minimal executor stub — just satisfies the IExecutor shape for registry wiring. */
class StubExecutor implements IExecutor {
  readonly type = "stub";
  async execute(_req: SkillRequest): Promise<SkillResult> {
    return { text: "", isError: false, correlationId: "" };
  }
}

const makeRegistry = (agentNames: string[]): ExecutorRegistry => {
  const reg = new ExecutorRegistry();
  for (const name of agentNames) {
    reg.register("noop", new StubExecutor(), { agentName: name });
  }
  return reg;
};

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
    model: payload.model,
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

  test("failureRate1h is 0 for agent with no 1h outcomes", () => {
    const snapshot = plugin.getFleetHealth();
    expect(snapshot.maxFailureRate1h).toBe(0);
  });

  test("failureRate1h reflects only outcomes within the last 1h", async () => {
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: false,
      durationMs: 100,
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "ava")!;
    expect(agent.failureRate1h).toBe(1);
    expect(snapshot.maxFailureRate1h).toBe(1);
  });

  test("maxFailureRate1h is 0 when all recent outcomes succeed", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
      systemActor: "ava",
      skill: "plan",
      success: true,
      durationMs: 100,
    }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    const agent = snapshot.agents.find(a => a.agentName === "ava")!;
    expect(agent.failureRate1h).toBe(0);
    expect(snapshot.maxFailureRate1h).toBe(0);
  });

  test("maxFailureRate1h is the max failureRate1h across all agents", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: true, durationMs: 100 }));
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "quinn", skill: "sweep", success: false, durationMs: 100 }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.maxFailureRate1h).toBe(1);
  });

  // ── Arc 8.5: orphanedSkillCount ───────────────────────────────────────────
  test("orphanedSkillCount is 0 when all skills have at least one success", async () => {
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: true, durationMs: 100 }));
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: false, durationMs: 100 }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.orphanedSkillCount).toBe(0);
  });

  test("orphanedSkillCount counts skills with no success in window", async () => {
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "ava", skill: "sweep", success: false, durationMs: 100 }));
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "quinn", skill: "review", success: false, durationMs: 200 }));
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: true, durationMs: 100 }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.orphanedSkillCount).toBe(2);
  });

  test("orphanedSkillCount is 0 when no outcomes recorded", () => {
    const snapshot = plugin.getFleetHealth();
    expect(snapshot.orphanedSkillCount).toBe(0);
  });

  test("same skill across agents — counts as not orphaned if any agent succeeded", async () => {
    bus.publish("autonomous.outcome.failed", makeOutcomeMsg({ systemActor: "ava", skill: "plan", success: false, durationMs: 100 }));
    bus.publish("autonomous.outcome.completed", makeOutcomeMsg({ systemActor: "quinn", skill: "plan", success: true, durationMs: 100 }));

    await new Promise(r => setTimeout(r, 10));

    const snapshot = plugin.getFleetHealth();
    expect(snapshot.orphanedSkillCount).toBe(0);
  });

  // ── #459: synthetic-actor whitelist via ExecutorRegistry ─────────────────
  describe("synthetic actor filtering (#459)", () => {
    let wlBus: InMemoryEventBus;
    let wlPlugin: AgentFleetHealthPlugin;

    beforeEach(() => {
      wlBus = new InMemoryEventBus();
      const registry = makeRegistry(["ava", "quinn", "protomaker"]);
      wlPlugin = new AgentFleetHealthPlugin(registry);
      wlPlugin.install(wlBus);
    });

    test("outcome from a registered agent lands in agents[]", async () => {
      wlBus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "quinn", skill: "triage", success: true, durationMs: 100,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.agents).toHaveLength(1);
      expect(snap.agents[0].agentName).toBe("quinn");
      expect(snap.systemActors).toHaveLength(0);
    });

    test("outcome from outcome-analysis does NOT pollute agents[]", async () => {
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "outcome-analysis", skill: "analyze", success: false, durationMs: 200,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.agents).toHaveLength(0);
      expect(snap.systemActors).toHaveLength(1);
      expect(snap.systemActors[0].systemActor).toBe("outcome-analysis");
      expect(snap.systemActors[0].failureCount).toBe(1);
    });

    test("outcome from pr-remediator does NOT pollute agents[]", async () => {
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "pr-remediator", skill: "bug_triage", success: false, durationMs: 500,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.agents).toHaveLength(0);
      expect(snap.agents.find(a => a.agentName === "pr-remediator")).toBeUndefined();
      expect(snap.systemActors.find(s => s.systemActor === "pr-remediator")).toBeDefined();
    });

    test("agentCount after mixed outcomes = count of real agents only", async () => {
      // Real agents
      wlBus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava", skill: "plan", success: true, durationMs: 100,
      }));
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "quinn", skill: "sweep", success: false, durationMs: 100,
      }));
      // Synthetic / plugin actors
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "pr-remediator", skill: "bug_triage", success: false, durationMs: 100,
      }));
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "outcome-analysis", skill: "analyze", success: false, durationMs: 100,
      }));
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "user", skill: "chat", success: false, durationMs: 100,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.agents).toHaveLength(2);
      expect(new Set(snap.agents.map(a => a.agentName))).toEqual(new Set(["ava", "quinn"]));
      expect(snap.systemActors).toHaveLength(3);
      expect(new Set(snap.systemActors.map(s => s.systemActor))).toEqual(
        new Set(["pr-remediator", "outcome-analysis", "user"]),
      );
    });

    test("maxFailureRate1h is not inflated by synthetic-actor failures", async () => {
      // One real agent with full success in 1h
      wlBus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava", skill: "plan", success: true, durationMs: 100,
      }));
      // Synthetic actor with 100% failure — must not leak into maxFailureRate1h
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "pr-remediator", skill: "bug_triage", success: false, durationMs: 100,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.maxFailureRate1h).toBe(0);
    });

    test("orphanedSkillCount excludes synthetic-actor-only skills", async () => {
      // Real agent has a successful "plan" skill
      wlBus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava", skill: "plan", success: true, durationMs: 100,
      }));
      // Synthetic actor fails a skill nobody else runs — shouldn't count as orphaned
      wlBus.publish("autonomous.outcome.failed", makeOutcomeMsg({
        systemActor: "pr-remediator", skill: "bug_triage", success: false, durationMs: 100,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = wlPlugin.getFleetHealth();
      expect(snap.orphanedSkillCount).toBe(0);
    });

    test("with empty registry, all actors are filtered to systemActors[]", async () => {
      const emptyBus = new InMemoryEventBus();
      const emptyPlugin = new AgentFleetHealthPlugin(new ExecutorRegistry());
      emptyPlugin.install(emptyBus);

      emptyBus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava", skill: "plan", success: true, durationMs: 100,
      }));
      await new Promise(r => setTimeout(r, 10));

      const snap = emptyPlugin.getFleetHealth();
      expect(snap.agents).toHaveLength(0);
      expect(snap.systemActors).toHaveLength(1);
    });
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

  describe("per-model cost attribution (MODEL_RATES lookup)", () => {
    test("uses Opus rate when payload.model='claude-opus-4-6' (5x default)", async () => {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 500,
        usage: { input_tokens: 1000, output_tokens: 1000 },
        model: "claude-opus-4-6",
      }));
      await new Promise(r => setTimeout(r, 10));

      const ava = plugin.getFleetHealth().agents.find(a => a.agentName === "ava")!;
      // Opus: 0.000015 in + 0.000075 out per token → 1000*(0.000015+0.000075) = 0.09
      // Default would be: 0.000003 + 0.000015 → 0.018. So Opus reads 5x default.
      expect(ava.costPerSuccessfulOutcome).toBeCloseTo(0.09, 3);
    });

    test("uses Haiku rate when payload.model='claude-haiku-4-5' (~1/12 default)", async () => {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 500,
        usage: { input_tokens: 1000, output_tokens: 1000 },
        model: "claude-haiku-4-5",
      }));
      await new Promise(r => setTimeout(r, 10));

      const ava = plugin.getFleetHealth().agents.find(a => a.agentName === "ava")!;
      // Haiku: 0.00000025 + 0.00000125 per token → 1000*(0.0000015) = 0.0015
      expect(ava.costPerSuccessfulOutcome).toBeCloseTo(0.0015, 4);
    });

    test("falls back to default rate when model is undefined (caller didn't override)", async () => {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 500,
        usage: { input_tokens: 1000, output_tokens: 1000 },
        // no model field
      }));
      await new Promise(r => setTimeout(r, 10));

      const ava = plugin.getFleetHealth().agents.find(a => a.agentName === "ava")!;
      // Default: 0.000003 + 0.000015 per token → 0.018
      expect(ava.costPerSuccessfulOutcome).toBeCloseTo(0.018, 4);
    });

    test("unknown model falls back to default and is acceptable (warn-once side-effect not asserted here)", async () => {
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 500,
        usage: { input_tokens: 1000, output_tokens: 1000 },
        model: "made-up-model-that-does-not-exist",
      }));
      await new Promise(r => setTimeout(r, 10));

      const ava = plugin.getFleetHealth().agents.find(a => a.agentName === "ava")!;
      // Falls back to default rate
      expect(ava.costPerSuccessfulOutcome).toBeCloseTo(0.018, 4);
    });
  });

  describe("durable persistence (ADR-0004 P5)", () => {
    const DB = join(import.meta.dir, ".test-fleet-health-hydrate.db");
    const wipe = () => {
      for (const s of ["", "-wal", "-shm"]) if (existsSync(DB + s)) rmSync(DB + s);
    };

    beforeEach(wipe);
    afterEach(wipe);

    test("persists outcomes and rehydrates the window on install", async () => {
      const registry = makeRegistry(["ava"]);

      // First lifetime: record an outcome, then tear down.
      const repo1 = new FleetStateRepository(DB);
      repo1.init();
      const p1 = new AgentFleetHealthPlugin(registry, repo1);
      p1.install(bus);
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "ava",
        skill: "plan",
        success: true,
        durationMs: 1000,
      }));
      await new Promise((r) => setTimeout(r, 10));
      expect(p1.getFleetHealth().agents).toHaveLength(1);
      p1.uninstall();
      repo1.close();

      // Second lifetime: a fresh plugin + bus hydrates the prior outcome from disk.
      const bus2 = new InMemoryEventBus();
      const repo2 = new FleetStateRepository(DB);
      repo2.init();
      const p2 = new AgentFleetHealthPlugin(registry, repo2);
      p2.install(bus2);

      const ava = p2.getFleetHealth().agents.find((a) => a.agentName === "ava");
      expect(ava).toBeDefined();
      expect(ava!.totalOutcomes).toBe(1);
      expect(ava!.successRate).toBe(1);
      p2.uninstall();
      repo2.close();
    });

    test("hydration routes unregistered actors to systemActors[]", async () => {
      const registry = makeRegistry(["ava"]); // pr-remediator is NOT registered

      const repo1 = new FleetStateRepository(DB);
      repo1.init();
      const p1 = new AgentFleetHealthPlugin(registry, repo1);
      p1.install(bus);
      bus.publish("autonomous.outcome.completed", makeOutcomeMsg({
        systemActor: "pr-remediator",
        skill: "remediate",
        success: true,
      }));
      await new Promise((r) => setTimeout(r, 10));
      p1.uninstall();
      repo1.close();

      const bus2 = new InMemoryEventBus();
      const repo2 = new FleetStateRepository(DB);
      repo2.init();
      const p2 = new AgentFleetHealthPlugin(registry, repo2);
      p2.install(bus2);

      const snap = p2.getFleetHealth();
      expect(snap.agents.find((a) => a.agentName === "pr-remediator")).toBeUndefined();
      expect(snap.systemActors.find((s) => s.systemActor === "pr-remediator")).toBeDefined();
      p2.uninstall();
      repo2.close();
    });
  });
});

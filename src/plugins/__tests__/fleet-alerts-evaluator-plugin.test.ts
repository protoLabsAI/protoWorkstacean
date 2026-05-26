/**
 * Verifies that FleetAlertsEvaluatorPlugin reads a FleetHealthSnapshot, emits
 * agent.skill.request{skill: alert.*} on threshold violation, and respects
 * per-alert cooldown — the Phase 1 re-wire of the alert path that was
 * orphaned by the GOAP rip (#518).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { FleetAlertsEvaluatorPlugin } from "../fleet-alerts-evaluator-plugin.ts";
import type { FleetHealthSnapshot, AgentFleetHealthPlugin } from "../agent-fleet-health-plugin.ts";
import type { BusMessage } from "../../../lib/types.ts";
import type { SkillRequest, SkillResult } from "../../executor/types.ts";

function fakeFleetHealth(snapshot: FleetHealthSnapshot): AgentFleetHealthPlugin {
  return { getFleetHealth: () => snapshot } as unknown as AgentFleetHealthPlugin;
}

function healthySnapshot(): FleetHealthSnapshot {
  return {
    agents: [],
    windowHours: 24,
    maxFailureRate1h: 0,
    totalCostUsd1d: 0,
    orphanedSkillCount: 0,
    systemActors: [],
  } as unknown as FleetHealthSnapshot;
}

function runSkill(plugin: FleetAlertsEvaluatorPlugin, registry: ExecutorRegistry, correlationId = "c1"): Promise<SkillResult> {
  const executor = registry.resolve("evaluate_fleet_thresholds", []);
  if (!executor) throw new Error("evaluate_fleet_thresholds not registered");
  const req: SkillRequest = {
    skill: "evaluate_fleet_thresholds",
    content: "",
    correlationId,
    parentId: "p1",
    replyTopic: "reply.test",
    payload: { skill: "evaluate_fleet_thresholds" },
  };
  return executor.execute(req);
}

describe("FleetAlertsEvaluatorPlugin", () => {
  let bus: InMemoryEventBus;
  let registry: ExecutorRegistry;
  let alerts: BusMessage[];

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ExecutorRegistry();
    alerts = [];
    bus.subscribe("agent.skill.request", "test-collector", msg => {
      alerts.push(msg);
    });
  });

  afterEach(() => {
    delete process.env["WORKSTACEAN_FLEET_ALERT_COOLDOWN_MS"];
    delete process.env["WORKSTACEAN_FLEET_DAILY_BUDGET_USD"];
    delete process.env["WORKSTACEAN_FLEET_FAILURE_RATE_THRESHOLD"];
  });

  test("healthy snapshot → zero dispatches", async () => {
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(healthySnapshot()));
    plugin.install(bus);
    const result = await runSkill(plugin, registry);
    expect(alerts).toHaveLength(0);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Fleet healthy");
    plugin.uninstall();
  });

  test("failureRate1h above threshold → dispatches alert.fleet_agent_stuck", async () => {
    const snap = {
      ...healthySnapshot(),
      maxFailureRate1h: 0.75,
      agents: [{ agentName: "quinn", failureRate1h: 0.75 }],
    } as unknown as FleetHealthSnapshot;
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(snap));
    plugin.install(bus);
    await runSkill(plugin, registry);

    const fired = alerts.filter(m => {
      const p = m.payload as Record<string, unknown>;
      return p.skill === "alert.fleet_agent_stuck";
    });
    expect(fired).toHaveLength(1);
    const payload = fired[0].payload as Record<string, unknown>;
    expect(payload.content).toContain("quinn");
    expect(payload.content).toContain("75%");
    const meta = payload.meta as Record<string, unknown>;
    expect(meta.metric).toBe("maxFailureRate1h");
    expect(meta.value).toBe(0.75);
    expect(meta.via).toBe("fleet-alerts-evaluator");
    plugin.uninstall();
  });

  test("totalCostUsd1d above budget → dispatches alert.fleet_cost_over_budget", async () => {
    process.env["WORKSTACEAN_FLEET_DAILY_BUDGET_USD"] = "10";
    const snap = { ...healthySnapshot(), totalCostUsd1d: 25.50 } as unknown as FleetHealthSnapshot;
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(snap));
    plugin.install(bus);
    await runSkill(plugin, registry);

    const fired = alerts.filter(m => (m.payload as Record<string, unknown>).skill === "alert.fleet_cost_over_budget");
    expect(fired).toHaveLength(1);
    const payload = fired[0].payload as Record<string, unknown>;
    expect(payload.content).toContain("$25.50");
    expect(payload.content).toContain("$10");
    plugin.uninstall();
  });

  test("orphanedSkillCount > 0 → dispatches alert.fleet_skill_orphaned", async () => {
    const snap = { ...healthySnapshot(), orphanedSkillCount: 3 } as unknown as FleetHealthSnapshot;
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(snap));
    plugin.install(bus);
    await runSkill(plugin, registry);

    const fired = alerts.filter(m => (m.payload as Record<string, unknown>).skill === "alert.fleet_skill_orphaned");
    expect(fired).toHaveLength(1);
    expect((fired[0].payload as Record<string, unknown>).content).toContain("3 skill");
    plugin.uninstall();
  });

  test("multiple thresholds trip → multiple dispatches in one run", async () => {
    process.env["WORKSTACEAN_FLEET_DAILY_BUDGET_USD"] = "10";
    const snap = {
      ...healthySnapshot(),
      maxFailureRate1h: 0.9,
      totalCostUsd1d: 100,
      orphanedSkillCount: 2,
      agents: [{ agentName: "quinn", failureRate1h: 0.9 }],
    } as unknown as FleetHealthSnapshot;
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(snap));
    plugin.install(bus);
    await runSkill(plugin, registry);

    const skills = alerts.map(m => (m.payload as Record<string, unknown>).skill);
    expect(skills).toContain("alert.fleet_agent_stuck");
    expect(skills).toContain("alert.fleet_cost_over_budget");
    expect(skills).toContain("alert.fleet_skill_orphaned");
    expect(skills).toHaveLength(3);
    plugin.uninstall();
  });

  test("same alert in cooldown window → second run is suppressed", async () => {
    process.env["WORKSTACEAN_FLEET_ALERT_COOLDOWN_MS"] = "60000";
    const snap = { ...healthySnapshot(), orphanedSkillCount: 1 } as unknown as FleetHealthSnapshot;
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(snap));
    plugin.install(bus);

    // First run fires
    await runSkill(plugin, registry, "c1");
    expect(alerts).toHaveLength(1);

    // Second run within cooldown — suppressed
    const result = await runSkill(plugin, registry, "c2");
    expect(alerts).toHaveLength(1);
    expect(result.text).toContain("cooldown-suppressed");
    plugin.uninstall();
  });

  test("registers evaluate_fleet_thresholds on the ExecutorRegistry at install", () => {
    const plugin = new FleetAlertsEvaluatorPlugin(registry, fakeFleetHealth(healthySnapshot()));
    expect(registry.resolve("evaluate_fleet_thresholds", [])).toBeNull();
    plugin.install(bus);
    expect(registry.resolve("evaluate_fleet_thresholds", [])).not.toBeNull();
    plugin.uninstall();
  });
});

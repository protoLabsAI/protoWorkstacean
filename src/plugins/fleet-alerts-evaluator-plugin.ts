/**
 * FleetAlertsEvaluatorPlugin — bridges fleet health into the alert dispatch
 * path that was orphaned when the GOAP layer was ripped (#518).
 *
 * Before the rip: ActionDispatcherPlugin read goals.yaml + actions.yaml,
 * polled world-state every 60s, and published `agent.skill.request{skill:
 * alert.*}` when preconditions tripped. AlertSkillExecutorPlugin consumed the
 * dispatch and emitted a Discord alert.
 *
 * After the rip: AlertSkillExecutorPlugin still registers 20 alert skills,
 * but nothing publishes the dispatches. Every alert in workspace/actions.yaml
 * is dead code.
 *
 * Re-wire: this plugin registers the `evaluate_fleet_thresholds` skill (a
 * FunctionExecutor) on the ExecutorRegistry. A new ceremony
 * (workspace/ceremonies/fleet-alerts.yaml) dispatches the skill every minute,
 * which triggers _evaluate() to:
 *
 *   1. Read AgentFleetHealthPlugin.getFleetHealth()
 *   2. Compare each threshold-driven metric against its bound
 *   3. For each violation, publish `agent.skill.request{skill: alert.X}` so
 *      AlertSkillExecutorPlugin emits its existing Discord alert
 *   4. Suppress repeats for ALERT_COOLDOWN_MS per alert skill (default 15min)
 *
 * Greenfield rule: this replaces the entire GOAP layer's *role in alerting*,
 * not GOAP itself. There's no goals.yaml, no preconditions DSL, no world-
 * state engine. The threshold table is a simple in-code array. If thresholds
 * need to be operator-configurable, do that via env override per threshold
 * (consistent with how WORKSTACEAN_COOLDOWN_MS_<SKILL> works) — not by
 * re-introducing a YAML-driven planner.
 *
 * Scope today: three fleet-health-derived alerts (agent_stuck,
 * cost_over_budget, skill_orphaned). The other 17 alert skills in
 * AlertSkillExecutorPlugin need different data sources (GitHub API for
 * branch/CI alerts, security state for incidents, etc.) and stay
 * unwired for now — same as before this plugin.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import type { AgentFleetHealthPlugin, FleetHealthSnapshot } from "./agent-fleet-health-plugin.ts";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";
import { logger } from "../../lib/log.ts";

const log = logger("fleet-alerts-evaluator");

/** Minimum interval between firing the same alert skill (env: WORKSTACEAN_FLEET_ALERT_COOLDOWN_MS). */
const ALERT_COOLDOWN_MS_DEFAULT = 15 * 60_000;

/** Daily fleet LLM spend budget in USD. Env: WORKSTACEAN_FLEET_DAILY_BUDGET_USD. Default 50. */
const FLEET_DAILY_BUDGET_USD_DEFAULT = 50;

/** Per-agent 1h failure rate that trips `alert.fleet_agent_stuck`. Env: WORKSTACEAN_FLEET_FAILURE_RATE_THRESHOLD. Default 0.5. */
const FAILURE_RATE_1H_THRESHOLD_DEFAULT = 0.5;

interface ThresholdViolation {
  alertSkill: string;
  metric: string;
  value: number;
  threshold: number;
  detail: string;
}

export class FleetAlertsEvaluatorPlugin implements Plugin {
  readonly name = "fleet-alerts-evaluator";
  readonly description =
    "Evaluates fleet-health thresholds every minute and dispatches alert.* skills on violation";
  readonly capabilities = ["fleet-alerts-evaluator", "executor-registrar"];

  private bus?: EventBus;
  private readonly lastFiredAt = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly dailyBudgetUsd: number;
  private readonly failureRateThreshold: number;

  constructor(
    private readonly registry: ExecutorRegistry,
    private readonly fleetHealth: AgentFleetHealthPlugin,
  ) {
    this.cooldownMs = Number(process.env["WORKSTACEAN_FLEET_ALERT_COOLDOWN_MS"]) || ALERT_COOLDOWN_MS_DEFAULT;
    this.dailyBudgetUsd = Number(process.env["WORKSTACEAN_FLEET_DAILY_BUDGET_USD"]) || FLEET_DAILY_BUDGET_USD_DEFAULT;
    this.failureRateThreshold =
      Number(process.env["WORKSTACEAN_FLEET_FAILURE_RATE_THRESHOLD"]) || FAILURE_RATE_1H_THRESHOLD_DEFAULT;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    const executor = new FunctionExecutor(async (req: SkillRequest) => this._execute(req));
    this.registry.register("evaluate_fleet_thresholds", executor, { priority: 5 });
    log.info(
      `Installed — failureRate1h>${this.failureRateThreshold}, ` +
        `dailyBudget=$${this.dailyBudgetUsd}, alertCooldown=${Math.round(this.cooldownMs / 60_000)}min`,
    );
  }

  uninstall(): void {
    this.bus = undefined;
    this.lastFiredAt.clear();
  }

  private async _execute(req: SkillRequest): Promise<SkillResult> {
    if (!this.bus) {
      return { text: "fleet-alerts-evaluator not installed", isError: true, correlationId: req.correlationId };
    }

    const snapshot = this.fleetHealth.getFleetHealth();
    const violations = this._evaluate(snapshot);

    if (violations.length === 0) {
      return {
        text: `Fleet healthy: failureRate1h=${snapshot.maxFailureRate1h.toFixed(2)}, cost1d=$${snapshot.totalCostUsd1d.toFixed(2)}, orphans=${snapshot.orphanedSkillCount}`,
        isError: false,
        correlationId: req.correlationId,
      };
    }

    const now = Date.now();
    const fired: string[] = [];
    const suppressed: string[] = [];

    for (const v of violations) {
      const last = this.lastFiredAt.get(v.alertSkill);
      if (last !== undefined && now - last < this.cooldownMs) {
        suppressed.push(v.alertSkill);
        continue;
      }
      this.lastFiredAt.set(v.alertSkill, now);
      this._dispatchAlert(req.correlationId, v);
      fired.push(v.alertSkill);
    }

    return {
      text: `Fleet thresholds: ${fired.length} fired [${fired.join(", ")}], ${suppressed.length} cooldown-suppressed [${suppressed.join(", ")}]`,
      isError: false,
      correlationId: req.correlationId,
    };
  }

  /**
   * Pure function — easier to unit-test than poking through plugin state.
   * Returns one ThresholdViolation per tripped threshold; empty array if
   * everything is within bounds.
   */
  private _evaluate(snapshot: FleetHealthSnapshot): ThresholdViolation[] {
    const violations: ThresholdViolation[] = [];

    if (snapshot.maxFailureRate1h > this.failureRateThreshold) {
      // Find the worst-offending agent so the Discord alert has context.
      const worst = [...snapshot.agents]
        .filter(a => typeof a.failureRate1h === "number")
        .sort((a, b) => (b.failureRate1h ?? 0) - (a.failureRate1h ?? 0))[0];
      const worstLabel = worst
        ? `${worst.agentName} at ${((worst.failureRate1h ?? 0) * 100).toFixed(0)}%`
        : `max ${(snapshot.maxFailureRate1h * 100).toFixed(0)}%`;
      violations.push({
        alertSkill: "alert.fleet_agent_stuck",
        metric: "maxFailureRate1h",
        value: snapshot.maxFailureRate1h,
        threshold: this.failureRateThreshold,
        detail: `Agent failure rate over 1h exceeds ${(this.failureRateThreshold * 100).toFixed(0)}% (worst: ${worstLabel})`,
      });
    }

    if (snapshot.totalCostUsd1d > this.dailyBudgetUsd) {
      violations.push({
        alertSkill: "alert.fleet_cost_over_budget",
        metric: "totalCostUsd1d",
        value: snapshot.totalCostUsd1d,
        threshold: this.dailyBudgetUsd,
        detail: `Daily LLM spend $${snapshot.totalCostUsd1d.toFixed(2)} exceeds budget $${this.dailyBudgetUsd}`,
      });
    }

    if (snapshot.orphanedSkillCount > 0) {
      violations.push({
        alertSkill: "alert.fleet_skill_orphaned",
        metric: "orphanedSkillCount",
        value: snapshot.orphanedSkillCount,
        threshold: 0,
        detail: `${snapshot.orphanedSkillCount} skill(s) active in 24h with zero successful outcomes`,
      });
    }

    return violations;
  }

  private _dispatchAlert(parentCorrelationId: string, violation: ThresholdViolation): void {
    if (!this.bus) return;
    const correlationId = `fleet-alert-${violation.alertSkill}-${Date.now()}`;
    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: violation.alertSkill,
        content: violation.detail,
        meta: {
          actionId: violation.alertSkill,
          goalId: `fleet.${violation.metric}`,
          // Carry the actual measured values so AlertSkillExecutorPlugin's
          // `meta.extra` payload includes them in the Discord alert body.
          metric: violation.metric,
          value: violation.value,
          threshold: violation.threshold,
          // Audit trail back to the ceremony that triggered this.
          parentCorrelationId,
          via: "fleet-alerts-evaluator",
        },
      },
    } as BusMessage);

    log.info(
      `DISPATCH ${violation.alertSkill}: ${violation.metric}=${violation.value} > ${violation.threshold} — ${violation.detail}`,
    );
  }
}

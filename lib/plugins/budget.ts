/**
 * BudgetPlugin — cost-aware budget management for the Workstacean bus.
 *
 * Implements:
 *   - Pre-flight cost estimation (Anthropic token counting API with heuristic fallback)
 *   - Per-agent / per-project / daily budget tracking (SQLite)
 *   - Tier routing: L0 → L1 → L2 → L3 (based on max_cost + remaining budget)
 *   - Circuit breaker per goal×agent combination
 *   - HITL escalation for L3 requests (extends existing HITLPlugin)
 *   - Discord alerts at 50% and 80% threshold
 *   - Metrics collection (targets 85–90% autonomous rate)
 *
 * Bus topics:
 *   Subscribes:
 *     budget.request.#  — pre-flight cost check (publish BudgetRequest payload)
 *     budget.actual.#   — post-execution cost reconciliation
 *   Publishes:
 *     budget.decision.{requestId} — BudgetDecision (approved/rejected/tier)
 *     hitl.request.budget.{requestId} — L3 escalation to HITLPlugin
 *     budget.alert.threshold — threshold crossed (50%/80%)
 *     budget.circuit.open.{key} — circuit breaker state change
 *     ops.alert.budget — ops-level alerts (rate below 85%, reconciliation errors)
 *
 * Daily caps:
 *   MAX_PROJECT_BUDGET = $10 per project per day
 *   MAX_DAILY_BUDGET   = $50 total per day
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import type {
  BudgetRequest,
  BudgetDecision,
  BudgetActual,
  EscalationContext,
} from "../types/budget.ts";
import { MAX_PROJECT_BUDGET, MAX_DAILY_BUDGET } from "../types/budget.ts";
import { pre_flight_estimate } from "./cost-estimator.ts";
import { BudgetTracker } from "./budget-tracker.ts";
import { route_by_tier } from "./tier-router.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { DiscordAlerter } from "./discord-alerts.ts";
import { MetricsTracker } from "./metrics-tracker.ts";

// ── BudgetPlugin ──────────────────────────────────────────────────────────────

export class BudgetPlugin implements Plugin {
  readonly name = "budget";
  readonly description =
    "Cost-aware budget management — pre-flight cost estimation, tier routing, circuit breakers, and HITL escalation";
  readonly capabilities = [
    "budget-tracking",
    "tier-routing",
    "circuit-breaker",
    "cost-estimation",
    "hitl-escalation",
  ];

  private tracker: BudgetTracker;
  private circuitBreaker: CircuitBreaker;
  private alerter: DiscordAlerter;
  private metrics: MetricsTracker;

  private dataDir: string;
  private busRef: EventBus | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.tracker = new BudgetTracker(dataDir);
    this.circuitBreaker = new CircuitBreaker();
    this.alerter = new DiscordAlerter();
    this.metrics = new MetricsTracker();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  install(bus: EventBus): void {
    this.busRef = bus;
    this.tracker.init();
    this.alerter.start();

    // ── Subscribe: pre-flight budget requests ────────────────────────────
    bus.subscribe("budget.request.#", this.name, async (msg: BusMessage) => {
      const req = msg.payload as BudgetRequest;
      if (req?.type !== "budget_request") return;
      await this._handleBudgetRequest(bus, req, msg);
    });

    // ── Subscribe: post-execution actual cost reconciliation ─────────────
    bus.subscribe("budget.actual.#", this.name, (msg: BusMessage) => {
      const actual = msg.payload as BudgetActual;
      if (actual?.type !== "budget_actual") return;
      this._handleActual(actual);
    });

    // ── Periodic metrics check (every 10 minutes) ────────────────────────
    this.metricsTimer = setInterval(() => {
      this._checkMetrics(bus);
    }, 10 * 60 * 1000);

    console.log(
      `[budget] Installed — caps: $${MAX_PROJECT_BUDGET}/project/day, $${MAX_DAILY_BUDGET}/day total`,
    );
  }

  uninstall(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    this.alerter.stop();
    this.tracker.close();
    this.busRef = null;
  }

  // ── Pre-flight handler ────────────────────────────────────────────────────

  private async _handleBudgetRequest(
    bus: EventBus,
    req: BudgetRequest,
    msg: BusMessage,
  ): Promise<void> {
    const { requestId, agentId, projectId, goalId, modelId, promptText } = req;

    // 1. Pre-flight cost estimation
    const estimate = pre_flight_estimate({
      promptText,
      estimatedPromptTokens: req.estimatedPromptTokens,
      estimatedCompletionTokens: req.estimatedCompletionTokens,
      modelId,
    });

    // 2. Budget state snapshot
    const budgetState = this.tracker.getBudgetState(agentId, projectId);

    // 3. Circuit breaker check
    const effectiveGoalId = goalId ?? "default";
    if (!this.circuitBreaker.isAllowed(effectiveGoalId, agentId)) {
      const circuitState = this.circuitBreaker.getState(effectiveGoalId, agentId);
      const decision: BudgetDecision = {
        type: "budget_decision",
        requestId,
        tier: "L3",
        approved: false,
        estimatedCost: estimate.estimatedCost,
        maxCost: estimate.maxCost,
        budgetState,
        reason: `Circuit breaker OPEN for ${effectiveGoalId}:${agentId} since ${new Date(circuitState.openedAt ?? 0).toISOString()}`,
      };

      this._publishDecision(bus, requestId, decision, msg);
      this.metrics.record({
        requestId,
        agentId,
        projectId,
        tier: "L3",
        cost: 0,
        wasEscalated: true,
        wasAutonomous: false,
        timestamp: Date.now(),
      });

      bus.publish(`budget.circuit.open.${effectiveGoalId}:${agentId}`, {
        id: crypto.randomUUID(),
        correlationId: requestId,
        topic: `budget.circuit.open.${effectiveGoalId}:${agentId}`,
        timestamp: Date.now(),
        payload: { type: "circuit_open", key: `${effectiveGoalId}:${agentId}`, circuitState },
      });
      return;
    }

    // 4. Tier routing
    const { tier, reason } = route_by_tier(estimate, budgetState);

    // 5. Record estimated spend in ledger
    const wasEscalated = tier === "L3";
    const wasAutonomous = !wasEscalated;

    this.tracker.recordEstimate({
      requestId,
      agentId,
      projectId,
      goalId,
      tier,
      estimatedCost: estimate.estimatedCost,
      wasEscalated,
      wasAutonomous,
    });

    this.metrics.record({
      requestId,
      agentId,
      projectId,
      tier,
      cost: estimate.estimatedCost,
      wasEscalated,
      wasAutonomous,
      timestamp: Date.now(),
    });

    // 6. Check Discord threshold alerts
    await this.alerter.checkThresholds(budgetState);

    // 7. Build and publish decision
    let decision: BudgetDecision;

    if (tier === "L3") {
      // Build escalation context with cost trail
      const costTrail = this.tracker.getRecentRecords(agentId, projectId, 10);
      const escalationContext: EscalationContext = {
        requestId,
        agentId,
        projectId,
        goalId: goalId ?? null,
        estimatedCost: estimate.estimatedCost,
        maxCost: estimate.maxCost,
        tier,
        escalation_reason: reason,
        cost_trail: costTrail,
        budgetState,
        timestamp: Date.now(),
      };

      decision = {
        type: "budget_decision",
        requestId,
        tier,
        approved: false,
        estimatedCost: estimate.estimatedCost,
        maxCost: estimate.maxCost,
        budgetState,
        escalationContext,
        reason,
      };

      // Publish HITL escalation request
      this._publishHITLEscalation(bus, req, escalationContext, msg);

      // Record circuit failure for budget-exceeded L3 triggers
      if (
        budgetState.remainingProjectBudget <= 0 ||
        budgetState.remainingDailyBudget <= 0
      ) {
        this.circuitBreaker.recordFailure(effectiveGoalId, agentId);
      }
    } else {
      decision = {
        type: "budget_decision",
        requestId,
        tier,
        approved: true,
        estimatedCost: estimate.estimatedCost,
        maxCost: estimate.maxCost,
        budgetState,
        reason,
      };

      // Record circuit success
      this.circuitBreaker.recordSuccess(effectiveGoalId, agentId);

      if (tier === "L1" || tier === "L2") {
        console.warn(`[budget] ${tier} request (${requestId}): ${reason}`);
      }
    }

    this._publishDecision(bus, requestId, decision, msg);
  }

  // ── Post-execution actual cost ────────────────────────────────────────────

  private _handleActual(actual: BudgetActual): void {
    this.tracker.recordActual(actual.requestId, actual.actualCost);

    // Check for discrepancy > 20%
    const recent = this.tracker.getRecentRecords(actual.agentId, actual.projectId, 5);
    const record = recent.find((r) => r.requestId === actual.requestId);

    if (record && record.estimatedCost > 0) {
      const discrepancy = Math.abs(actual.actualCost - record.estimatedCost) / record.estimatedCost;
      if (discrepancy > 0.20) {
        console.warn(
          `[budget] Cost discrepancy >20% for ${actual.requestId}: ` +
            `estimated=$${record.estimatedCost.toFixed(6)}, actual=$${actual.actualCost.toFixed(6)} ` +
            `(${(discrepancy * 100).toFixed(1)}%) — escalating to HITL for review`,
        );

        if (this.busRef) {
          this.busRef.publish("ops.alert.budget", {
            id: crypto.randomUUID(),
            correlationId: actual.requestId,
            topic: "ops.alert.budget",
            timestamp: Date.now(),
            payload: {
              type: "cost_discrepancy",
              requestId: actual.requestId,
              estimated: record.estimatedCost,
              actual: actual.actualCost,
              discrepancyPct: discrepancy * 100,
            },
          });
        }
      }
    }
  }

  // ── Periodic metrics check ────────────────────────────────────────────────

  private _checkMetrics(bus: EventBus): void {
    this.metrics.gc();
    const report = this.metrics.checkAutonomousRateAlert("day");

    if (report) {
      console.warn(report);
      bus.publish("ops.alert.budget", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "ops.alert.budget",
        timestamp: Date.now(),
        payload: {
          type: "autonomous_rate_below_threshold",
          report,
          metrics: this.metrics.compute("day"),
        },
      });
    }
  }

  // ── Publishing helpers ────────────────────────────────────────────────────

  private _publishDecision(
    bus: EventBus,
    requestId: string,
    decision: BudgetDecision,
    originalMsg: BusMessage,
  ): void {
    const topic = `budget.decision.${requestId}`;
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: requestId,
      parentId: originalMsg.id,
      topic,
      timestamp: Date.now(),
      payload: decision,
    });
  }

  private _publishHITLEscalation(
    bus: EventBus,
    req: BudgetRequest,
    ctx: EscalationContext,
    originalMsg: BusMessage,
  ): void {
    const correlationId = req.requestId;
    const topic = `hitl.request.budget.${correlationId}`;

    const costTrailSummary = ctx.cost_trail
      .slice(0, 5)
      .map(
        (r) =>
          `• ${new Date(r.timestamp).toISOString()} | ${r.tier} | $${r.estimatedCost.toFixed(4)} | ${r.wasEscalated ? "escalated" : "auto"}`,
      )
      .join("\n");

    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      parentId: originalMsg.id,
      topic,
      timestamp: Date.now(),
      payload: {
        type: "hitl_request",
        correlationId,
        title: `Budget Escalation — ${ctx.tier} (${req.agentId})`,
        summary: [
          `**Agent:** ${ctx.agentId}`,
          `**Project:** ${ctx.projectId}`,
          `**Goal:** ${ctx.goalId ?? "N/A"}`,
          `**Tier:** ${ctx.tier} — requires approval`,
          `**Estimated cost:** $${ctx.estimatedCost.toFixed(4)}`,
          `**Max cost (conservative):** $${ctx.maxCost.toFixed(4)}`,
          `**Remaining project budget:** $${ctx.budgetState.remainingProjectBudget.toFixed(4)} / $${MAX_PROJECT_BUDGET}`,
          `**Remaining daily budget:** $${ctx.budgetState.remainingDailyBudget.toFixed(4)} / $${MAX_DAILY_BUDGET}`,
          `\n**Escalation reason:** ${ctx.escalation_reason}`,
          costTrailSummary ? `\n**Cost trail (recent):**\n${costTrailSummary}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        escalation_reason: ctx.escalation_reason,
        cost_trail: ctx.cost_trail,
        escalationContext: ctx,
        options: ["approve", "reject"],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min timeout
        replyTopic: `hitl.response.budget.${correlationId}`,
        sourceMeta: originalMsg.source,
      },
    });

    console.log(`[budget] L3 escalation published for ${correlationId} (${req.agentId})`);
  }

  // ── Public accessors (for integration with other plugins) ─────────────────

  getMetrics(period: "day" | "week" | "all" = "day") {
    return this.metrics.compute(period);
  }

  getBudgetState(agentId: string, projectId: string) {
    return this.tracker.getBudgetState(agentId, projectId);
  }

  getCircuitStates() {
    return this.circuitBreaker.allStates();
  }
}

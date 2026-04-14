/**
 * OutcomeAnalysisPlugin — closes the learning loop.
 *
 * Subscribes to world.action.outcome events, tracks per-action success rates
 * and HITL escalation frequency, and emits signals on chronic issues:
 *
 *   - Actions with <50% success rate over 10+ attempts → publishes
 *     ops.alert.action_quality so the fleet knows to investigate/replace it.
 *   - Actions with repeated HITL escalations → treated as feature-request
 *     signals ("what would have unblocked this automatically?") and logged
 *     for Ava to file on the board.
 *
 * This is the "bottlenecks are growth" principle operationalized: the system's
 * own failures become inputs to its own improvement backlog.
 *
 * Inbound:
 *   world.action.outcome  — every action completion
 *   hitl.escalation       — every HITL timeout/exhaustion (per pr-remediator)
 *
 * Outbound:
 *   ops.alert.action_quality   — action with poor success rate
 *   ops.alert.hitl_escalation  — repeated human-needed action
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";

interface ActionStats {
  actionId: string;
  total: number;
  success: number;
  failure: number;
  timeout: number;
  lastEvaluatedAt: number;
  alertedAt?: number;
}

interface HitlStats {
  kind: string;
  target: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  alertedAt?: number;
}

const ANALYSIS_INTERVAL_MS = 5 * 60_000;            // 5 min
const MIN_ATTEMPTS_BEFORE_ALERT = 10;               // don't flag until 10+ runs
const POOR_SUCCESS_THRESHOLD = 0.5;                 // <50% success → alert
const HITL_COUNT_THRESHOLD = 3;                     // 3+ escalations → feature signal
const ALERT_COOLDOWN_MS = 60 * 60_000;              // 1 hour between repeat alerts

export class OutcomeAnalysisPlugin implements Plugin {
  readonly name = "outcome-analysis";
  readonly description = "Analyzes action outcomes to detect chronic failures and escalation patterns";
  readonly capabilities = ["outcome-analysis", "learning"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly actionStats = new Map<string, ActionStats>();
  private readonly hitlStats = new Map<string, HitlStats>();
  private analysisTimer?: ReturnType<typeof setInterval>;

  install(bus: EventBus): void {
    this.bus = bus;

    this.subscriptionIds.push(
      bus.subscribe("world.action.outcome", this.name, (msg) => this._onOutcome(msg)),
    );
    this.subscriptionIds.push(
      bus.subscribe("hitl.escalation", this.name, (msg) => this._onHitlEscalation(msg)),
    );

    this.analysisTimer = setInterval(() => this._runAnalysis(), ANALYSIS_INTERVAL_MS);
    console.log("[outcome-analysis] Installed — analyzing every 5 min");
  }

  uninstall(): void {
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private _onOutcome(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown> | undefined;
    const actionId = typeof p?.actionId === "string" ? p.actionId : undefined;
    if (!actionId) return;

    const success = p?.success === true;
    const error = typeof p?.error === "string" ? p.error : undefined;
    const isTimeout = error?.toLowerCase().includes("timeout") ?? false;

    const stats = this.actionStats.get(actionId) ?? {
      actionId,
      total: 0,
      success: 0,
      failure: 0,
      timeout: 0,
      lastEvaluatedAt: 0,
    };

    stats.total += 1;
    if (success) stats.success += 1;
    else if (isTimeout) stats.timeout += 1;
    else stats.failure += 1;
    stats.lastEvaluatedAt = Date.now();

    this.actionStats.set(actionId, stats);
  }

  private _onHitlEscalation(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown> | undefined;
    const kind = typeof p?.kind === "string" ? p.kind : "unknown";
    const target = typeof p?.target === "string" ? p.target : (typeof p?.prUrl === "string" ? p.prUrl : "unknown");
    const key = `${kind}::${target}`;

    const stats = this.hitlStats.get(key) ?? {
      kind,
      target,
      count: 0,
      firstSeenAt: Date.now(),
      lastSeenAt: 0,
    };
    stats.count += 1;
    stats.lastSeenAt = Date.now();
    this.hitlStats.set(key, stats);
  }

  /** Per-action success rate snapshot, sorted worst-first. Exposed for /api. */
  getActionStats(): Array<ActionStats & { successRate: number }> {
    return Array.from(this.actionStats.values())
      .map(s => ({ ...s, successRate: s.total > 0 ? s.success / s.total : 0 }))
      .sort((a, b) => a.successRate - b.successRate);
  }

  /** HITL escalation clusters, sorted most-frequent first. */
  getHitlStats(): HitlStats[] {
    return Array.from(this.hitlStats.values())
      .sort((a, b) => b.count - a.count);
  }

  private _runAnalysis(): void {
    if (!this.bus) return;
    const now = Date.now();

    // Detect chronically-failing actions
    for (const stats of this.actionStats.values()) {
      if (stats.total < MIN_ATTEMPTS_BEFORE_ALERT) continue;
      const rate = stats.success / stats.total;
      if (rate >= POOR_SUCCESS_THRESHOLD) continue;

      // Cooldown between repeat alerts for the same action
      if (stats.alertedAt && now - stats.alertedAt < ALERT_COOLDOWN_MS) continue;

      stats.alertedAt = now;
      this.bus.publish("ops.alert.action_quality", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "ops.alert.action_quality",
        timestamp: now,
        payload: {
          actionId: stats.actionId,
          successRate: rate,
          total: stats.total,
          success: stats.success,
          failure: stats.failure,
          timeout: stats.timeout,
          recommendation: `Action "${stats.actionId}" succeeded ${stats.success}/${stats.total} times (${(rate * 100).toFixed(0)}%). Consider rewriting preconditions, replacing the skill, or filing a feature to build a better capability.`,
        },
      });
      console.warn(`[outcome-analysis] chronic failure: ${stats.actionId} ${(rate * 100).toFixed(0)}% over ${stats.total} attempts`);
    }

    // Detect HITL escalation patterns (feature-request signals)
    for (const stats of this.hitlStats.values()) {
      if (stats.count < HITL_COUNT_THRESHOLD) continue;
      if (stats.alertedAt && now - stats.alertedAt < ALERT_COOLDOWN_MS) continue;

      stats.alertedAt = now;
      this.bus.publish("ops.alert.hitl_escalation", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "ops.alert.hitl_escalation",
        timestamp: now,
        payload: {
          kind: stats.kind,
          target: stats.target,
          count: stats.count,
          firstSeenAt: stats.firstSeenAt,
          lastSeenAt: stats.lastSeenAt,
          recommendation: `"${stats.kind}" has escalated to HITL ${stats.count} times for ${stats.target}. This is a feature-request signal — what capability would unblock this automatically?`,
        },
      });
      console.warn(`[outcome-analysis] repeated HITL: ${stats.kind} × ${stats.count} for ${stats.target}`);
    }
  }
}

/**
 * OutcomeAnalysisPlugin — closes the learning loop.
 *
 * Subscribes to the unified `autonomous.outcome.#` stream (Arc 2.1 / 2.2),
 * tracks per-skill success rates and HITL escalation frequency, and emits
 * signals on chronic issues:
 *
 *   - Skills with <50% success rate over 10+ attempts → publishes
 *     ops.alert.action_quality so the fleet knows to investigate/replace it,
 *     and emits agent.skill.request { skill: 'goal_proposal' } targeting Ava.
 *   - Skills with repeated HITL escalations → treated as feature-request
 *     signals ("what would have unblocked this automatically?") and emits
 *     agent.skill.request { skill: 'goal_proposal' } targeting Ava.
 *
 * This is the "bottlenecks are growth" principle operationalized: the system's
 * own failures become inputs to its own improvement backlog.
 *
 * Inbound:
 *   autonomous.outcome.#  — unified terminal-state event for every autonomous
 *                           action (GOAP, ceremony, FAF, any skill dispatch).
 *                           Replaces the previous split between
 *                           world.action.outcome and per-reply-topic responses.
 *   hitl.escalation       — every HITL timeout/exhaustion (per pr-remediator)
 *
 * Outbound:
 *   ops.alert.action_quality   — skill with poor success rate
 *   ops.alert.hitl_escalation  — repeated human-needed action
 *   agent.skill.request        — goal_proposal skill request to Ava on threshold breach
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";

interface ActionStats {
  /** Stats key — either a skill name (unified stream) or a legacy actionId. */
  actionId: string;
  /** Autonomous subsystem that dispatched this skill (e.g. "goap", "ceremony"). */
  systemActor?: string;
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

    // Every skill dispatch — GOAP action, ceremony, FAF, user-triggered —
    // produces exactly one event on autonomous.outcome.# when the task reaches
    // terminal state. Single source of truth for outcome clustering.
    this.subscriptionIds.push(
      bus.subscribe("autonomous.outcome.#", this.name, (msg) => this._onAutonomousOutcome(msg)),
    );

    this.subscriptionIds.push(
      bus.subscribe("hitl.escalation", this.name, (msg) => this._onHitlEscalation(msg)),
    );

    this.analysisTimer = setInterval(() => this._runAnalysis(), ANALYSIS_INTERVAL_MS);
    // Don't keep the process alive just for this timer (important for tests).
    this.analysisTimer.unref?.();
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

  /**
   * Handle the autonomous.outcome.# stream. Routes by `skill`, which for
   * GOAP-dispatched actions matches action.id (ActionDispatcher uses
   * `skill: meta.skillHint ?? action.id`), and for ceremonies / user-
   * dispatches uses the skill name directly. systemActor is captured so
   * downstream reporting can slice per subsystem.
   */
  private _onAutonomousOutcome(msg: BusMessage): void {
    const p = msg.payload as AutonomousOutcomePayload | undefined;
    if (!p || typeof p.skill !== "string" || !p.skill) return;

    const preview = typeof p.textPreview === "string" ? p.textPreview.toLowerCase() : "";
    const isTimeout = !p.success && (preview.includes("timeout") || p.taskState === "canceled");

    const stats = this.actionStats.get(p.skill) ?? {
      actionId: p.skill,
      systemActor: p.systemActor,
      total: 0,
      success: 0,
      failure: 0,
      timeout: 0,
      lastEvaluatedAt: 0,
    };

    stats.total += 1;
    if (p.success) stats.success += 1;
    else if (isTimeout) stats.timeout += 1;
    else stats.failure += 1;
    stats.lastEvaluatedAt = Date.now();

    this.actionStats.set(p.skill, stats);
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

      const correlationId = crypto.randomUUID();
      this.bus.publish("agent.skill.request", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "agent.skill.request",
        timestamp: now,
        source: { interface: "outcome-analysis" },
        payload: {
          skill: "goal_proposal",
          targets: ["ava"],
          cluster: {
            type: "action_quality",
            actionId: stats.actionId,
            successRate: rate,
            total: stats.total,
            failures: stats.failure + stats.timeout,
          },
          suggestedGoal: `Investigate and improve action "${stats.actionId}" which has a ${(rate * 100).toFixed(0)}% success rate over ${stats.total} attempts`,
          meta: { systemActor: "outcome-analysis" },
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

      const correlationId = crypto.randomUUID();
      this.bus.publish("agent.skill.request", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "agent.skill.request",
        timestamp: now,
        source: { interface: "outcome-analysis" },
        payload: {
          skill: "goal_proposal",
          targets: ["ava"],
          cluster: {
            type: "hitl_escalation",
            kind: stats.kind,
            target: stats.target,
            count: stats.count,
            firstSeenAt: stats.firstSeenAt,
            lastSeenAt: stats.lastSeenAt,
          },
          suggestedGoal: `Build capability to automate "${stats.kind}" — it has required HITL intervention ${stats.count} times for ${stats.target}`,
          meta: { systemActor: "outcome-analysis" },
        },
      });
      console.warn(`[outcome-analysis] repeated HITL: ${stats.kind} × ${stats.count} for ${stats.target}`);
    }
  }
}

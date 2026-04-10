/**
 * MetricsTracker — tracks autonomous vs escalated request rates.
 *
 * Deviation rule: if autonomous_rate drops below 85% target threshold,
 * generate an escalation_metrics analysis report and notify ops.
 * Do NOT auto-adjust without manual review.
 *
 * Target: 85–90% autonomous operation rate.
 */

import type { BudgetTierLevel, BudgetMetrics } from "../types/budget.ts";

// ── Request event ─────────────────────────────────────────────────────────────

export interface RequestEvent {
  requestId: string;
  agentId: string;
  projectId: string;
  tier: BudgetTierLevel;
  cost: number;
  wasEscalated: boolean;
  wasAutonomous: boolean;
  timestamp: number;
}

// ── MetricsTracker ────────────────────────────────────────────────────────────

export class MetricsTracker {
  private events: RequestEvent[] = [];

  /** Target autonomous rate (85%) */
  static readonly TARGET_AUTONOMOUS_RATE = 0.85;

  // ── Record events ───────────────────────────────────────────────────────────

  record(event: RequestEvent): void {
    this.events.push(event);
  }

  // ── Metrics computation ──────────────────────────────────────────────────

  /**
   * autonomous_rate_calculation: compute metrics for the given period.
   */
  compute(period: "day" | "week" | "all" = "day"): BudgetMetrics {
    const filtered = this._filterByPeriod(period);

    const totalRequests = filtered.length;
    const autonomousRequests = filtered.filter((e) => e.wasAutonomous).length;
    const escalatedRequests = filtered.filter((e) => e.wasEscalated).length;
    const autonomous_rate = totalRequests > 0 ? autonomousRequests / totalRequests : 1.0;
    const totalCost = filtered.reduce((sum, e) => sum + e.cost, 0);
    const averageCost = totalRequests > 0 ? totalCost / totalRequests : 0;

    return {
      totalRequests,
      autonomousRequests,
      escalatedRequests,
      autonomous_rate,
      totalCost,
      averageCost,
      period,
      computedAt: Date.now(),
    };
  }

  /**
   * escalation_metrics: per-tier breakdown.
   */
  tierBreakdown(period: "day" | "week" | "all" = "day"): Record<BudgetTierLevel, number> {
    const filtered = this._filterByPeriod(period);
    const counts: Record<BudgetTierLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const e of filtered) {
      counts[e.tier] = (counts[e.tier] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Check if autonomous_rate is below the 85% target and return a diagnostic
   * report if so. Returns null if the rate is healthy.
   */
  checkAutonomousRateAlert(period: "day" | "week" | "all" = "day"): string | null {
    const metrics = this.compute(period);

    if (metrics.autonomous_rate < MetricsTracker.TARGET_AUTONOMOUS_RATE) {
      const tiers = this.tierBreakdown(period);
      const report = [
        `[metrics] AUTONOMOUS RATE ALERT: ${(metrics.autonomous_rate * 100).toFixed(1)}% < target ${MetricsTracker.TARGET_AUTONOMOUS_RATE * 100}%`,
        `Period: ${period}`,
        `Total requests: ${metrics.totalRequests}`,
        `Autonomous: ${metrics.autonomousRequests} (${(metrics.autonomous_rate * 100).toFixed(1)}%)`,
        `Escalated: ${metrics.escalatedRequests}`,
        `Tier breakdown: L0=${tiers.L0}, L1=${tiers.L1}, L2=${tiers.L2}, L3=${tiers.L3}`,
        `Total cost: $${metrics.totalCost.toFixed(4)}`,
        `Action required: Review tier assignments and circuit breaker sensitivity. Do NOT auto-adjust.`,
      ].join("\n");

      return report;
    }

    return null;
  }

  // ── Per-agent / per-project metrics ──────────────────────────────────────

  perAgent(period: "day" | "week" | "all" = "day"): Map<string, BudgetMetrics> {
    const filtered = this._filterByPeriod(period);
    const byAgent = new Map<string, RequestEvent[]>();

    for (const e of filtered) {
      const list = byAgent.get(e.agentId) ?? [];
      list.push(e);
      byAgent.set(e.agentId, list);
    }

    const result = new Map<string, BudgetMetrics>();
    for (const [agentId, events] of byAgent) {
      const totalRequests = events.length;
      const autonomousRequests = events.filter((e) => e.wasAutonomous).length;
      const escalatedRequests = events.filter((e) => e.wasEscalated).length;
      const autonomous_rate = totalRequests > 0 ? autonomousRequests / totalRequests : 1.0;
      const totalCost = events.reduce((sum, e) => sum + e.cost, 0);
      result.set(agentId, {
        totalRequests,
        autonomousRequests,
        escalatedRequests,
        autonomous_rate,
        totalCost,
        averageCost: totalRequests > 0 ? totalCost / totalRequests : 0,
        period,
        computedAt: Date.now(),
      });
    }
    return result;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _filterByPeriod(period: "day" | "week" | "all"): RequestEvent[] {
    if (period === "all") return this.events;

    const now = Date.now();
    const windowMs = period === "day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return this.events.filter((e) => now - e.timestamp <= windowMs);
  }

  /** Trim events older than 7 days to prevent unbounded memory growth */
  gc(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }
}

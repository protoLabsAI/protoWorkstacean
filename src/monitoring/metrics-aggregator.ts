/**
 * MetricsAggregator — combines L2 metrics and escalation tracking
 * into a unified view for dashboards and reporting.
 */

import { L2Metrics, type L2MetricsSummary } from "./l2-metrics.ts";
import { EscalationTracker, type EscalationTrend } from "./escalation-tracker.ts";
import type { RegistryStats } from "../learning/rule-registry.ts";
import { RuleRegistry } from "../learning/rule-registry.ts";

/** Complete system health snapshot. */
export interface SystemHealthSnapshot {
  timestamp: number;
  l2Metrics: L2MetricsSummary;
  escalationCounts: Record<string, number>;
  escalationTrend: EscalationTrend[];
  ruleRegistryStats: RegistryStats;
  /** Whether the system is improving (escalation rate decreasing). */
  isImproving: boolean;
}

export class MetricsAggregator {
  constructor(
    private l2Metrics: L2Metrics,
    private escalationTracker: EscalationTracker,
    private ruleRegistry: RuleRegistry,
  ) {}

  /**
   * Generate a complete system health snapshot.
   */
  getSnapshot(windowMs?: number): SystemHealthSnapshot {
    const l2Summary = this.l2Metrics.getSummary(windowMs);
    const escalationCounts = this.escalationTracker.getCounts(windowMs);
    const escalationTrend = this.escalationTracker.getTrend();
    const registryStats = this.ruleRegistry.getStats();

    return {
      timestamp: Date.now(),
      l2Metrics: l2Summary,
      escalationCounts,
      escalationTrend,
      ruleRegistryStats: registryStats,
      isImproving: this.checkImprovement(escalationTrend),
    };
  }

  /**
   * Check if escalation rate is trending downward.
   */
  private checkImprovement(trend: EscalationTrend[]): boolean {
    if (trend.length < 2) return false;

    const recent = trend.slice(-3);
    const earlier = trend.slice(-6, -3);

    if (earlier.length === 0) return false;

    const recentAvg = recent.reduce((s, t) => s + t.l2ToL3Rate, 0) / recent.length;
    const earlierAvg = earlier.reduce((s, t) => s + t.l2ToL3Rate, 0) / earlier.length;

    return recentAvg < earlierAvg;
  }
}

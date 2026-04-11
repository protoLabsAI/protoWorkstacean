/**
 * SuccessMetrics — measures learning flywheel effectiveness.
 *
 * Tracks how well the system is converting L2 successes into L0 rules
 * and whether that is actually reducing escalation rates.
 */

import type { RuleRegistry, RegistryStats } from "./rule-registry.ts";
import type { L2Metrics, } from "../monitoring/l2-metrics.ts";
import type { EscalationTracker } from "../monitoring/escalation-tracker.ts";

/** Flywheel health metrics. */
export interface FlywheelMetrics {
  /** Rules learned over the time window. */
  rulesLearned: number;
  /** Rules promoted to L0. */
  rulesPromoted: number;
  /** Ratio of L0 hits to total requests (higher = flywheel working). */
  l0HitRate: number;
  /** Escalation rate trend (negative = improving). */
  escalationRateDelta: number;
  /** Overall flywheel health score (0–1). */
  healthScore: number;
}

export class SuccessMetrics {
  constructor(
    private ruleRegistry: RuleRegistry,
    private l2Metrics: L2Metrics,
    private escalationTracker: EscalationTracker,
  ) {}

  /**
   * Compute flywheel effectiveness metrics.
   */
  compute(windowMs?: number): FlywheelMetrics {
    const registryStats = this.ruleRegistry.getStats();
    const l2Summary = this.l2Metrics.getSummary(windowMs);
    const escalationTrend = this.escalationTracker.getTrend();

    const l0Hits = l2Summary.layerDistribution["l0"] ?? 0;
    const totalRequests = l2Summary.totalInvocations;
    const l0HitRate = totalRequests > 0 ? l0Hits / totalRequests : 0;

    const escalationRateDelta = this.computeEscalationDelta(escalationTrend);

    return {
      rulesLearned: registryStats.totalRules,
      rulesPromoted: registryStats.promotedRules,
      l0HitRate,
      escalationRateDelta,
      healthScore: this.computeHealthScore(l0HitRate, escalationRateDelta, registryStats),
    };
  }

  /**
   * Compute the change in escalation rate (negative = improvement).
   */
  private computeEscalationDelta(trend: Array<{ l2ToL3Rate: number }>): number {
    if (trend.length < 2) return 0;

    const recent = trend.slice(-3);
    const earlier = trend.slice(-6, -3);

    if (earlier.length === 0) return 0;

    const recentAvg = recent.reduce((s, t) => s + t.l2ToL3Rate, 0) / recent.length;
    const earlierAvg = earlier.reduce((s, t) => s + t.l2ToL3Rate, 0) / earlier.length;

    return recentAvg - earlierAvg;
  }

  /**
   * Compute overall health score (0–1).
   */
  private computeHealthScore(
    l0HitRate: number,
    escalationDelta: number,
    registryStats: RegistryStats,
  ): number {
    // Weighted composite:
    // - 40% L0 hit rate (higher = better)
    // - 30% escalation improvement (negative delta = better)
    // - 30% rule quality (avg success rate of learned rules)
    const hitScore = l0HitRate;
    const escalationScore = Math.max(0, 1.0 - Math.abs(escalationDelta));
    const qualityScore = registryStats.avgSuccessRate;

    return 0.4 * hitScore + 0.3 * escalationScore + 0.3 * qualityScore;
  }
}

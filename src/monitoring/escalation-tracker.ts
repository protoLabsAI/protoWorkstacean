/**
 * EscalationTracker — tracks escalation events across all planner layers.
 *
 * Monitors the escalation pipeline: L0→L1→L2→L3 and tracks whether
 * the learning flywheel is reducing escalation rates over time.
 */

/** An escalation event. */
export interface EscalationEvent {
  id: string;
  timestamp: number;
  fromLayer: "l0" | "l1" | "l2";
  toLayer: "l1" | "l2" | "l3";
  goalPattern: string;
  reason: string;
  correlationId: string;
  /** Whether a learned rule could have handled this (retroactive check). */
  learnedRuleAvailable?: boolean;
}

/** Escalation trend data point. */
export interface EscalationTrend {
  timestamp: number;
  l0ToL1Rate: number;
  l1ToL2Rate: number;
  l2ToL3Rate: number;
  overallEscalationRate: number;
}

export class EscalationTracker {
  private events: EscalationEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents: number = 5000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Record an escalation event.
   */
  record(event: EscalationEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /**
   * Get escalation counts for a time window.
   */
  getCounts(windowMs?: number): Record<string, number> {
    const cutoff = windowMs ? Date.now() - windowMs : 0;
    const filtered = this.events.filter((e) => e.timestamp >= cutoff);

    const counts: Record<string, number> = {
      l0_to_l1: 0,
      l1_to_l2: 0,
      l2_to_l3: 0,
      total: filtered.length,
    };

    for (const e of filtered) {
      const key = `${e.fromLayer}_to_${e.toLayer}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    return counts;
  }

  /**
   * Compute escalation rate trend over time.
   */
  getTrend(bucketMs: number = 3600_000): EscalationTrend[] {
    if (this.events.length === 0) return [];

    const minTs = this.events[0].timestamp;
    const maxTs = this.events[this.events.length - 1].timestamp;
    const trends: EscalationTrend[] = [];

    for (let t = minTs; t <= maxTs; t += bucketMs) {
      const end = t + bucketMs;
      const bucket = this.events.filter((e) => e.timestamp >= t && e.timestamp < end);

      if (bucket.length === 0) continue;

      const l0l1 = bucket.filter((e) => e.fromLayer === "l0" && e.toLayer === "l1").length;
      const l1l2 = bucket.filter((e) => e.fromLayer === "l1" && e.toLayer === "l2").length;
      const l2l3 = bucket.filter((e) => e.fromLayer === "l2" && e.toLayer === "l3").length;

      trends.push({
        timestamp: t,
        l0ToL1Rate: l0l1 / bucket.length,
        l1ToL2Rate: l1l2 / bucket.length,
        l2ToL3Rate: l2l3 / bucket.length,
        overallEscalationRate: bucket.length > 0 ? 1 : 0,
      });
    }

    return trends;
  }

  /**
   * Get the most common escalation reasons.
   */
  getTopReasons(limit: number = 10): Array<{ reason: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of this.events) {
      counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /** Get all events. */
  getEvents(): readonly EscalationEvent[] {
    return this.events;
  }

  /** Clear all events. */
  clear(): void {
    this.events.length = 0;
  }
}

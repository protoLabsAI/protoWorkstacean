/**
 * L2Metrics — telemetry for L2 planner invocations and outcomes.
 *
 * Tracks: invocation rate, success rate, confidence distribution,
 * plan quality metrics, and latency.
 */

/** A single L2 invocation record. */
export interface L2InvocationRecord {
  planId: string;
  timestamp: number;
  success: boolean;
  confidence: number;
  escalatedToL3: boolean;
  latencyMs: number;
  candidateCount: number;
  planActionCount: number;
  planCost: number;
  /** Which layer ultimately handled the request. */
  handledBy: "l0" | "l1" | "l2" | "l3";
}

/** Aggregated metrics over a time window. */
export interface L2MetricsSummary {
  totalInvocations: number;
  successCount: number;
  failureCount: number;
  l3EscalationCount: number;
  successRate: number;
  escalationRate: number;
  avgConfidence: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  confidenceDistribution: { bucket: string; count: number }[];
  /** Breakdown by handling layer. */
  layerDistribution: Record<string, number>;
}

export class L2Metrics {
  private records: L2InvocationRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords: number = 10000) {
    this.maxRecords = maxRecords;
  }

  /**
   * Record an L2 invocation.
   */
  record(entry: L2InvocationRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  /**
   * Get summary metrics for a time window.
   */
  getSummary(windowMs?: number): L2MetricsSummary {
    const cutoff = windowMs ? Date.now() - windowMs : 0;
    const filtered = this.records.filter((r) => r.timestamp >= cutoff);

    if (filtered.length === 0) {
      return this.emptySummary();
    }

    const successCount = filtered.filter((r) => r.success).length;
    const escalationCount = filtered.filter((r) => r.escalatedToL3).length;
    const latencies = filtered.map((r) => r.latencyMs).sort((a, b) => a - b);

    return {
      totalInvocations: filtered.length,
      successCount,
      failureCount: filtered.length - successCount,
      l3EscalationCount: escalationCount,
      successRate: successCount / filtered.length,
      escalationRate: escalationCount / filtered.length,
      avgConfidence: filtered.reduce((s, r) => s + r.confidence, 0) / filtered.length,
      avgLatencyMs: latencies.reduce((s, l) => s + l, 0) / latencies.length,
      p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
      confidenceDistribution: this.buildConfidenceDistribution(filtered),
      layerDistribution: this.buildLayerDistribution(filtered),
    };
  }

  /**
   * Get the escalation rate trend over time (bucketed by interval).
   */
  getEscalationTrend(bucketMs: number = 3600_000): Array<{ timestamp: number; escalationRate: number }> {
    if (this.records.length === 0) return [];

    const minTs = this.records[0].timestamp;
    const maxTs = this.records[this.records.length - 1].timestamp;
    const buckets: Array<{ timestamp: number; total: number; escalated: number }> = [];

    for (let t = minTs; t <= maxTs; t += bucketMs) {
      buckets.push({ timestamp: t, total: 0, escalated: 0 });
    }

    for (const record of this.records) {
      const idx = Math.min(
        Math.floor((record.timestamp - minTs) / bucketMs),
        buckets.length - 1,
      );
      if (idx >= 0 && idx < buckets.length) {
        buckets[idx].total++;
        if (record.escalatedToL3) buckets[idx].escalated++;
      }
    }

    return buckets
      .filter((b) => b.total > 0)
      .map((b) => ({
        timestamp: b.timestamp,
        escalationRate: b.escalated / b.total,
      }));
  }

  /** Get all raw records. */
  getRecords(): readonly L2InvocationRecord[] {
    return this.records;
  }

  /** Clear all records. */
  clear(): void {
    this.records.length = 0;
  }

  private buildConfidenceDistribution(records: L2InvocationRecord[]): { bucket: string; count: number }[] {
    const buckets = new Map<string, number>();
    for (const r of records) {
      const bucket = `${(Math.floor(r.confidence * 10) / 10).toFixed(1)}-${((Math.floor(r.confidence * 10) + 1) / 10).toFixed(1)}`;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    return Array.from(buckets.entries()).map(([bucket, count]) => ({ bucket, count }));
  }

  private buildLayerDistribution(records: L2InvocationRecord[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const r of records) {
      dist[r.handledBy] = (dist[r.handledBy] ?? 0) + 1;
    }
    return dist;
  }

  private emptySummary(): L2MetricsSummary {
    return {
      totalInvocations: 0,
      successCount: 0,
      failureCount: 0,
      l3EscalationCount: 0,
      successRate: 0,
      escalationRate: 0,
      avgConfidence: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      confidenceDistribution: [],
      layerDistribution: {},
    };
  }
}

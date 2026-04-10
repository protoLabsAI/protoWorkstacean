/**
 * FlowMonitorPlugin — continuous collection of 5 Flow Framework metrics.
 *
 * Metrics collected:
 *   1. Velocity     — items completed per period (daily/weekly/monthly)
 *   2. Lead Time    — creation-to-production duration, p50/p85/p95 percentiles
 *   3. Efficiency   — active/total ratio with ≥35% target threshold
 *   4. Load (WIP)   — WIP count per stage with Little's Law enforcement
 *   5. Distribution — feature/defect/risk/debt ratio across all items
 *
 * Additional capabilities:
 *   - WIP limit enforcement (Little's Law: Lead Time = WIP ÷ Throughput)
 *   - Bottleneck detection via Theory of Constraints (longest accumulation time)
 *   - Goal wiring: flow.efficiency_healthy, flow.distribution_balanced
 *
 * Inbound topics:
 *   flow.item.created       — register a new work item
 *   flow.item.updated       — update item status/stage
 *   flow.item.completed     — mark item complete (production)
 *   flow.item.dispatch      — request to dispatch new work (WIP gating)
 *   tool.flow.metrics.get   — query current metrics (bus-based)
 *   mcp.tool.get_flow_metrics — MCP tool invocation
 *
 * Outbound topics:
 *   event.flow.metrics.updated     — emitted after each metric tick
 *   event.flow.wip_exceeded        — when Little's Law WIP limit breached
 *   event.flow.bottleneck.detected — when a significant bottleneck is found
 *   event.flow.goal.updated        — when goal state changes
 *   event.flow.efficiency.debug    — DEBUG log when efficiency < 35%
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import type {
  FlowItem,
  FlowItemType,
  FlowItemStatus,
  FlowMetrics,
  VelocityMetricState,
  VelocityDataPoint,
  LeadTimeMetricState,
  EfficiencyMetricState,
  LoadMetricState,
  WIPLimitResult,
  DistributionMetricState,
  BottleneckDetectionResult,
  StageAccumulation,
  FlowGoalState,
  GoalStatus,
} from "../types/flow-monitor.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const EFFICIENCY_TARGET = 0.35;
const MIN_LEAD_TIME_SAMPLES = 5;
const METRIC_TICK_INTERVAL_MS = 60_000; // 1 minute
const VELOCITY_PERIOD_MS = 24 * 60 * 60 * 1000; // 1 day
const VELOCITY_HISTORY_PERIODS = 30;
const WIP_LIMIT_MULTIPLIER = 1.5; // Allow up to 1.5× calculated WIP limit
const BOTTLENECK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h avg dwell = bottleneck

// Recommended distribution ratios
const RECOMMENDED_DISTRIBUTION: Record<FlowItemType, number> = {
  feature: 0.4,
  defect: 0.3,
  risk: 0.15,
  debt: 0.15,
};

// ── FlowMonitorPlugin ─────────────────────────────────────────────────────────

export class FlowMonitorPlugin implements Plugin {
  readonly name = "flow-monitor";
  readonly description =
    "Continuous Flow Framework metrics: Velocity, Lead Time, Efficiency (≥35%), " +
    "WIP Load, Distribution. Little's Law WIP limits. Theory of Constraints bottleneck detection.";
  readonly capabilities = [
    "flow_metrics",
    "wip_enforcement",
    "bottleneck_detection",
    "goal_wiring",
  ];

  private bus?: EventBus;
  private subscriptionIds: string[] = [];
  private metricTimer?: ReturnType<typeof setInterval>;

  // Work item registry
  private items = new Map<string, FlowItem>();
  // Wait queue for items held back due to WIP limit
  private waitQueue: string[] = [];

  // Cached metric state
  private metrics: FlowMetrics = this._emptyMetrics();
  private goalState: FlowGoalState = {
    "flow.efficiency_healthy": "pending",
    "flow.distribution_balanced": "pending",
    lastEvaluatedAt: 0,
  };

  install(bus: EventBus): void {
    this.bus = bus;

    // Subscribe to work item lifecycle events
    const subCreate = bus.subscribe("flow.item.created", this.name, (msg) => {
      this._handleItemCreated(msg);
    });
    const subUpdate = bus.subscribe("flow.item.updated", this.name, (msg) => {
      this._handleItemUpdated(msg);
    });
    const subComplete = bus.subscribe("flow.item.completed", this.name, (msg) => {
      this._handleItemCompleted(msg);
    });
    const subDispatch = bus.subscribe("flow.item.dispatch", this.name, (msg) => {
      this._handleDispatch(msg);
    });

    // Subscribe to metric query topics
    const subQuery = bus.subscribe("tool.flow.metrics.get", this.name, async (msg) => {
      await this._handleMetricsQuery(msg);
    });
    const subMCP = bus.subscribe("mcp.tool.get_flow_metrics", this.name, async (msg) => {
      await this._handleMetricsQuery(msg);
    });

    this.subscriptionIds.push(subCreate, subUpdate, subComplete, subDispatch, subQuery, subMCP);

    // Start continuous metric collection ticker
    this.metricTimer = setInterval(() => {
      this._tickMetrics();
    }, METRIC_TICK_INTERVAL_MS);

    // Initial tick to populate metrics immediately
    this._tickMetrics();

    console.log(
      `[flow-monitor] Plugin installed — metric tick every ${METRIC_TICK_INTERVAL_MS / 1000}s`,
    );
  }

  uninstall(): void {
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
      this.metricTimer = undefined;
    }

    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];

    console.log("[flow-monitor] Plugin uninstalled");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns current flow metrics snapshot. */
  getMetrics(options?: { metric?: keyof FlowMetrics }): FlowMetrics | FlowMetrics[keyof FlowMetrics] {
    if (options?.metric) {
      return this.metrics[options.metric];
    }
    return this.metrics;
  }

  /** Returns the MCP tool descriptor for get_flow_metrics. */
  getMCPTool(): MCPToolDescriptor {
    return createGetFlowMetricsTool(this);
  }

  /** Register a work item externally (for testing or direct integration). */
  registerItem(item: FlowItem): void {
    this.items.set(item.id, { ...item });
    this._tickMetrics();
  }

  /** Update a work item externally. */
  updateItem(id: string, updates: Partial<FlowItem>): void {
    const item = this.items.get(id);
    if (!item) return;
    Object.assign(item, updates);
    this._tickMetrics();
  }

  // ── Inbound event handlers ─────────────────────────────────────────────────

  private _handleItemCreated(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : crypto.randomUUID();
    const type = this._parseItemType(p.type);
    const stage = typeof p.stage === "string" ? p.stage : "backlog";

    const item: FlowItem = {
      id,
      type,
      status: "queued",
      stage,
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
      meta: typeof p.meta === "object" && p.meta !== null ? (p.meta as Record<string, unknown>) : undefined,
    };

    this.items.set(id, item);
    console.log(`[flow-monitor] Item created: ${id} (${type}, stage: ${stage})`);
    this._tickMetrics();
  }

  private _handleItemUpdated(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : undefined;
    if (!id) return;

    const item = this.items.get(id);
    if (!item) {
      console.warn(`[flow-monitor] item.updated for unknown id: ${id}`);
      return;
    }

    const prevStatus = item.status;

    if (typeof p.status === "string") {
      item.status = this._parseItemStatus(p.status);
    }
    if (typeof p.stage === "string") {
      item.stage = p.stage;
    }

    // Track when active work begins
    if (prevStatus !== "active" && item.status === "active" && !item.startedAt) {
      item.startedAt = typeof p.startedAt === "number" ? p.startedAt : Date.now();
    }

    console.log(`[flow-monitor] Item updated: ${id} → status=${item.status}, stage=${item.stage}`);
    this._tickMetrics();
  }

  private _handleItemCompleted(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : undefined;
    if (!id) return;

    const item = this.items.get(id);
    if (!item) {
      console.warn(`[flow-monitor] item.completed for unknown id: ${id}`);
      return;
    }

    item.status = "complete";
    item.completedAt = typeof p.completedAt === "number" ? p.completedAt : Date.now();
    if (!item.startedAt) {
      item.startedAt = item.completedAt;
    }

    // Remove from wait queue if present
    const waitIdx = this.waitQueue.indexOf(id);
    if (waitIdx !== -1) {
      this.waitQueue.splice(waitIdx, 1);
    }

    console.log(`[flow-monitor] Item completed: ${id} — lead time: ${item.completedAt - item.createdAt}ms`);
    this._tickMetrics();
  }

  private _handleDispatch(msg: BusMessage): void {
    const p = msg.payload as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : undefined;

    // Calculate current WIP limit using Little's Law
    const wipResult = this._calculateWIPLimit();

    if (wipResult.state === "exceeded" && id) {
      // Queue in wait state instead of rejecting
      const item = this.items.get(id);
      if (item) {
        item.status = "wait";
      }
      if (!this.waitQueue.includes(id)) {
        this.waitQueue.push(id);
      }

      const replyTopic = msg.reply?.topic;
      if (replyTopic && this.bus) {
        this.bus.publish(replyTopic, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: replyTopic,
          timestamp: Date.now(),
          payload: {
            accepted: false,
            reason: "WIP_EXCEEDED",
            currentWIP: wipResult.currentWIP,
            wipLimit: wipResult.wipLimit,
            suggestedDelayMs: wipResult.suggestedDelayMs,
            queuePosition: this.waitQueue.length,
          },
        });
      }

      this._emitWIPExceeded(wipResult);
      console.warn(
        `[flow-monitor] WIP_EXCEEDED — item ${id} queued. ` +
        `Current WIP: ${wipResult.currentWIP}, limit: ${wipResult.wipLimit}`,
      );
      return;
    }

    // Accept the item
    const replyTopic = msg.reply?.topic;
    if (replyTopic && this.bus) {
      this.bus.publish(replyTopic, {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: {
          accepted: true,
          currentWIP: wipResult.currentWIP,
          wipLimit: wipResult.wipLimit,
        },
      });
    }
  }

  private async _handleMetricsQuery(msg: BusMessage): Promise<void> {
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const metric = typeof p.metric === "string" ? (p.metric as keyof FlowMetrics) : undefined;

    const result = this.getMetrics({ metric });
    const replyTopic = msg.reply?.topic;
    if (!replyTopic || !this.bus) return;

    this.bus.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { success: true, data: result },
    });
  }

  // ── Metric tick (main computation cycle) ──────────────────────────────────

  private _tickMetrics(): void {
    const now = Date.now();

    const velocity = this._computeVelocity(now);
    const leadTime = this._computeLeadTime(now);
    const efficiency = this._computeEfficiency(now);
    const load = this._computeLoad(now);
    const distribution = this._computeDistribution(now);
    const bottleneck = this._detectBottleneck(now);

    this.metrics = {
      velocity,
      leadTime,
      efficiency,
      load,
      distribution,
      bottleneck,
      collectedAt: now,
    };

    // Check goals and emit changes
    this._evaluateGoals(efficiency, distribution);

    // Emit metrics update event
    if (this.bus) {
      this.bus.publish("event.flow.metrics.updated", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "event.flow.metrics.updated",
        timestamp: now,
        payload: this.metrics,
      });
    }

    // Bottleneck alert
    if (bottleneck.hasBottleneck && bottleneck.primaryBottleneck) {
      this._emitBottleneckDetected(bottleneck);
    }

    // Efficiency debug log when below target
    if (!efficiency.healthy) {
      console.debug(
        `[flow-monitor] Efficiency ${(efficiency.ratio * 100).toFixed(1)}% < target ${(EFFICIENCY_TARGET * 100).toFixed(0)}%. ` +
        `Bottleneck candidates: ${bottleneck.rankedStages.slice(0, 3).map(s => s.stage).join(", ")}`,
      );
      this._emitEfficiencyDebug(efficiency, bottleneck);
    }
  }

  // ── Velocity metric computation ────────────────────────────────────────────

  private _computeVelocity(now: number): VelocityMetricState {
    const periodMs = VELOCITY_PERIOD_MS;
    const completedItems = Array.from(this.items.values()).filter(
      (item) => item.status === "complete" && item.completedAt !== undefined,
    );

    // Build period buckets going back VELOCITY_HISTORY_PERIODS days
    const history: VelocityDataPoint[] = [];
    for (let i = VELOCITY_HISTORY_PERIODS - 1; i >= 0; i--) {
      const periodEnd = now - i * periodMs;
      const periodStart = periodEnd - periodMs;

      // Use <= for the current period (i === 0) so items completed at exactly "now" are included
      const inPeriod = completedItems.filter(
        (item) => item.completedAt! >= periodStart && item.completedAt! <= periodEnd,
      );

      const byType: Partial<Record<FlowItemType, number>> = {};
      for (const item of inPeriod) {
        byType[item.type] = (byType[item.type] ?? 0) + 1;
      }

      history.push({ periodStart, periodEnd, count: inPeriod.length, byType });
    }

    const counts = history.map((h) => h.count);
    const currentPeriodCount = history[history.length - 1]?.count ?? 0;
    const rollingAverage = counts.length > 0
      ? counts.reduce((a, b) => a + b, 0) / counts.length
      : 0;

    // Trend: compare last 3 periods vs prior 3 periods
    const trend = this._computeVelocityTrend(counts);

    return {
      currentPeriodCount,
      rollingAverage,
      trend,
      history,
      period: "daily",
      calculatedAt: now,
    };
  }

  private _computeVelocityTrend(counts: number[]): number {
    if (counts.length < 6) return 0;
    const recent = counts.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prior = counts.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
    return prior === 0 ? 0 : (recent - prior) / prior;
  }

  // ── Lead Time metric computation ───────────────────────────────────────────

  private _computeLeadTime(now: number): LeadTimeMetricState {
    const completed = Array.from(this.items.values()).filter(
      (item) =>
        item.status === "complete" &&
        item.completedAt !== undefined &&
        item.createdAt !== undefined,
    );

    if (completed.length < MIN_LEAD_TIME_SAMPLES) {
      return {
        p50Ms: null,
        p85Ms: null,
        p95Ms: null,
        sampleSize: completed.length,
        state: "PENDING",
        minRequired: MIN_LEAD_TIME_SAMPLES,
        calculatedAt: now,
      };
    }

    const durations = completed
      .map((item) => item.completedAt! - item.createdAt)
      .sort((a, b) => a - b);

    return {
      p50Ms: this._percentile(durations, 0.5),
      p85Ms: this._percentile(durations, 0.85),
      p95Ms: this._percentile(durations, 0.95),
      sampleSize: durations.length,
      state: "READY",
      minRequired: MIN_LEAD_TIME_SAMPLES,
      calculatedAt: now,
    };
  }

  private _percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // ── Efficiency metric computation ──────────────────────────────────────────

  private _computeEfficiency(now: number): EfficiencyMetricState {
    const activeItems = Array.from(this.items.values()).filter(
      (item) => item.status === "active" || item.status === "complete",
    );

    const byStage: Record<string, { activeMs: number; cycleMs: number; ratio: number }> = {};
    let totalActiveMs = 0;
    let totalCycleMs = 0;

    for (const item of activeItems) {
      const cycleStart = item.createdAt;
      const cycleEnd = item.completedAt ?? now;
      const activeStart = item.startedAt ?? cycleEnd;
      const activeEnd = item.completedAt ?? now;

      const cycleMs = Math.max(0, cycleEnd - cycleStart);
      const activeMs = Math.max(0, activeEnd - activeStart);

      totalCycleMs += cycleMs;
      totalActiveMs += activeMs;

      const stage = item.stage;
      if (!byStage[stage]) {
        byStage[stage] = { activeMs: 0, cycleMs: 0, ratio: 0 };
      }
      byStage[stage].activeMs += activeMs;
      byStage[stage].cycleMs += cycleMs;
    }

    // Compute per-stage ratios
    for (const stage of Object.keys(byStage)) {
      const s = byStage[stage];
      s.ratio = s.cycleMs > 0 ? s.activeMs / s.cycleMs : 0;
    }

    const ratio = totalCycleMs > 0 ? totalActiveMs / totalCycleMs : 0;
    const healthy = ratio >= EFFICIENCY_TARGET;

    return {
      ratio,
      target: EFFICIENCY_TARGET,
      healthy,
      totalActiveMs,
      totalCycleMs,
      byStage,
      calculatedAt: now,
    };
  }

  // ── Load (WIP) metric computation ──────────────────────────────────────────

  private _computeLoad(now: number): LoadMetricState {
    const activeItems = Array.from(this.items.values()).filter(
      (item) => item.status === "active" || item.status === "queued" || item.status === "blocked",
    );

    const byStage: Record<string, number> = {};
    for (const item of activeItems) {
      byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;
    }

    const wipResult = this._calculateWIPLimit();

    return {
      totalWIP: activeItems.length,
      byStage,
      wipLimit: wipResult,
      calculatedAt: now,
    };
  }

  private _calculateWIPLimit(): WIPLimitResult {
    const activeItems = Array.from(this.items.values()).filter(
      (item) => item.status === "active" || item.status === "queued" || item.status === "blocked",
    );
    const currentWIP = activeItems.length;

    const leadTime = this.metrics.leadTime;
    const velocity = this.metrics.velocity;

    // Not enough data to calculate WIP limit
    if (leadTime.state === "PENDING" || leadTime.p50Ms === null || velocity.rollingAverage === 0) {
      return {
        state: "PENDING",
        currentWIP,
        wipLimit: null,
        waitQueue: [...this.waitQueue],
      };
    }

    // Little's Law: WIP = Throughput × Lead Time
    // throughputPerMs = items completed per ms (daily avg / ms per day)
    const throughputPerMs = velocity.rollingAverage / VELOCITY_PERIOD_MS;
    const calculatedWIP = Math.ceil(throughputPerMs * leadTime.p50Ms);
    const wipLimit = Math.max(1, Math.ceil(calculatedWIP * WIP_LIMIT_MULTIPLIER));

    const exceeded = currentWIP > wipLimit;
    const suggestedDelayMs = exceeded
      ? Math.ceil((currentWIP - wipLimit) * (leadTime.p50Ms / Math.max(1, currentWIP)))
      : undefined;

    return {
      state: exceeded ? "exceeded" : "ok",
      currentWIP,
      wipLimit,
      suggestedDelayMs,
      waitQueue: [...this.waitQueue],
    };
  }

  // ── Distribution metric computation ───────────────────────────────────────

  private _computeDistribution(now: number): DistributionMetricState {
    const activeItems = Array.from(this.items.values()).filter(
      (item) => item.status !== "complete",
    );

    const counts: Record<FlowItemType, number> = {
      feature: 0,
      defect: 0,
      risk: 0,
      debt: 0,
    };

    for (const item of activeItems) {
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    const ratios: Record<FlowItemType, number> = {
      feature: total > 0 ? counts.feature / total : 0,
      defect: total > 0 ? counts.defect / total : 0,
      risk: total > 0 ? counts.risk / total : 0,
      debt: total > 0 ? counts.debt / total : 0,
    };

    // Distribution is balanced if feature ≥ 40% and defect ≤ 30%
    const balanced = total > 0 &&
      ratios.feature >= RECOMMENDED_DISTRIBUTION.feature &&
      ratios.defect <= RECOMMENDED_DISTRIBUTION.defect;

    if (!balanced && total > 0) {
      console.warn(
        `[flow-monitor] distribution_imbalance — ` +
        `feature=${(ratios.feature * 100).toFixed(1)}% (rec ≥${RECOMMENDED_DISTRIBUTION.feature * 100}%), ` +
        `defect=${(ratios.defect * 100).toFixed(1)}% (rec ≤${RECOMMENDED_DISTRIBUTION.defect * 100}%)`,
      );
    }

    return {
      ratios,
      counts,
      total,
      balanced,
      recommended: { ...RECOMMENDED_DISTRIBUTION },
      calculatedAt: now,
    };
  }

  // ── Bottleneck detection (Theory of Constraints) ───────────────────────────

  private _detectBottleneck(now: number): BottleneckDetectionResult {
    const activeItems = Array.from(this.items.values()).filter(
      (item) => item.status === "active" || item.status === "queued" || item.status === "blocked",
    );

    const stageMap = new Map<string, FlowItem[]>();
    for (const item of activeItems) {
      if (!stageMap.has(item.stage)) {
        stageMap.set(item.stage, []);
      }
      stageMap.get(item.stage)!.push(item);
    }

    const accumulations: StageAccumulation[] = [];
    for (const [stage, items] of stageMap) {
      const dwellTimes = items.map((item) => now - (item.startedAt ?? item.createdAt));
      const totalAccumulationMs = dwellTimes.reduce((a, b) => a + b, 0);
      const avgDwellMs = items.length > 0 ? totalAccumulationMs / items.length : 0;

      accumulations.push({
        stage,
        itemCount: items.length,
        avgDwellMs,
        totalAccumulationMs,
      });
    }

    // Rank by Theory of Constraints: highest total accumulation time = primary constraint
    accumulations.sort((a, b) => b.totalAccumulationMs - a.totalAccumulationMs);

    const primaryConstraint = accumulations[0] ?? null;
    const hasBottleneck = primaryConstraint !== null &&
      primaryConstraint.avgDwellMs > BOTTLENECK_THRESHOLD_MS;

    const remediationHints: string[] = [];
    if (hasBottleneck && primaryConstraint) {
      remediationHints.push(
        `Stage "${primaryConstraint.stage}" has ${primaryConstraint.itemCount} items with avg dwell ${Math.round(primaryConstraint.avgDwellMs / 60_000)}min`,
      );
      remediationHints.push(
        `Consider limiting WIP at "${primaryConstraint.stage}" or adding capacity`,
      );
      if (primaryConstraint.itemCount > 5) {
        remediationHints.push(
          `High item count (${primaryConstraint.itemCount}) suggests resource constraint — review stage capacity`,
        );
      }
    }

    return {
      primaryBottleneck: hasBottleneck ? primaryConstraint!.stage : null,
      rankedStages: accumulations,
      hasBottleneck,
      remediationHints,
      calculatedAt: now,
    };
  }

  // ── Goal evaluation ────────────────────────────────────────────────────────

  private _evaluateGoals(
    efficiency: EfficiencyMetricState,
    distribution: DistributionMetricState,
  ): void {
    const now = Date.now();
    const prevGoals = { ...this.goalState };

    const efficiencyStatus: GoalStatus = efficiency.healthy ? "satisfied" : "violated";
    let distributionStatus: GoalStatus;
    if (distribution.total === 0) {
      distributionStatus = "pending";
    } else {
      distributionStatus = distribution.balanced ? "satisfied" : "violated";
    }

    this.goalState = {
      "flow.efficiency_healthy": efficiencyStatus,
      "flow.distribution_balanced": distributionStatus,
      lastEvaluatedAt: now,
    };

    // Emit goal updates when state changes
    const efficiencyChanged = prevGoals["flow.efficiency_healthy"] !== efficiencyStatus;
    const distributionChanged = prevGoals["flow.distribution_balanced"] !== distributionStatus;

    if ((efficiencyChanged || distributionChanged) && this.bus) {
      const topic = "event.flow.goal.updated";
      this.bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic,
        timestamp: now,
        payload: {
          goals: this.goalState,
          changed: {
            "flow.efficiency_healthy": efficiencyChanged,
            "flow.distribution_balanced": distributionChanged,
          },
        },
      });

      if (efficiencyChanged) {
        console.log(
          `[flow-monitor] Goal flow.efficiency_healthy: ${prevGoals["flow.efficiency_healthy"]} → ${efficiencyStatus} ` +
          `(efficiency=${(efficiency.ratio * 100).toFixed(1)}%)`,
        );
      }
      if (distributionChanged) {
        console.log(
          `[flow-monitor] Goal flow.distribution_balanced: ${prevGoals["flow.distribution_balanced"]} → ${distributionStatus}`,
        );
      }
    }
  }

  // ── Event emitters ─────────────────────────────────────────────────────────

  private _emitWIPExceeded(wipResult: WIPLimitResult): void {
    if (!this.bus) return;
    const topic = "event.flow.wip_exceeded";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: {
        currentWIP: wipResult.currentWIP,
        wipLimit: wipResult.wipLimit,
        suggestedDelayMs: wipResult.suggestedDelayMs,
        waitQueueLength: wipResult.waitQueue.length,
      },
    });
  }

  private _emitBottleneckDetected(bottleneck: BottleneckDetectionResult): void {
    if (!this.bus) return;
    const topic = "event.flow.bottleneck.detected";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: {
        primaryBottleneck: bottleneck.primaryBottleneck,
        rankedStages: bottleneck.rankedStages.slice(0, 5),
        remediationHints: bottleneck.remediationHints,
      },
    });
  }

  private _emitEfficiencyDebug(
    efficiency: EfficiencyMetricState,
    bottleneck: BottleneckDetectionResult,
  ): void {
    if (!this.bus) return;
    const topic = "event.flow.efficiency.debug";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: {
        ratio: efficiency.ratio,
        target: EFFICIENCY_TARGET,
        byStage: efficiency.byStage,
        bottleneckCandidates: bottleneck.rankedStages.slice(0, 3).map((s) => s.stage),
      },
    });
  }

  // ── Empty state initializer ────────────────────────────────────────────────

  private _emptyMetrics(): FlowMetrics {
    const now = Date.now();
    return {
      velocity: {
        currentPeriodCount: 0,
        rollingAverage: 0,
        trend: 0,
        history: [],
        period: "daily",
        calculatedAt: now,
      },
      leadTime: {
        p50Ms: null,
        p85Ms: null,
        p95Ms: null,
        sampleSize: 0,
        state: "PENDING",
        minRequired: MIN_LEAD_TIME_SAMPLES,
        calculatedAt: now,
      },
      efficiency: {
        ratio: 0,
        target: EFFICIENCY_TARGET,
        healthy: false,
        totalActiveMs: 0,
        totalCycleMs: 0,
        byStage: {},
        calculatedAt: now,
      },
      load: {
        totalWIP: 0,
        byStage: {},
        wipLimit: {
          state: "PENDING",
          currentWIP: 0,
          wipLimit: null,
          waitQueue: [],
        },
        calculatedAt: now,
      },
      distribution: {
        ratios: { feature: 0, defect: 0, risk: 0, debt: 0 },
        counts: { feature: 0, defect: 0, risk: 0, debt: 0 },
        total: 0,
        balanced: false,
        recommended: { ...RECOMMENDED_DISTRIBUTION },
        calculatedAt: now,
      },
      bottleneck: {
        primaryBottleneck: null,
        rankedStages: [],
        hasBottleneck: false,
        remediationHints: [],
        calculatedAt: now,
      },
      collectedAt: now,
    };
  }

  // ── Type helpers ───────────────────────────────────────────────────────────

  private _parseItemType(v: unknown): FlowItemType {
    if (v === "feature" || v === "defect" || v === "risk" || v === "debt") return v;
    return "feature";
  }

  private _parseItemStatus(v: unknown): FlowItemStatus {
    if (v === "queued" || v === "active" || v === "blocked" || v === "complete" || v === "wait") return v;
    return "queued";
  }
}

// ── MCP tool descriptor ───────────────────────────────────────────────────────

export interface MCPToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Returns a get_flow_metrics MCP tool descriptor bound to a FlowMonitorPlugin instance.
 * Pass this to your MCP server registration or agent tool registry.
 */
export function createGetFlowMetricsTool(plugin: FlowMonitorPlugin): MCPToolDescriptor {
  return {
    name: "get_flow_metrics",
    description:
      "Get current Flow Framework metrics: Velocity, Lead Time, Efficiency (≥35% target), " +
      "WIP Load (Little's Law), and Distribution (feature/defect/risk/debt). " +
      "Optionally filter by specific metric.",
    inputSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["velocity", "leadTime", "efficiency", "load", "distribution", "bottleneck"],
          description: "Optional: return only this metric",
        },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const metric =
        typeof input.metric === "string" ? (input.metric as keyof FlowMetrics) : undefined;
      return { success: true, data: plugin.getMetrics({ metric }) };
    },
  };
}

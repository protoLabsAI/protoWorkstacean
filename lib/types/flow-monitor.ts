/**
 * Flow Monitor TypeScript schema — 5 Flow Framework metrics.
 *
 * Metrics:
 *   - velocity:     Items completed per period (daily/weekly/monthly)
 *   - leadTime:     Creation-to-production duration with percentile distributions
 *   - efficiency:   Active/total ratio with ≥35% target threshold
 *   - load:         WIP count per stage (Little's Law enforcement)
 *   - distribution: Feature/defect/risk/debt ratio across backlog and in-flight
 */

// ── Work item types ───────────────────────────────────────────────────────────

export type FlowItemType = "feature" | "defect" | "risk" | "debt";

export type FlowItemStatus = "queued" | "active" | "blocked" | "complete" | "wait";

export interface FlowItem {
  id: string;
  type: FlowItemType;
  status: FlowItemStatus;
  /** Current workflow stage (e.g. "backlog", "in-progress", "review", "done") */
  stage: string;
  /** Unix timestamp ms when item was created/entered backlog */
  createdAt: number;
  /** Unix timestamp ms when active work began (entered "active" status) */
  startedAt?: number;
  /** Unix timestamp ms when item reached production/complete */
  completedAt?: number;
  meta?: Record<string, unknown>;
}

// ── Velocity metric ───────────────────────────────────────────────────────────

export type VelocityPeriod = "daily" | "weekly" | "monthly";

export interface VelocityDataPoint {
  periodStart: number;   // Unix timestamp ms
  periodEnd: number;     // Unix timestamp ms
  count: number;         // items completed in this period
  byType: Partial<Record<FlowItemType, number>>;
}

export interface VelocityMetricState {
  /** Latest completed count in the most recent full period */
  currentPeriodCount: number;
  /** Rolling average across recent periods */
  rollingAverage: number;
  /** Trend: positive = accelerating, negative = decelerating */
  trend: number;
  history: VelocityDataPoint[];
  period: VelocityPeriod;
  calculatedAt: number;
}

// ── Lead Time metric ──────────────────────────────────────────────────────────

export interface LeadTimeMetricState {
  /** Percentile distributions in milliseconds */
  p50Ms: number | null;
  p85Ms: number | null;
  p95Ms: number | null;
  /** Number of completed items used for calculation */
  sampleSize: number;
  /** Whether we have enough data (minimum 5 items) */
  state: "PENDING" | "READY";
  /** Required minimum before percentiles are meaningful */
  minRequired: number;
  calculatedAt: number;
}

// ── Efficiency metric ─────────────────────────────────────────────────────────

export interface EfficiencyMetricState {
  /** Ratio of active time to total cycle time (0.0 – 1.0) */
  ratio: number;
  /** Target threshold: 0.35 (35%) */
  target: number;
  /** true if ratio ≥ target */
  healthy: boolean;
  /** Active work time across tracked items (ms) */
  totalActiveMs: number;
  /** Total cycle time across tracked items (ms) */
  totalCycleMs: number;
  /** Per-stage breakdown of efficiency */
  byStage: Record<string, { activeMs: number; cycleMs: number; ratio: number }>;
  calculatedAt: number;
}

// ── Load (WIP) metric ─────────────────────────────────────────────────────────

export type WIPLimitState = "ok" | "exceeded" | "PENDING";

export interface WIPLimitResult {
  state: WIPLimitState;
  currentWIP: number;
  /** Calculated WIP limit from Little's Law: Lead Time × Throughput */
  wipLimit: number | null;
  /** Suggested delay in ms when WIP is exceeded */
  suggestedDelayMs?: number;
  /** Item IDs queued in wait state */
  waitQueue: string[];
}

export interface LoadMetricState {
  /** Total active WIP count */
  totalWIP: number;
  /** Per-stage WIP counts */
  byStage: Record<string, number>;
  /** Little's Law WIP limit enforcement */
  wipLimit: WIPLimitResult;
  calculatedAt: number;
}

// ── Distribution metric ───────────────────────────────────────────────────────

export interface DistributionMetricState {
  /** Ratio of each type (0.0 – 1.0) */
  ratios: Record<FlowItemType, number>;
  /** Raw counts per type */
  counts: Record<FlowItemType, number>;
  /** Total items counted */
  total: number;
  /** true if distribution is within recommended bounds */
  balanced: boolean;
  /** Recommended ratios: feature≥40%, defect≤30%, risk≤20%, debt≤20% */
  recommended: Record<FlowItemType, number>;
  calculatedAt: number;
}

// ── Bottleneck detection (Theory of Constraints) ─────────────────────────────

export interface StageAccumulation {
  stage: string;
  itemCount: number;
  /** Average time items have spent in this stage (ms) */
  avgDwellMs: number;
  /** Total accumulated wait time across all items in stage (ms) */
  totalAccumulationMs: number;
}

export interface BottleneckDetectionResult {
  /** Stage identified as the primary constraint */
  primaryBottleneck: string | null;
  /** All stages ranked by Theory of Constraints severity */
  rankedStages: StageAccumulation[];
  /** Whether a significant bottleneck exists */
  hasBottleneck: boolean;
  /** Remediation hints for the primary bottleneck */
  remediationHints: string[];
  calculatedAt: number;
}

// ── Aggregate flow metrics ────────────────────────────────────────────────────

export interface FlowMetrics {
  velocity: VelocityMetricState;
  leadTime: LeadTimeMetricState;
  efficiency: EfficiencyMetricState;
  load: LoadMetricState;
  distribution: DistributionMetricState;
  bottleneck: BottleneckDetectionResult;
  collectedAt: number;
}

// ── Goal state ────────────────────────────────────────────────────────────────

export type GoalStatus = "satisfied" | "violated" | "pending";

export interface FlowGoalState {
  "flow.efficiency_healthy": GoalStatus;
  "flow.distribution_balanced": GoalStatus;
  lastEvaluatedAt: number;
}

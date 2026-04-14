export type GoalType = "Invariant" | "Threshold" | "Distribution";
export type Severity = "low" | "medium" | "high" | "critical";
export type InvariantOperator = "eq" | "neq" | "truthy" | "falsy" | "in" | "not_in";

export interface BaseGoal {
  id: string;
  type: GoalType;
  description: string;
  severity?: Severity;
  enabled?: boolean;
  tags?: string[];
}

export interface InvariantGoal extends BaseGoal {
  type: "Invariant";
  /** Dot-notation path into world state (e.g. "metrics.cpu.status") */
  selector: string;
  /** Expected value for comparison */
  expected?: unknown;
  /** Comparison operator (default: "truthy") */
  operator?: InvariantOperator;
}

export interface ThresholdGoal extends BaseGoal {
  type: "Threshold";
  /** Dot-notation path into world state resolving to a number */
  selector: string;
  min?: number;
  max?: number;
}

export interface DistributionGoal extends BaseGoal {
  type: "Distribution";
  /** Dot-notation path resolving to an array or map of values */
  selector: string;
  /** Regex pattern — all values must match */
  pattern?: string;
  /** Expected distribution as { value: percentage } e.g. { "active": 0.8 } */
  distribution?: Record<string, number>;
  /** Allowed deviation from expected distribution (0.0–1.0, default 0.1) */
  tolerance?: number;
}

export type Goal = InvariantGoal | ThresholdGoal | DistributionGoal;

export interface GoalViolation {
  goalId: string;
  goalType: GoalType;
  severity: Severity;
  description: string;
  message: string;
  actual: unknown;
  expected: unknown;
  timestamp: number;
  projectSlug?: string;
  /**
   * Desired world-state change that would resolve this violation.
   * When present, PlannerPluginL0 queries ExecutorRegistry.resolveByEffect()
   * instead of ActionRegistry.getByGoal() to select candidate skills.
   */
  desiredEffect?: {
    /** World-state domain (e.g. "ci", "plane"). */
    domain: string;
    /** Dot-separated path into the domain's data object (e.g. "data.blockedPRs"). */
    path: string;
    /** The value the planner is trying to achieve at this path. */
    targetValue: unknown;
  };
}

export interface GoalsFile {
  version?: string;
  goals: Goal[];
}

export interface LoadedGoals {
  goals: Goal[];
  source: "global" | "project" | "merged";
  projectSlug?: string;
}

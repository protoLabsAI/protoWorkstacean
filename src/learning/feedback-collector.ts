/**
 * FeedbackCollector — collects human feedback on escalated plans
 * and plan execution outcomes.
 *
 * Feeds data into the learning flywheel so successful patterns
 * can be extracted and promoted.
 */

/** Human feedback on an escalated plan. */
export interface HumanFeedback {
  planId: string;
  timestamp: number;
  /** Human's decision. */
  decision: "approve" | "reject" | "modify";
  /** Optional modification instructions. */
  feedback?: string;
  /** Human's assessment of plan quality. */
  qualityRating?: number;
  /** Who provided the feedback. */
  decidedBy: string;
}

/** Plan execution outcome. */
export interface ExecutionOutcome {
  planId: string;
  timestamp: number;
  success: boolean;
  /** How long execution took (ms). */
  durationMs: number;
  /** Which actions succeeded/failed. */
  actionOutcomes: Array<{
    actionId: string;
    success: boolean;
    error?: string;
  }>;
  /** Goal was satisfied after execution. */
  goalSatisfied: boolean;
}

/** Collected feedback entry (union type). */
export type FeedbackEntry =
  | { type: "human"; data: HumanFeedback }
  | { type: "execution"; data: ExecutionOutcome };

export class FeedbackCollector {
  private entries: FeedbackEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 5000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record human feedback on a plan.
   */
  recordHumanFeedback(feedback: HumanFeedback): void {
    this.entries.push({ type: "human", data: feedback });
    this.trim();
  }

  /**
   * Record a plan execution outcome.
   */
  recordOutcome(outcome: ExecutionOutcome): void {
    this.entries.push({ type: "execution", data: outcome });
    this.trim();
  }

  /**
   * Get all feedback for a specific plan.
   */
  getForPlan(planId: string): FeedbackEntry[] {
    return this.entries.filter((e) => {
      if (e.type === "human") return e.data.planId === planId;
      return e.data.planId === planId;
    });
  }

  /**
   * Get plans that were approved by humans (good for learning).
   */
  getApprovedPlans(): HumanFeedback[] {
    return this.entries
      .filter((e): e is { type: "human"; data: HumanFeedback } =>
        e.type === "human" && e.data.decision === "approve",
      )
      .map((e) => e.data);
  }

  /**
   * Get plans that executed successfully (good for learning).
   */
  getSuccessfulExecutions(): ExecutionOutcome[] {
    return this.entries
      .filter((e): e is { type: "execution"; data: ExecutionOutcome } =>
        e.type === "execution" && e.data.success && e.data.goalSatisfied,
      )
      .map((e) => e.data);
  }

  /**
   * Get all entries.
   */
  getAll(): readonly FeedbackEntry[] {
    return this.entries;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.length = 0;
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }
}

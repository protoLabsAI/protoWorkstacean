/**
 * OutcomeAnalyzer — analyzes plan execution outcomes to identify
 * patterns suitable for rule learning.
 */

import type { FeedbackCollector, ExecutionOutcome, HumanFeedback } from "./feedback-collector.ts";

/** Analysis result for a goal pattern. */
export interface GoalAnalysis {
  goalPattern: string;
  totalAttempts: number;
  successfulAttempts: number;
  successRate: number;
  avgDurationMs: number;
  /** Plan IDs that succeeded and should be considered for learning. */
  learnablePlanIds: string[];
}

export class OutcomeAnalyzer {
  constructor(private collector: FeedbackCollector) {}

  /**
   * Analyze outcomes for plans matching a given set of plan IDs.
   */
  analyzeByPlanIds(planIds: string[]): {
    successRate: number;
    approvalRate: number;
    avgDuration: number;
    learnable: string[];
  } {
    const outcomes = planIds
      .flatMap((id) => this.collector.getForPlan(id))
      .filter((e) => e.type === "execution")
      .map((e) => e.data as ExecutionOutcome);

    const humanFeedback = planIds
      .flatMap((id) => this.collector.getForPlan(id))
      .filter((e) => e.type === "human")
      .map((e) => e.data as HumanFeedback);

    const successes = outcomes.filter((o) => o.success && o.goalSatisfied);
    const approved = humanFeedback.filter((f) => f.decision === "approve");

    return {
      successRate: outcomes.length > 0 ? successes.length / outcomes.length : 0,
      approvalRate: humanFeedback.length > 0 ? approved.length / humanFeedback.length : 0,
      avgDuration: outcomes.length > 0
        ? outcomes.reduce((s, o) => s + o.durationMs, 0) / outcomes.length
        : 0,
      learnable: successes.map((o) => o.planId),
    };
  }

  /**
   * Get all plan IDs eligible for learning (success + goal satisfied).
   */
  getLearnablePlanIds(): string[] {
    return this.collector.getSuccessfulExecutions().map((o) => o.planId);
  }

  /**
   * Identify plans that were rejected or failed — useful for negative learning.
   */
  getFailedPatterns(): Array<{ planId: string; reason: string }> {
    const failed: Array<{ planId: string; reason: string }> = [];

    for (const entry of this.collector.getAll()) {
      if (entry.type === "human" && entry.data.decision === "reject") {
        failed.push({ planId: entry.data.planId, reason: entry.data.feedback ?? "rejected by human" });
      }
      if (entry.type === "execution" && !entry.data.success) {
        const failedAction = entry.data.actionOutcomes.find((a) => !a.success);
        failed.push({
          planId: entry.data.planId,
          reason: failedAction?.error ?? "execution failed",
        });
      }
    }

    return failed;
  }
}

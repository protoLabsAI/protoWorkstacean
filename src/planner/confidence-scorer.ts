/**
 * ConfidenceScorer — evaluates plan quality and produces a composite
 * confidence score used for routing decisions (L2 → L3 escalation).
 */

import type { Goal, Plan, PlannerState, ValidationResult } from "./types.ts";
import type { ConfidenceBreakdown, ConfidenceScore, CandidatePlan } from "./routing-interface.ts";
import { cloneState } from "./world-state.ts";
import { executePlan } from "./executor.ts";

/** Weights for each confidence component. */
export interface ConfidenceWeights {
  feasibility: number;
  goalAlignment: number;
  costEfficiency: number;
  constraintSatisfaction: number;
}

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  feasibility: 0.35,
  goalAlignment: 0.30,
  costEfficiency: 0.15,
  constraintSatisfaction: 0.20,
};

export class ConfidenceScorer {
  private weights: ConfidenceWeights;

  constructor(weights: Partial<ConfidenceWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Score a validated plan's confidence.
   */
  score(
    plan: Plan,
    initialState: PlannerState,
    goal: Goal,
    validation: ValidationResult,
    candidate?: CandidatePlan,
  ): ConfidenceScore {
    const breakdown = this.computeBreakdown(plan, initialState, goal, validation, candidate);
    const overall = this.computeOverall(breakdown);
    return { overall, breakdown };
  }

  /**
   * Compute individual confidence factors.
   */
  private computeBreakdown(
    plan: Plan,
    initialState: PlannerState,
    goal: Goal,
    validation: ValidationResult,
    candidate?: CandidatePlan,
  ): ConfidenceBreakdown {
    return {
      feasibility: this.scoreFeasibility(plan, validation),
      goalAlignment: this.scoreGoalAlignment(plan, initialState, goal, validation),
      costEfficiency: this.scoreCostEfficiency(plan),
      constraintSatisfaction: this.scoreConstraintSatisfaction(plan, validation, candidate),
    };
  }

  /**
   * Weighted composite of breakdown scores.
   */
  private computeOverall(breakdown: ConfidenceBreakdown): number {
    const w = this.weights;
    return (
      w.feasibility * breakdown.feasibility +
      w.goalAlignment * breakdown.goalAlignment +
      w.costEfficiency * breakdown.costEfficiency +
      w.constraintSatisfaction * breakdown.constraintSatisfaction
    );
  }

  /**
   * Feasibility: 1.0 if plan is valid and complete, penalized for partial plans.
   */
  private scoreFeasibility(plan: Plan, validation: ValidationResult): number {
    if (!validation.valid) return 0;
    if (!plan.isComplete) return 0.3;
    if (plan.actions.length === 0) return 0.5;
    return 1.0;
  }

  /**
   * Goal alignment: does the final state satisfy the goal?
   */
  private scoreGoalAlignment(
    plan: Plan,
    initialState: PlannerState,
    goal: Goal,
    validation: ValidationResult,
  ): number {
    if (!validation.valid) return 0;
    // Try executing on a state clone to check goal satisfaction
    const stateCopy = cloneState(initialState);
    const execResult = executePlan(plan, stateCopy);
    if (!execResult.success) return 0;
    return goal(execResult.finalState) ? 1.0 : 0.2;
  }

  /**
   * Cost efficiency: normalized inverse cost (lower cost → higher score).
   * Uses a sigmoid-like function so very high costs don't dominate.
   */
  private scoreCostEfficiency(plan: Plan): number {
    if (plan.actions.length === 0) return 1.0;
    const avgCost = plan.totalCost / plan.actions.length;
    // Sigmoid normalization: 1 / (1 + avgCost / 10)
    return 1.0 / (1.0 + avgCost / 10.0);
  }

  /**
   * Constraint satisfaction: all preconditions met, no failures in execution chain.
   */
  private scoreConstraintSatisfaction(
    plan: Plan,
    validation: ValidationResult,
    candidate?: CandidatePlan,
  ): number {
    let score = validation.valid ? 1.0 : 0;

    // If LLM provided a high self-confidence, boost slightly
    if (candidate && candidate.llmConfidence > 0.8) {
      score = Math.min(1.0, score + 0.1);
    }

    return score;
  }
}

/**
 * L1Interface — L1 planner interface for L2 integration.
 *
 * Provides a standardized way for the L2 system to query L1 capabilities
 * and check if L1 can handle a request before invoking L2.
 */

import type { Goal, PlannerState, BudgetConfig, L0Context, L1Result } from "./types.ts";
import { L1Planner, } from "./l1-integration.ts";

/** L1 capability check result. */
export interface L1CapabilityResult {
  canHandle: boolean;
  confidence: number;
  result?: L1Result;
}

export class L1Interface {
  constructor(private planner: L1Planner | null) {}

  /**
   * Check if L1 can handle a request and with what confidence.
   */
  checkCapability(
    state: PlannerState,
    goal: Goal,
    budget?: BudgetConfig,
  ): L1CapabilityResult {
    if (!this.planner) {
      return { canHandle: false, confidence: 0 };
    }

    const context: L0Context = {
      currentState: state,
      goal,
      reason: "L1 capability check",
    };

    const result = this.planner.planFromContext(context, budget);

    if (result.success && result.plan) {
      // Estimate confidence based on search completeness and plan quality
      const confidence = this.estimateConfidence(result);
      return {
        canHandle: true,
        confidence,
        result,
      };
    }

    return {
      canHandle: false,
      confidence: 0,
      result,
    };
  }

  /**
   * Estimate confidence in the L1 result.
   */
  private estimateConfidence(result: L1Result): number {
    let confidence = 0.5; // Base confidence for any L1 result

    if (result.plan?.isComplete) confidence += 0.2;
    if (result.validationResult?.valid) confidence += 0.2;
    if (result.searchResult?.exhaustive) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  /**
   * Report that an L1 plan failed at runtime.
   */
  reportFailure(goalId: string, error: string): void {
    // Hook for learning system to track L1 failures
  }

  /** Whether L1 planner is configured. */
  isAvailable(): boolean {
    return this.planner !== null;
  }
}

/**
 * L0Interface — L0 planner interface for L2 integration.
 *
 * Provides a standardized way for the L2 system to query L0 capabilities
 * and check if L0 can handle a request before invoking L2.
 */

import type { Goal, PlannerState, Plan } from "./types.ts";
import type { L0RuleMatcher, L0MatchResult } from "../matcher/l0-l1-bridge.ts";

/** L0 capability check result. */
export interface L0CapabilityResult {
  canHandle: boolean;
  confidence: number;
  matchResult?: L0MatchResult;
  plan?: Plan;
}

export class L0Interface {
  constructor(private matcher: L0RuleMatcher | null) {}

  /**
   * Check if L0 can handle a request and with what confidence.
   */
  checkCapability(state: PlannerState, goal: Goal): L0CapabilityResult {
    if (!this.matcher) {
      return { canHandle: false, confidence: 0 };
    }

    const result = this.matcher.match(state, goal);

    if (result.matched && result.action) {
      return {
        canHandle: true,
        confidence: 1.0, // L0 rule matches are deterministic
        matchResult: result,
        plan: {
          actions: [result.action],
          totalCost: result.action.cost,
          isComplete: true,
        },
      };
    }

    return {
      canHandle: false,
      confidence: 0,
      matchResult: result,
    };
  }

  /**
   * Report that an L0 rule failed at runtime (for learning feedback).
   */
  reportFailure(goalId: string, actionId: string, error: string): void {
    // This is a hook for the learning system to track L0 failures
    // that might benefit from L2 intervention
  }

  /** Whether L0 matcher is configured. */
  isAvailable(): boolean {
    return this.matcher !== null;
  }
}

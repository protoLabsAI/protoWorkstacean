/**
 * PatternMatcher — matches incoming planning requests against learned rules.
 *
 * Used by the L2 router to check if a learned rule can handle a request
 * before invoking the full hybrid planner.
 */

import type { PlannerState, Plan } from "../planner/types.ts";
import type { LearnedRule } from "./rule-registry.ts";
import { RuleRegistry } from "./rule-registry.ts";

/** Match result from the pattern matcher. */
export interface PatternMatch {
  matched: boolean;
  rule?: LearnedRule;
  plan?: Plan;
  confidence: number;
}

export class PatternMatcher {
  private registry: RuleRegistry;

  constructor(registry: RuleRegistry) {
    this.registry = registry;
  }

  /**
   * Try to match a state against learned rules.
   * Returns the best matching rule if any.
   */
  match(state: PlannerState, goalPattern: string): PatternMatch {
    // First, try exact goal pattern match
    const goalRules = this.registry.findByGoal(goalPattern);
    if (goalRules.length > 0) {
      const matching = goalRules.filter((r) =>
        r.conditions.every((c) => c(state)),
      );

      if (matching.length > 0) {
        const best = this.selectBest(matching);
        return {
          matched: true,
          rule: best,
          plan: {
            actions: best.actions,
            totalCost: best.totalCost,
            isComplete: true,
          },
          confidence: this.ruleConfidence(best),
        };
      }
    }

    // Try general state matching
    const stateMatches = this.registry.findMatching(state);
    if (stateMatches.length > 0) {
      const best = this.selectBest(stateMatches);
      return {
        matched: true,
        rule: best,
        plan: {
          actions: best.actions,
          totalCost: best.totalCost,
          isComplete: true,
        },
        confidence: this.ruleConfidence(best),
      };
    }

    return { matched: false, confidence: 0 };
  }

  /**
   * Select the best rule from a list of matches.
   * Prefers: highest success rate → highest confidence → lowest cost.
   */
  private selectBest(rules: LearnedRule[]): LearnedRule {
    return rules.sort((a, b) => {
      // Success rate
      const aRate = a.successCount / Math.max(1, a.successCount + a.failureCount);
      const bRate = b.successCount / Math.max(1, b.successCount + b.failureCount);
      if (aRate !== bRate) return bRate - aRate;

      // Confidence
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;

      // Cost
      return a.totalCost - b.totalCost;
    })[0];
  }

  /**
   * Compute confidence for a learned rule based on its track record.
   */
  private ruleConfidence(rule: LearnedRule): number {
    const total = rule.successCount + rule.failureCount;
    if (total === 0) return rule.confidence * 0.5; // Untested rule

    const successRate = rule.successCount / total;
    // Blend original confidence with empirical success rate
    return 0.3 * rule.confidence + 0.7 * successRate;
  }
}

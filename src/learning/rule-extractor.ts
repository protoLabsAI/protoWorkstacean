/**
 * RuleExtractor — extracts generalizable patterns from successful L2 plans.
 *
 * Analyzes plan structure, identifies reusable patterns, and creates
 * rule conditions for the RuleRegistry.
 */

import type { Plan, PlannerState, StatePredicate } from "../planner/types.ts";
import type { L2Result, } from "../planner/routing-interface.ts";
import type { LearnedRule } from "./rule-registry.ts";

/** Configuration for rule extraction. */
export interface RuleExtractionConfig {
  /** Minimum confidence for a plan to be eligible for extraction. */
  minConfidence: number;
  /** Minimum number of actions for a plan to be worth extracting. */
  minActions: number;
  /** Maximum number of actions for a single rule. */
  maxActions: number;
}

const DEFAULT_CONFIG: RuleExtractionConfig = {
  minConfidence: 0.8,
  minActions: 1,
  maxActions: 10,
};

export class RuleExtractor {
  private config: RuleExtractionConfig;

  constructor(config: Partial<RuleExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attempt to extract a learned rule from a successful L2 result.
   * Returns null if the result isn't suitable for extraction.
   */
  extract(
    result: L2Result,
    goalPattern: string,
    initialState: PlannerState,
  ): LearnedRule | null {
    // Check eligibility
    if (!result.success || !result.plan) return null;
    if (result.confidence.overall < this.config.minConfidence) return null;
    if (result.plan.actions.length < this.config.minActions) return null;
    if (result.plan.actions.length > this.config.maxActions) return null;

    // Extract conditions from the initial state
    const conditions = this.extractConditions(result.plan, initialState);

    const now = Date.now();
    return {
      id: `learned-${result.planId}`,
      name: `Rule from L2 plan ${result.planId.slice(0, 8)}`,
      goalPattern,
      conditions,
      actions: [...result.plan.actions],
      totalCost: result.plan.totalCost,
      successCount: 1, // Starts with 1 (the original success)
      failureCount: 0,
      confidence: result.confidence.overall,
      version: 1,
      createdAt: now,
      updatedAt: now,
      sourcePlanId: result.planId,
      promotedToL0: false,
      active: true,
    };
  }

  /**
   * Extract state conditions from the plan's preconditions.
   *
   * Creates predicates that check the initial state matches
   * the preconditions of the first action in the plan.
   */
  private extractConditions(plan: Plan, initialState: PlannerState): StatePredicate[] {
    if (plan.actions.length === 0) return [];

    // Use the first action's preconditions as rule conditions
    const firstAction = plan.actions[0];
    const conditions: StatePredicate[] = [...firstAction.preconditions];

    // Also add a condition checking that relevant state keys match
    const relevantKeys = this.findRelevantStateKeys(plan, initialState);
    if (relevantKeys.length > 0) {
      const stateSnapshot = Object.fromEntries(
        relevantKeys.map((k) => [k, initialState[k]]),
      );
      conditions.push((state: PlannerState) =>
        relevantKeys.every((k) => state[k] === stateSnapshot[k]),
      );
    }

    return conditions;
  }

  /**
   * Find state keys that are relevant to the plan (used in preconditions/effects).
   */
  private findRelevantStateKeys(plan: Plan, initialState: PlannerState): string[] {
    const keys = new Set<string>();

    for (const action of plan.actions) {
      // Run effects on empty state to find keys they modify
      for (const effect of action.effects) {
        const result = effect({});
        for (const key of Object.keys(result)) {
          if (key in initialState) {
            keys.add(key);
          }
        }
      }
    }

    return Array.from(keys);
  }
}

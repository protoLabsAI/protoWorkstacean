/**
 * PlanConverter — converts successful L2 plans into L0-compatible rules.
 *
 * This is the core of the learning flywheel: when L2 successfully solves
 * a problem, the solution is distilled into a deterministic rule that L0
 * can use directly, eliminating future L2 invocations for the same pattern.
 */

import type { Action, Plan, PlannerState, StatePredicate, StateTransform } from "../planner/types.ts";
import type { L2Result } from "../planner/routing-interface.ts";
import type { LearnedRule } from "./rule-registry.ts";
import { RuleExtractor, type RuleExtractionConfig } from "./rule-extractor.ts";
import { RuleRegistry } from "./rule-registry.ts";

/** Configuration for plan conversion. */
export interface PlanConverterConfig {
  /** Extraction config. */
  extraction?: Partial<RuleExtractionConfig>;
  /** Number of successful executions before promoting to L0. */
  promotionThreshold: number;
}

const DEFAULT_CONFIG: PlanConverterConfig = {
  promotionThreshold: 3,
};

/** Result of a conversion attempt. */
export interface ConversionResult {
  /** Whether the plan was successfully converted to a rule. */
  converted: boolean;
  /** The created/updated rule, if any. */
  rule?: LearnedRule;
  /** Reason for failure, if any. */
  reason?: string;
}

export class PlanConverter {
  private extractor: RuleExtractor;
  private registry: RuleRegistry;
  private config: PlanConverterConfig;

  constructor(
    registry: RuleRegistry,
    config: Partial<PlanConverterConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extractor = new RuleExtractor(config.extraction);
    this.registry = registry;
  }

  /**
   * Attempt to convert a successful L2 result into a learned rule.
   */
  convert(
    result: L2Result,
    goalPattern: string,
    initialState: PlannerState,
  ): ConversionResult {
    // Check if we already have a rule for this plan
    const existing = this.registry.findByGoal(goalPattern);
    if (existing.length > 0) {
      // Update existing rule's success count
      const best = existing[0];
      this.registry.recordSuccess(best.id);
      return {
        converted: true,
        rule: this.registry.get(best.id),
        reason: "Updated existing rule success count",
      };
    }

    // Extract a new rule
    const rule = this.extractor.extract(result, goalPattern, initialState);
    if (!rule) {
      return {
        converted: false,
        reason: "Plan not eligible for rule extraction (low confidence, too short, or too long)",
      };
    }

    this.registry.register(rule);

    return {
      converted: true,
      rule,
    };
  }

  /**
   * Get rules ready for promotion to L0.
   */
  getPromotionCandidates(): LearnedRule[] {
    return this.registry.getPromotionCandidates(this.config.promotionThreshold);
  }

  /**
   * Execute the full learning flywheel cycle:
   * 1. Convert plan to rule
   * 2. Check if any rules are ready for L0 promotion
   * 3. Return promotion candidates
   */
  learningCycle(
    result: L2Result,
    goalPattern: string,
    initialState: PlannerState,
  ): { conversion: ConversionResult; promotionCandidates: LearnedRule[] } {
    const conversion = this.convert(result, goalPattern, initialState);
    const promotionCandidates = this.getPromotionCandidates();
    return { conversion, promotionCandidates };
  }
}

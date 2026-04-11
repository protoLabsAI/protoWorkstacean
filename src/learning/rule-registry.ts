/**
 * RuleRegistry — stores learned rules with versioning and rollback.
 *
 * Rules are extracted from successful L2 plans and stored here for
 * promotion to L0 after sufficient successful executions.
 */

import type { Action, PlannerState, StatePredicate, } from "../planner/types.ts";

/** A learned rule derived from a successful L2 plan. */
export interface LearnedRule {
  id: string;
  /** Human-readable name. */
  name: string;
  /** The goal this rule addresses. */
  goalPattern: string;
  /** State conditions that must hold for this rule to apply. */
  conditions: StatePredicate[];
  /** The action sequence to execute. */
  actions: Action[];
  /** Total cost of the action sequence. */
  totalCost: number;
  /** Number of successful executions. */
  successCount: number;
  /** Number of failed executions after learning. */
  failureCount: number;
  /** Confidence at time of extraction. */
  confidence: number;
  /** Version number (incremented on updates). */
  version: number;
  /** When this rule was created. */
  createdAt: number;
  /** When this rule was last updated. */
  updatedAt: number;
  /** The L2 plan ID that generated this rule. */
  sourcePlanId: string;
  /** Whether this rule has been promoted to L0. */
  promotedToL0: boolean;
  /** Whether this rule is currently active. */
  active: boolean;
}

/** Registry statistics. */
export interface RegistryStats {
  totalRules: number;
  activeRules: number;
  promotedRules: number;
  avgConfidence: number;
  avgSuccessRate: number;
}

export class RuleRegistry {
  private rules: Map<string, LearnedRule> = new Map();
  private maxRules: number;

  constructor(maxRules: number = 500) {
    this.maxRules = maxRules;
  }

  /**
   * Register a new learned rule.
   */
  register(rule: LearnedRule): void {
    // Prune if at capacity
    if (this.rules.size >= this.maxRules && !this.rules.has(rule.id)) {
      this.pruneLowestPerformers();
    }

    this.rules.set(rule.id, { ...rule });
  }

  /**
   * Get a rule by ID.
   */
  get(id: string): LearnedRule | undefined {
    const rule = this.rules.get(id);
    return rule ? { ...rule } : undefined;
  }

  /**
   * Find rules matching a goal pattern.
   */
  findByGoal(goalPattern: string): LearnedRule[] {
    return Array.from(this.rules.values())
      .filter((r) => r.active && r.goalPattern === goalPattern);
  }

  /**
   * Find active rules whose conditions match a state.
   */
  findMatching(state: PlannerState): LearnedRule[] {
    return Array.from(this.rules.values())
      .filter((r) => r.active && r.conditions.every((c) => c(state)));
  }

  /**
   * Record a successful execution of a rule.
   */
  recordSuccess(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.successCount++;
      rule.updatedAt = Date.now();
    }
  }

  /**
   * Record a failed execution of a rule.
   */
  recordFailure(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.failureCount++;
      rule.updatedAt = Date.now();
    }
  }

  /**
   * Mark a rule as promoted to L0.
   */
  markPromoted(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.promotedToL0 = true;
      rule.updatedAt = Date.now();
    }
  }

  /**
   * Deactivate a rule (e.g., on rollback).
   */
  deactivate(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.active = false;
      rule.updatedAt = Date.now();
    }
  }

  /**
   * Get rules eligible for promotion (enough successful executions).
   */
  getPromotionCandidates(promotionThreshold: number = 3): LearnedRule[] {
    return Array.from(this.rules.values())
      .filter((r) => r.active && !r.promotedToL0 && r.successCount >= promotionThreshold)
      .sort((a, b) => b.successCount - a.successCount);
  }

  /**
   * Get all active rules.
   */
  getAll(): LearnedRule[] {
    return Array.from(this.rules.values()).filter((r) => r.active);
  }

  /**
   * Get registry statistics.
   */
  getStats(): RegistryStats {
    const all = Array.from(this.rules.values());
    const active = all.filter((r) => r.active);
    const promoted = all.filter((r) => r.promotedToL0);
    const avgConfidence = active.length > 0
      ? active.reduce((sum, r) => sum + r.confidence, 0) / active.length
      : 0;
    const avgSuccessRate = active.length > 0
      ? active.reduce((sum, r) => {
          const total = r.successCount + r.failureCount;
          return sum + (total > 0 ? r.successCount / total : 0);
        }, 0) / active.length
      : 0;

    return {
      totalRules: all.length,
      activeRules: active.length,
      promotedRules: promoted.length,
      avgConfidence,
      avgSuccessRate,
    };
  }

  /** Number of rules. */
  get size(): number {
    return this.rules.size;
  }

  /**
   * Remove lowest-performing rules to stay under capacity.
   */
  private pruneLowestPerformers(): void {
    const rules = Array.from(this.rules.values())
      .filter((r) => !r.promotedToL0) // Never prune promoted rules
      .sort((a, b) => {
        const aRate = a.successCount + a.failureCount > 0
          ? a.successCount / (a.successCount + a.failureCount)
          : 0;
        const bRate = b.successCount + b.failureCount > 0
          ? b.successCount / (b.successCount + b.failureCount)
          : 0;
        return aRate - bRate;
      });

    // Remove bottom 10%
    const toRemove = Math.max(1, Math.floor(rules.length * 0.1));
    for (let i = 0; i < toRemove && i < rules.length; i++) {
      this.rules.delete(rules[i].id);
    }
  }
}

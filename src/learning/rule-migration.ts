/**
 * RuleMigration — migrates learned rules from the L2 registry to L0.
 *
 * Handles safe promotion with rollback capability if the new rule
 * degrades performance.
 */

import type { RuleRegistry } from "./rule-registry.ts";
import type { RuleVersioning, } from "./rule-versioning.ts";
import type { RuleAuditor } from "./rule-auditor.ts";

/** Migration result. */
export interface MigrationResult {
  ruleId: string;
  success: boolean;
  version: number;
  error?: string;
}

/** Migration config. */
export interface MigrationConfig {
  /** Whether to auto-rollback if performance degrades. */
  autoRollback: boolean;
  /** Max escalation rate increase before triggering rollback. */
  maxEscalationRateIncrease: number;
}

const DEFAULT_CONFIG: MigrationConfig = {
  autoRollback: true,
  maxEscalationRateIncrease: 0.1,
};

export class RuleMigration {
  private config: MigrationConfig;

  constructor(
    private registry: RuleRegistry,
    private versioning: RuleVersioning,
    private auditor: RuleAuditor,
    config: Partial<MigrationConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Promote a learned rule to L0.
   */
  promote(ruleId: string): MigrationResult {
    const rule = this.registry.get(ruleId);
    if (!rule) {
      return { ruleId, success: false, version: 0, error: "Rule not found" };
    }

    if (rule.promotedToL0) {
      return { ruleId, success: false, version: rule.version, error: "Already promoted" };
    }

    // Create a version snapshot before promotion
    this.versioning.createVersion(rule);

    // Mark as promoted
    this.registry.markPromoted(ruleId);

    // Audit the promotion
    this.auditor.logEvent({
      ruleId,
      type: "promote",
      timestamp: Date.now(),
      version: rule.version,
      details: `Promoted to L0 after ${rule.successCount} successes`,
    });

    return { ruleId, success: true, version: rule.version };
  }

  /**
   * Rollback a promoted rule to its previous version.
   */
  rollback(ruleId: string): MigrationResult {
    const previousVersion = this.versioning.getPreviousVersion(ruleId);
    if (!previousVersion) {
      return { ruleId, success: false, version: 0, error: "No previous version to rollback to" };
    }

    // Deactivate current version
    this.registry.deactivate(ruleId);

    // Log rollback
    this.auditor.logEvent({
      ruleId,
      type: "rollback",
      timestamp: Date.now(),
      version: previousVersion.version,
      details: "Rolled back due to performance degradation",
    });

    return { ruleId, success: true, version: previousVersion.version };
  }

  /**
   * Check if a rule should be rolled back based on performance.
   */
  shouldRollback(ruleId: string, currentEscalationRate: number, baselineRate: number): boolean {
    if (!this.config.autoRollback) return false;

    const increase = currentEscalationRate - baselineRate;
    return increase > this.config.maxEscalationRateIncrease;
  }

  /**
   * Promote all eligible rules.
   */
  promoteEligible(promotionThreshold: number = 3): MigrationResult[] {
    const candidates = this.registry.getPromotionCandidates(promotionThreshold);
    return candidates.map((c) => this.promote(c.id));
  }
}

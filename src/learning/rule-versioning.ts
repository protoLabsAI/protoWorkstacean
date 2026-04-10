/**
 * RuleVersioning — version control for learned rules.
 *
 * Maintains a history of rule versions for rollback capability.
 */

import type { LearnedRule } from "./rule-registry.ts";

/** A snapshot of a rule at a specific version. */
export interface RuleVersion {
  ruleId: string;
  version: number;
  snapshot: LearnedRule;
  timestamp: number;
}

export class RuleVersioning {
  private versions: Map<string, RuleVersion[]> = new Map();
  private maxVersionsPerRule: number;

  constructor(maxVersionsPerRule: number = 10) {
    this.maxVersionsPerRule = maxVersionsPerRule;
  }

  /**
   * Create a version snapshot of a rule.
   */
  createVersion(rule: LearnedRule): RuleVersion {
    const version: RuleVersion = {
      ruleId: rule.id,
      version: rule.version,
      snapshot: { ...rule, actions: [...rule.actions], conditions: [...rule.conditions] },
      timestamp: Date.now(),
    };

    const history = this.versions.get(rule.id) ?? [];
    history.push(version);

    // Trim old versions
    if (history.length > this.maxVersionsPerRule) {
      history.splice(0, history.length - this.maxVersionsPerRule);
    }

    this.versions.set(rule.id, history);
    return version;
  }

  /**
   * Get the previous version of a rule (for rollback).
   */
  getPreviousVersion(ruleId: string): RuleVersion | null {
    const history = this.versions.get(ruleId);
    if (!history || history.length < 1) return null;
    return history[history.length - 1];
  }

  /**
   * Get version history for a rule.
   */
  getHistory(ruleId: string): RuleVersion[] {
    return this.versions.get(ruleId) ?? [];
  }

  /**
   * Get a specific version of a rule.
   */
  getVersion(ruleId: string, version: number): RuleVersion | null {
    const history = this.versions.get(ruleId);
    if (!history) return null;
    return history.find((v) => v.version === version) ?? null;
  }

  /** Number of rules with version history. */
  get size(): number {
    return this.versions.size;
  }
}

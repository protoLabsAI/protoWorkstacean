/**
 * TierRouter — assign execution tier (L0–L3) to a budget request.
 *
 * Tier assignment logic (route_by_tier):
 *   L0: maxCost < $0.10  AND projectBudgetRatio > 0.50 → autonomous
 *   L1: maxCost < $1.00  AND projectBudgetRatio > 0.25 → notify, proceed
 *   L2: maxCost < $5.00  AND projectBudgetRatio > 0.10 → soft-gate
 *   L3: otherwise                                       → HITL required
 *
 * Deviation rule: if multiple conflicting tier decisions occur simultaneously,
 * apply the most conservative (highest L-number) and escalate to HITL.
 */

import { TIER_CONFIG, type BudgetTierLevel, type BudgetState, type CostEstimate } from "../types/budget.ts";

// ── Tier assignment ───────────────────────────────────────────────────────────

export interface TierDecision {
  tier: BudgetTierLevel;
  reason: string;
}

/**
 * route_by_tier: determine the appropriate tier for a request.
 *
 * Uses the minimum remaining budget ratio (project vs. total daily) as the
 * binding constraint, ensuring both caps are respected.
 */
export function route_by_tier(
  estimate: CostEstimate,
  budgetState: BudgetState,
): TierDecision {
  const maxCost = estimate.maxCost;
  // Use the tighter of the two budget ratios
  const budgetRatio = Math.min(
    budgetState.projectBudgetRatio,
    budgetState.dailyBudgetRatio,
  );

  // Check L0
  if (
    maxCost < TIER_CONFIG.L0.maxCost &&
    budgetRatio >= TIER_CONFIG.L0.minBudgetRatio
  ) {
    return {
      tier: "L0",
      reason: `max_cost $${maxCost.toFixed(4)} < $${TIER_CONFIG.L0.maxCost} and budget ratio ${(budgetRatio * 100).toFixed(1)}% ≥ ${TIER_CONFIG.L0.minBudgetRatio * 100}%`,
    };
  }

  // Check L1
  if (
    maxCost < TIER_CONFIG.L1.maxCost &&
    budgetRatio >= TIER_CONFIG.L1.minBudgetRatio
  ) {
    return {
      tier: "L1",
      reason: `max_cost $${maxCost.toFixed(4)} < $${TIER_CONFIG.L1.maxCost} and budget ratio ${(budgetRatio * 100).toFixed(1)}% ≥ ${TIER_CONFIG.L1.minBudgetRatio * 100}%`,
    };
  }

  // Check L2
  if (
    maxCost < TIER_CONFIG.L2.maxCost &&
    budgetRatio >= TIER_CONFIG.L2.minBudgetRatio
  ) {
    return {
      tier: "L2",
      reason: `max_cost $${maxCost.toFixed(4)} < $${TIER_CONFIG.L2.maxCost} and budget ratio ${(budgetRatio * 100).toFixed(1)}% ≥ ${TIER_CONFIG.L2.minBudgetRatio * 100}%`,
    };
  }

  // L3: everything else
  const reasons: string[] = [];
  if (maxCost >= TIER_CONFIG.L2.maxCost) {
    reasons.push(`max_cost $${maxCost.toFixed(4)} ≥ $${TIER_CONFIG.L2.maxCost}`);
  }
  if (budgetRatio < TIER_CONFIG.L2.minBudgetRatio) {
    reasons.push(`budget ratio ${(budgetRatio * 100).toFixed(1)}% < ${TIER_CONFIG.L2.minBudgetRatio * 100}%`);
  }
  if (budgetState.remainingProjectBudget <= 0) {
    reasons.push("project daily budget exhausted");
  }
  if (budgetState.remainingDailyBudget <= 0) {
    reasons.push("total daily budget exhausted");
  }

  return {
    tier: "L3",
    reason: reasons.join("; ") || "max_cost or budget ratio exceeds L2 threshold",
  };
}

// ── Tier behaviour descriptions ───────────────────────────────────────────────

export const TIER_ACTIONS: Record<BudgetTierLevel, string> = {
  L0: "Execute autonomously — no notification required",
  L1: "Execute and notify ops channel — monitor spend",
  L2: "Log warning, execute with caution — soft-gate triggered",
  L3: "Block execution — escalate to HITL for approval",
};

export function getTierAction(tier: BudgetTierLevel): string {
  return TIER_ACTIONS[tier];
}

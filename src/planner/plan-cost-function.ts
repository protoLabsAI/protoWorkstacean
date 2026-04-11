/**
 * PlanCostFunction — custom cost computation for L2 hybrid planning.
 *
 * Computes costs considering action weights, risk factors, and historical success rates.
 */

import type { Plan, } from "./types.ts";

/** Cost factors for plan evaluation. */
export interface CostFactors {
  /** Base action cost multiplier. */
  baseCostWeight: number;
  /** Risk penalty per action. */
  riskPenalty: number;
  /** Bonus for previously successful action sequences. */
  historicalSuccessBonus: number;
  /** Penalty for plan length. */
  lengthPenalty: number;
}

export const DEFAULT_COST_FACTORS: CostFactors = {
  baseCostWeight: 1.0,
  riskPenalty: 0.5,
  lengthPenalty: 0.1,
  historicalSuccessBonus: 0.2,
};

/**
 * Compute the effective cost of a plan considering multiple factors.
 */
export function computePlanCost(
  plan: Plan,
  factors: CostFactors = DEFAULT_COST_FACTORS,
  successRates?: Map<string, number>,
): number {
  let cost = 0;

  for (const action of plan.actions) {
    let actionCost = action.cost * factors.baseCostWeight;

    // Apply historical success bonus if available
    if (successRates) {
      const rate = successRates.get(action.id);
      if (rate !== undefined) {
        actionCost -= rate * factors.historicalSuccessBonus;
      }
    }

    cost += Math.max(0, actionCost);
  }

  // Length penalty
  cost += plan.actions.length * factors.lengthPenalty;

  return cost;
}

/**
 * Compare two plans and return the cost difference (negative = first is better).
 */
export function comparePlanCosts(
  planA: Plan,
  planB: Plan,
  factors?: CostFactors,
  successRates?: Map<string, number>,
): number {
  return computePlanCost(planA, factors, successRates) - computePlanCost(planB, factors, successRates);
}

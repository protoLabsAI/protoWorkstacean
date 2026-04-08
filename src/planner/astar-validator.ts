/**
 * AStarValidator — validates LLM-proposed candidate plans using A* search.
 *
 * Takes candidate plans from A2AProposer, validates each via plan-validator,
 * and optionally runs A* to find a cost-optimal alternative.
 */

import type { Goal, Plan, PlannerState, SearchResult, BudgetConfig } from "./types.ts";
import type { CandidatePlan, ValidationOutcome } from "./routing-interface.ts";
import { ActionGraph } from "./action-graph.ts";
import { AnytimePlanner } from "./anytime-planner.ts";
import { validatePlan } from "./plan-validator.ts";
import { zeroHeuristic } from "./heuristic.ts";
import type { HeuristicFn } from "./heuristic.ts";

/** Configuration for the A* validator. */
export interface AStarValidatorConfig {
  /** Whether to run A* optimization after validating candidates. */
  optimizeWithAStar: boolean;
  /** Budget for A* optimization search. */
  optimizationBudget: BudgetConfig;
}

const DEFAULT_CONFIG: AStarValidatorConfig = {
  optimizeWithAStar: true,
  optimizationBudget: {
    timeBudgetMs: 5000,
    maxExpansions: 5000,
  },
};

export class AStarValidator {
  private graph: ActionGraph;
  private config: AStarValidatorConfig;

  constructor(graph: ActionGraph, config: Partial<AStarValidatorConfig> = {}) {
    this.graph = graph;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a single candidate plan.
   */
  validateCandidate(
    candidate: CandidatePlan,
    initialState: PlannerState,
    goal: Goal,
  ): ValidationOutcome {
    const validation = validatePlan(candidate.plan, initialState, goal);

    return {
      feasible: validation.valid,
      validatedPlan: validation.valid ? candidate.plan : undefined,
      validationResult: validation,
    };
  }

  /**
   * Validate all candidates and return outcomes ordered by quality.
   */
  validateCandidates(
    candidates: CandidatePlan[],
    initialState: PlannerState,
    goal: Goal,
  ): Array<{ candidate: CandidatePlan; outcome: ValidationOutcome }> {
    const results = candidates.map((candidate) => ({
      candidate,
      outcome: this.validateCandidate(candidate, initialState, goal),
    }));

    // Sort by: feasible first, then by plan cost
    results.sort((a, b) => {
      if (a.outcome.feasible !== b.outcome.feasible) {
        return a.outcome.feasible ? -1 : 1;
      }
      const aCost = a.candidate.plan.totalCost;
      const bCost = b.candidate.plan.totalCost;
      return aCost - bCost;
    });

    return results;
  }

  /**
   * Run A* to find an optimized plan, comparing against the best candidate.
   */
  optimize(
    initialState: PlannerState,
    goal: Goal,
    heuristic: HeuristicFn = zeroHeuristic,
    bestCandidateCost?: number,
  ): { plan: Plan; searchResult: SearchResult } | null {
    if (!this.config.optimizeWithAStar) return null;

    const planner = new AnytimePlanner(this.graph, heuristic);
    const result = planner.search(initialState, goal, this.config.optimizationBudget);

    if (!result.searchResult.plan.isComplete) return null;

    // Only return if A* found something better (or no candidate existed)
    if (bestCandidateCost !== undefined && result.searchResult.plan.totalCost >= bestCandidateCost) {
      return null;
    }

    return {
      plan: result.searchResult.plan,
      searchResult: result.searchResult,
    };
  }
}

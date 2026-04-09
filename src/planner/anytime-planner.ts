/**
 * AnytimePlanner — wraps A* with budget-bounded anytime search.
 *
 * Returns the best plan found within the budget and can be resumed
 * to improve the solution with additional time.
 */

import type {
  BudgetConfig,
  Goal,
  PlannerState,
  SearchConfig,
  SearchResult,
} from "./types.ts";
import type { ActionGraph } from "./action-graph.ts";
import type { HeuristicFn } from "./heuristic.ts";
import { BudgetManager } from "./budget-manager.ts";
import { aStarSearch } from "./a-star.ts";

export interface AnytimeResult {
  /** Best plan found so far. */
  searchResult: SearchResult;
  /** Whether more time could improve the result. */
  canImprove: boolean;
  /** Number of iterations performed. */
  iterations: number;
}

export class AnytimePlanner {
  private graph: ActionGraph;
  private heuristic: HeuristicFn;
  private bestResult: SearchResult | null = null;
  private iterationCount = 0;

  constructor(graph: ActionGraph, heuristic: HeuristicFn) {
    this.graph = graph;
    this.heuristic = heuristic;
  }

  /**
   * Search for a plan within the given budget.
   *
   * Uses iterative weighted A* — starts with a high weight for fast
   * initial solutions, then reduces weight to improve quality.
   */
  search(
    initial: PlannerState,
    goal: Goal,
    budget: BudgetConfig,
  ): AnytimeResult {
    const manager = new BudgetManager(budget);
    this.iterationCount = 0;

    // Weights to try: start aggressive (fast), then refine
    const weights = [3.0, 2.0, 1.5, 1.0];

    for (const weight of weights) {
      if (!manager.hasRemaining()) break;

      const config: SearchConfig = {
        timeBudgetMs: manager.remainingTimeMs(),
        maxExpansions: manager.remainingExpansions(),
        weight,
      };

      const result = aStarSearch(
        this.graph,
        initial,
        goal,
        this.heuristic,
        config,
      );

      this.iterationCount++;

      // Keep the best complete plan found
      if (result.plan.isComplete) {
        if (
          this.bestResult === null ||
          !this.bestResult.plan.isComplete ||
          result.plan.totalCost < this.bestResult.plan.totalCost
        ) {
          this.bestResult = result;
        }
        // If we found an optimal solution (weight=1), stop
        if (weight <= 1.0 && result.exhaustive) break;
      } else if (this.bestResult === null) {
        // Keep partial result if we have nothing better
        this.bestResult = result;
      }
    }

    // If no result found at all, do one final search with remaining budget
    if (this.bestResult === null) {
      const config: SearchConfig = {
        timeBudgetMs: manager.remainingTimeMs(),
        weight: 1.0,
      };
      this.bestResult = aStarSearch(
        this.graph,
        initial,
        goal,
        this.heuristic,
        config,
      );
      this.iterationCount++;
    }

    const canImprove =
      !this.bestResult.exhaustive &&
      (!this.bestResult.plan.isComplete ||
        (this.bestResult.plan.lowerBound !== undefined &&
          this.bestResult.plan.totalCost > this.bestResult.plan.lowerBound));

    return {
      searchResult: this.bestResult,
      canImprove,
      iterations: this.iterationCount,
    };
  }

  /**
   * Resume search with additional budget to try to improve the current best plan.
   */
  resume(
    initial: PlannerState,
    goal: Goal,
    additionalBudget: BudgetConfig,
  ): AnytimeResult {
    // Run with weight=1.0 for optimal search
    const config: SearchConfig = {
      timeBudgetMs: additionalBudget.timeBudgetMs,
      maxExpansions: additionalBudget.maxExpansions,
      weight: 1.0,
    };

    const result = aStarSearch(
      this.graph,
      initial,
      goal,
      this.heuristic,
      config,
    );

    this.iterationCount++;

    if (
      result.plan.isComplete &&
      (this.bestResult === null ||
        !this.bestResult.plan.isComplete ||
        result.plan.totalCost < this.bestResult.plan.totalCost)
    ) {
      this.bestResult = result;
    }

    return {
      searchResult: this.bestResult ?? result,
      canImprove: !result.exhaustive,
      iterations: this.iterationCount,
    };
  }

  /** Get the current best result without searching. */
  currentBest(): SearchResult | null {
    return this.bestResult;
  }
}

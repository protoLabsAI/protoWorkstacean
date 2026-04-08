/**
 * Replan manager — handles mid-execution state changes by replanning.
 *
 * When the world state changes during plan execution:
 * 1. Detect which plan steps are invalidated
 * 2. Preserve already-executed steps
 * 3. Invoke A* from current state with remaining goals
 * 4. Merge new plan with executed prefix
 */

import type {
  BudgetConfig,
  Goal,
  Plan,
  PlannerState,
  SearchResult,
} from "./types.ts";
import type { ActionGraph } from "./action-graph.ts";
import type { HeuristicFn } from "./heuristic.ts";
import { aStarSearch } from "./a-star.ts";
import { detectInvalidation } from "./state-change-detector.ts";
import { mergePlans } from "./plan.ts";
import { validatePlan } from "./plan-validator.ts";

/** Result of a replan attempt. */
export interface ReplanResult {
  /** Whether replanning succeeded. */
  success: boolean;
  /** The new merged plan (executed prefix + new suffix). */
  plan: Plan;
  /** Index from which the plan was replanned. */
  replanFromIndex: number;
  /** The A* search result for the new suffix. */
  searchResult?: SearchResult;
  /** Error message if replanning failed. */
  error?: string;
}

export class ReplanManager {
  private graph: ActionGraph;
  private heuristic: HeuristicFn;
  private goal: Goal;

  constructor(graph: ActionGraph, heuristic: HeuristicFn, goal: Goal) {
    this.graph = graph;
    this.heuristic = heuristic;
    this.goal = goal;
  }

  /**
   * Check if a state change requires replanning, and if so, produce a new plan.
   *
   * @param currentPlan - The plan being executed
   * @param executedUpTo - How many actions have been executed (0-based exclusive)
   * @param expectedState - The state we expected after executing those actions
   * @param actualState - The actual current world state
   * @param budget - Time/expansion budget for replanning
   */
  checkAndReplan(
    currentPlan: Plan,
    executedUpTo: number,
    expectedState: PlannerState,
    actualState: PlannerState,
    budget: BudgetConfig,
  ): ReplanResult {
    // Detect if plan is invalidated
    const change = detectInvalidation(
      currentPlan,
      executedUpTo,
      expectedState,
      actualState,
    );

    // No state change or plan still valid
    if (change === null || !change.planInvalidated) {
      return {
        success: true,
        plan: currentPlan,
        replanFromIndex: -1,
      };
    }

    // Plan is invalidated — replan from current actual state
    const replanFromIndex = change.invalidatedFromIndex;
    const executedActions = currentPlan.actions.slice(0, executedUpTo);

    // Run A* from actual state
    const searchResult = aStarSearch(
      this.graph,
      actualState,
      this.goal,
      this.heuristic,
      {
        timeBudgetMs: budget.timeBudgetMs,
        maxExpansions: budget.maxExpansions,
      },
    );

    if (!searchResult.plan.isComplete) {
      return {
        success: false,
        plan: currentPlan,
        replanFromIndex,
        searchResult,
        error: "Replanning could not find a complete plan from current state",
      };
    }

    // Validate the new plan
    const validation = validatePlan(searchResult.plan, actualState, this.goal);
    if (!validation.valid) {
      return {
        success: false,
        plan: currentPlan,
        replanFromIndex,
        searchResult,
        error: `Replan validation failed: ${validation.error}`,
      };
    }

    // Merge executed prefix with new plan
    const mergedPlan = mergePlans(executedActions, searchResult.plan);

    return {
      success: true,
      plan: mergedPlan,
      replanFromIndex,
      searchResult,
    };
  }
}

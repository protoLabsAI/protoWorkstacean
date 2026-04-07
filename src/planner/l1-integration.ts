/**
 * L1 planner integration — entry point for invoking the A* planner
 * as fallback when L0 rule matching fails.
 */

import type {
  BudgetConfig,
  Goal,
  L0Context,
  L1Result,
  NamedGoal,
  PlannerState,
} from "./types.ts";
import { ActionGraph } from "./action-graph.ts";
import { AnytimePlanner } from "./anytime-planner.ts";
import { HTNDecomposer } from "./htn-decomposer.ts";
import { TaskNetwork } from "./task-network.ts";
import { validatePlan } from "./plan-validator.ts";
import { zeroHeuristic, namedGoalHeuristic } from "./heuristic.ts";
import type { HeuristicFn } from "./heuristic.ts";

/** Configuration for the L1 planner. */
export interface L1PlannerConfig {
  /** Default time budget for planning (ms). */
  defaultBudgetMs: number;
  /** Maximum node expansions per search. */
  maxExpansions?: number;
}

const DEFAULT_CONFIG: L1PlannerConfig = {
  defaultBudgetMs: 5000,
  maxExpansions: 10000,
};

export class L1Planner {
  private graph: ActionGraph;
  private network: TaskNetwork;
  private decomposer: HTNDecomposer;
  private config: L1PlannerConfig;

  constructor(
    graph: ActionGraph,
    network: TaskNetwork,
    config: Partial<L1PlannerConfig> = {},
  ) {
    this.graph = graph;
    this.network = network;
    this.decomposer = new HTNDecomposer(network);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Plan from L0 context — the main entry point when L0 rule matcher
   * cannot find a matching rule.
   */
  planFromContext(context: L0Context, budgetOverride?: BudgetConfig): L1Result {
    const budget: BudgetConfig = budgetOverride ?? {
      timeBudgetMs: this.config.defaultBudgetMs,
      maxExpansions: this.config.maxExpansions,
    };

    // Select heuristic: use goal-provided heuristic if available
    const heuristic: HeuristicFn = context.namedGoal
      ? namedGoalHeuristic(context.namedGoal)
      : zeroHeuristic;

    // Try HTN decomposition first to expand available actions
    const htnResult = this.decomposer.fullDecomposition(context.currentState);
    if (htnResult.success) {
      // Add decomposed actions to the graph
      for (const action of htnResult.actions) {
        this.graph.addAction(action);
      }
    }

    // Run anytime A* search
    const planner = new AnytimePlanner(this.graph, heuristic);
    const anytimeResult = planner.search(
      context.currentState,
      context.goal,
      budget,
    );

    const searchResult = anytimeResult.searchResult;

    if (!searchResult.plan.isComplete) {
      return {
        success: false,
        plan: searchResult.plan,
        searchResult,
        error: `L1 planner could not find complete plan: ${searchResult.nodesExpanded} nodes expanded, ${searchResult.elapsedMs}ms elapsed`,
      };
    }

    // Validate plan before returning
    const validation = validatePlan(
      searchResult.plan,
      context.currentState,
      context.goal,
    );

    if (!validation.valid) {
      return {
        success: false,
        plan: searchResult.plan,
        searchResult,
        validationResult: validation,
        error: `Plan validation failed: ${validation.error}`,
      };
    }

    return {
      success: true,
      plan: searchResult.plan,
      searchResult,
      validationResult: validation,
    };
  }

  /** Get the action graph. */
  getGraph(): ActionGraph {
    return this.graph;
  }

  /** Get the task network. */
  getNetwork(): TaskNetwork {
    return this.network;
  }

  /** Get the HTN decomposer. */
  getDecomposer(): HTNDecomposer {
    return this.decomposer;
  }
}

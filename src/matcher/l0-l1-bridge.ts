/**
 * L0-L1 bridge — connects the L0 rule matcher to the L1 A* planner.
 *
 * When L0 rule matching returns no match, this bridge:
 * 1. Constructs an L0Context from the unmatched request
 * 2. Passes it to the L1 planner
 * 3. Returns the planning result
 */

import type {
  BudgetConfig,
  Goal,
  L0Context,
  L1Result,
  NamedGoal,
  PlannerState,
} from "../planner/types.ts";
import { L1Planner, type L1PlannerConfig } from "../planner/l1-integration.ts";
import { ActionGraph } from "../planner/action-graph.ts";
import { TaskNetwork } from "../planner/task-network.ts";
import type { Action, CompositeTask } from "../planner/types.ts";

/** L0 rule match result. */
export interface L0MatchResult {
  matched: boolean;
  /** The matched rule's action, if any. */
  action?: Action;
  /** Reason for no match. */
  reason?: string;
}

/** L0 rule matcher interface. */
export interface L0RuleMatcher {
  match(state: PlannerState, goal: Goal): L0MatchResult;
}

/** Configuration for the bridge. */
export interface BridgeConfig {
  l1Config?: Partial<L1PlannerConfig>;
  defaultBudget?: BudgetConfig;
}

const DEFAULT_BUDGET: BudgetConfig = {
  timeBudgetMs: 5000,
  maxExpansions: 10000,
};

/**
 * Bridge between L0 rule matcher and L1 A* planner.
 *
 * Usage:
 * ```ts
 * const bridge = new L0L1Bridge(matcher, actions, tasks, config);
 * const result = bridge.resolve(currentState, goal);
 * // result.success === true if either L0 matched or L1 found a plan
 * ```
 */
export class L0L1Bridge {
  private matcher: L0RuleMatcher;
  private l1Planner: L1Planner;
  private defaultBudget: BudgetConfig;

  constructor(
    matcher: L0RuleMatcher,
    actions: Action[],
    compositeTasks: CompositeTask[],
    config: BridgeConfig = {},
  ) {
    this.matcher = matcher;
    this.defaultBudget = config.defaultBudget ?? DEFAULT_BUDGET;

    const graph = new ActionGraph();
    graph.addActions(actions);

    const network = new TaskNetwork();
    for (const action of actions) {
      network.addPrimitiveAction(action);
    }
    for (const task of compositeTasks) {
      network.addCompositeTask(task);
    }

    this.l1Planner = new L1Planner(graph, network, config.l1Config);
  }

  /**
   * Resolve a goal — try L0 first, fall back to L1 if no match.
   */
  resolve(
    state: PlannerState,
    goal: Goal,
    namedGoal?: NamedGoal,
    budget?: BudgetConfig,
  ): L1Result {
    // Step 1: Try L0 rule matcher
    const l0Result = this.matcher.match(state, goal);

    if (l0Result.matched && l0Result.action) {
      // L0 found a matching rule — return it as a single-action plan
      return {
        success: true,
        plan: {
          actions: [l0Result.action],
          totalCost: l0Result.action.cost,
          isComplete: true,
        },
      };
    }

    // Step 2: L0 failed — invoke L1 planner
    const context: L0Context = {
      currentState: state,
      goal,
      namedGoal,
      reason: l0Result.reason ?? "no matching rule",
    };

    return this.l1Planner.planFromContext(context, budget ?? this.defaultBudget);
  }

  /** Get the underlying L1 planner. */
  getL1Planner(): L1Planner {
    return this.l1Planner;
  }
}

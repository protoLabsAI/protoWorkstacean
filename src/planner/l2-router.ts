/**
 * L2Router — routing layer that intercepts L0/L1 failures or low-confidence
 * decisions and delegates to the L2 Ava hybrid planner.
 *
 * Decision tree:
 *   1. Try L0 rule match → if confident, return
 *   2. Try L1 A* search → if confident, return
 *   3. Invoke L2 hybrid (LLM-A*) → if confident, return
 *   4. Escalate to L3 (human-in-the-loop)
 */

import type { Goal, L0Context, L1Result, NamedGoal, PlannerState, BudgetConfig } from "./types.ts";
import type {
  FailureContext,
  L2Context,
  L2Result,
  RoutingConfig,
  RoutingDecision,
} from "./routing-interface.ts";
import { DEFAULT_ROUTING_CONFIG } from "./routing-interface.ts";
import { HybridPlanner } from "./hybrid-planner.ts";
import { L1Planner } from "./l1-integration.ts";
import type { L0RuleMatcher } from "../matcher/l0-l1-bridge.ts";

/** Callback for L3 escalation. */
export type L3EscalationHandler = (context: L2Context, result: L2Result) => void;

export interface L2RouterConfig {
  routing: RoutingConfig;
  /** Handler called when escalating to L3. */
  onL3Escalation?: L3EscalationHandler;
}

export class L2Router {
  private config: RoutingConfig;
  private hybridPlanner: HybridPlanner;
  private l1Planner: L1Planner | null;
  private l0Matcher: L0RuleMatcher | null;
  private onL3Escalation: L3EscalationHandler | null;

  constructor(
    hybridPlanner: HybridPlanner,
    config: Partial<L2RouterConfig> = {},
    l1Planner?: L1Planner,
    l0Matcher?: L0RuleMatcher,
  ) {
    this.config = config.routing ?? DEFAULT_ROUTING_CONFIG;
    this.hybridPlanner = hybridPlanner;
    this.l1Planner = l1Planner ?? null;
    this.l0Matcher = l0Matcher ?? null;
    this.onL3Escalation = config.onL3Escalation ?? null;
  }

  /**
   * Route a planning request through L0 → L1 → L2 → L3.
   */
  async resolve(
    state: PlannerState,
    goal: Goal,
    namedGoal?: NamedGoal,
    budget?: BudgetConfig,
  ): Promise<L2Result> {
    const correlationId = crypto.randomUUID();
    const failures: FailureContext[] = [];

    // Step 1: Try L0
    if (this.l0Matcher) {
      const l0Result = this.l0Matcher.match(state, goal);
      if (l0Result.matched && l0Result.action) {
        return this.l0SuccessResult(l0Result.action, correlationId);
      }
      failures.push({
        layer: "l0",
        reason: l0Result.reason ?? "no matching rule",
      });
    }

    // Step 2: Try L1 (if configured)
    if (this.config.tryL1BeforeL2 && this.l1Planner) {
      const l0Context: L0Context = {
        currentState: state,
        goal,
        namedGoal,
        reason: failures[0]?.reason ?? "no L0 matcher configured",
      };

      const l1Result = this.l1Planner.planFromContext(l0Context, budget);
      if (l1Result.success && l1Result.plan) {
        return this.l1SuccessResult(l1Result, correlationId);
      }
      failures.push({
        layer: "l1",
        reason: l1Result.error ?? "L1 planning failed",
        partialResult: l1Result,
      });
    }

    // Step 3: Invoke L2 hybrid planner
    const l2Context: L2Context = {
      currentState: state,
      goal,
      namedGoal,
      failures,
      l0Context: {
        currentState: state,
        goal,
        namedGoal,
        reason: failures.map((f) => f.reason).join("; "),
      },
      correlationId,
    };

    const l2Result = await this.hybridPlanner.plan(l2Context);

    // Step 4: Escalate to L3 if needed
    if (l2Result.escalatedToL3 && this.onL3Escalation) {
      this.onL3Escalation(l2Context, l2Result);
    }

    return l2Result;
  }

  /**
   * Direct L2 invocation — skips L0/L1, used when explicitly routing to L2.
   */
  async invokeL2(context: L2Context): Promise<L2Result> {
    const result = await this.hybridPlanner.plan(context);

    if (result.escalatedToL3 && this.onL3Escalation) {
      this.onL3Escalation(context, result);
    }

    return result;
  }

  /**
   * Make a routing decision without executing — for introspection.
   */
  decideRoute(
    state: PlannerState,
    goal: Goal,
    l0Confidence?: number,
    l1Confidence?: number,
  ): RoutingDecision {
    // Check L0
    if (l0Confidence !== undefined && l0Confidence >= this.config.l0ConfidenceThreshold) {
      return {
        target: "l0",
        reason: `L0 confidence ${l0Confidence} >= threshold ${this.config.l0ConfidenceThreshold}`,
        confidence: l0Confidence,
        context: { currentState: state, goal, reason: "l0 sufficient" },
      };
    }

    // Check L1
    if (l1Confidence !== undefined && l1Confidence >= this.config.l1ConfidenceThreshold) {
      return {
        target: "l1",
        reason: `L1 confidence ${l1Confidence} >= threshold ${this.config.l1ConfidenceThreshold}`,
        confidence: l1Confidence,
        context: { currentState: state, goal, reason: "l1 sufficient" },
      };
    }

    // Route to L2
    return {
      target: "l2",
      reason: "L0/L1 confidence below thresholds or unavailable",
      context: {
        currentState: state,
        goal,
        failures: [],
        correlationId: crypto.randomUUID(),
      } as L2Context,
    };
  }

  /** Wrap an L0 match as an L2Result. */
  private l0SuccessResult(action: import("./types.ts").Action, correlationId: string): L2Result {
    return {
      success: true,
      plan: { actions: [action], totalCost: action.cost, isComplete: true },
      confidence: {
        overall: 1.0,
        breakdown: { feasibility: 1, goalAlignment: 1, costEfficiency: 1, constraintSatisfaction: 1 },
      },
      escalatedToL3: false,
      planId: correlationId,
    };
  }

  /** Wrap an L1 result as an L2Result. */
  private l1SuccessResult(l1Result: L1Result, correlationId: string): L2Result {
    return {
      success: true,
      plan: l1Result.plan,
      confidence: {
        overall: 0.85,
        breakdown: { feasibility: 1, goalAlignment: 0.9, costEfficiency: 0.7, constraintSatisfaction: 0.8 },
      },
      searchResult: l1Result.searchResult,
      escalatedToL3: false,
      planId: correlationId,
    };
  }
}

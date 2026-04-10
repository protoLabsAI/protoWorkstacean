/**
 * HybridPlanner — LLM-A* hybrid planning engine.
 *
 * Combines LLM (Ava via A2A) for creative plan proposal with A* for
 * validation and cost-optimal path finding.
 *
 * Flow:
 *   1. Send context to A2AProposer → get candidate plans
 *   2. Validate each candidate with AStarValidator
 *   3. Optionally optimize with A* if no candidate is good enough
 *   4. Score confidence of best plan
 *   5. Return L2Result with plan + confidence
 */

import type { Goal, Plan, PlannerState, Action, ValidationResult } from "./types.ts";
import type { L2Context, L2Result, CandidatePlan, RoutingConfig, ConfidenceScore } from "./routing-interface.ts";
import { DEFAULT_ROUTING_CONFIG } from "./routing-interface.ts";
import { A2AProposer, type A2AClient, NoOpA2AClient } from "./a2a-proposer.ts";
import { AStarValidator, type AStarValidatorConfig } from "./astar-validator.ts";
import { ConfidenceScorer } from "./confidence-scorer.ts";
import { EscalationTrigger } from "./escalation-trigger.ts";
import { ActionGraph } from "./action-graph.ts";
import { validatePlan } from "./plan-validator.ts";
import { zeroHeuristic, namedGoalHeuristic } from "./heuristic.ts";
import type { HeuristicFn } from "./heuristic.ts";

/** Configuration for the hybrid planner. */
export interface HybridPlannerConfig {
  routing: RoutingConfig;
  validator?: Partial<AStarValidatorConfig>;
  /** Borderline margin for escalation trigger. */
  borderlineMargin?: number;
}

export class HybridPlanner {
  private proposer: A2AProposer;
  private validator: AStarValidator;
  private scorer: ConfidenceScorer;
  private trigger: EscalationTrigger;
  private graph: ActionGraph;
  private config: RoutingConfig;

  constructor(
    a2aClient: A2AClient,
    graph: ActionGraph,
    config: Partial<HybridPlannerConfig> = {},
  ) {
    this.graph = graph;
    this.config = config.routing ?? DEFAULT_ROUTING_CONFIG;
    this.proposer = new A2AProposer(a2aClient);
    this.validator = new AStarValidator(graph, config.validator);
    this.scorer = new ConfidenceScorer();
    this.trigger = new EscalationTrigger(
      this.config.l2ConfidenceThreshold,
      config.borderlineMargin,
    );
  }

  /**
   * Generate and validate a plan using LLM-A* hybrid approach.
   */
  async plan(context: L2Context): Promise<L2Result> {
    const planId = crypto.randomUUID();
    const availableActions = this.graph.getAllActions();
    const heuristic = this.selectHeuristic(context);

    // Step 1: Get LLM candidates
    let candidates: CandidatePlan[];
    try {
      candidates = await this.proposer.propose(
        context,
        availableActions,
        this.config.maxCandidates,
      );
    } catch (err) {
      // LLM failure — fall through to A* only
      candidates = [];
    }

    // Step 2: Validate candidates
    let bestPlan: Plan | undefined;
    let bestCandidate: CandidatePlan | undefined;
    let bestValidation = this.emptyValidation();

    if (candidates.length > 0) {
      const validated = this.validator.validateCandidates(
        candidates,
        context.currentState,
        context.goal,
      );

      const firstFeasible = validated.find((v) => v.outcome.feasible);
      if (firstFeasible) {
        bestPlan = firstFeasible.outcome.validatedPlan;
        bestCandidate = firstFeasible.candidate;
        bestValidation = firstFeasible.outcome.validationResult;
      }
    }

    // Step 3: A* optimization — try to beat the best candidate or find a plan if none exists
    const astarResult = this.validator.optimize(
      context.currentState,
      context.goal,
      heuristic,
      bestPlan?.totalCost,
    );

    if (astarResult) {
      bestPlan = astarResult.plan;
      bestValidation = validatePlan(astarResult.plan, context.currentState, context.goal);
    }

    // Step 4: Score confidence
    if (!bestPlan) {
      return this.failureResult(planId, "No feasible plan found from LLM candidates or A* optimization");
    }

    const confidence = this.scorer.score(
      bestPlan,
      context.currentState,
      context.goal,
      bestValidation,
      bestCandidate,
    );

    // Step 5: Check escalation
    const escalation = this.trigger.evaluate(confidence);

    return {
      success: !escalation.shouldEscalate,
      plan: bestPlan,
      confidence,
      selectedCandidate: bestCandidate,
      validation: {
        feasible: bestValidation.valid,
        validatedPlan: bestPlan,
        validationResult: bestValidation,
        optimizedPlan: astarResult?.plan,
        costDelta: bestCandidate && astarResult
          ? bestCandidate.plan.totalCost - astarResult.plan.totalCost
          : undefined,
      },
      searchResult: astarResult?.searchResult,
      escalatedToL3: escalation.shouldEscalate,
      error: escalation.shouldEscalate ? escalation.reason : undefined,
      planId,
    };
  }

  /** Select appropriate heuristic for the context. */
  private selectHeuristic(context: L2Context): HeuristicFn {
    return context.namedGoal
      ? namedGoalHeuristic(context.namedGoal)
      : zeroHeuristic;
  }

  /** Create a failure result. */
  private failureResult(planId: string, error: string): L2Result {
    return {
      success: false,
      confidence: {
        overall: 0,
        breakdown: {
          feasibility: 0,
          goalAlignment: 0,
          costEfficiency: 0,
          constraintSatisfaction: 0,
        },
      },
      escalatedToL3: true,
      error,
      planId,
    };
  }

  /** Create empty validation for initial state. */
  private emptyValidation(): ValidationResult {
    return {
      valid: false,
      failedAtIndex: -1,
      finalState: {} as PlannerState,
      error: "No candidate validated",
    };
  }

  /** Access the A* validator for testing/introspection. */
  getValidator(): AStarValidator {
    return this.validator;
  }

  /** Access the escalation trigger for testing. */
  getEscalationTrigger(): EscalationTrigger {
    return this.trigger;
  }
}

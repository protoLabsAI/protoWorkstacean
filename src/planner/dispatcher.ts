/**
 * L2-aware Dispatcher — orchestrates the full L0→L1→L2→L3 planning pipeline.
 *
 * Extends the existing planning orchestrator with L2 hybrid planning,
 * confidence-based routing, and learning flywheel integration.
 */

import type { Goal, PlannerState, NamedGoal, BudgetConfig, } from "./types.ts";
import type { L2Result, RoutingConfig } from "./routing-interface.ts";
import { DEFAULT_ROUTING_CONFIG } from "./routing-interface.ts";
import { L2Router, type L3EscalationHandler } from "./l2-router.ts";
import { HybridPlanner } from "./hybrid-planner.ts";
import { ActionGraph } from "./action-graph.ts";
import type { A2AClient } from "./a2a-proposer.ts";
import { NoOpA2AClient } from "./a2a-proposer.ts";
import { L1Planner } from "./l1-integration.ts";
import type { L0RuleMatcher } from "../matcher/l0-l1-bridge.ts";
import { L0Interface } from "./l0-interface.ts";
import { L1Interface } from "./l1-interface.ts";
import { PlanConverter } from "../learning/plan-converter.ts";
import { RuleRegistry } from "../learning/rule-registry.ts";
import { PatternMatcher as LearnedPatternMatcher } from "../learning/pattern-matcher.ts";
import { L2Metrics, } from "../monitoring/l2-metrics.ts";
import { EscalationTracker } from "../monitoring/escalation-tracker.ts";

/** Configuration for the L2-aware dispatcher. */
export interface L2DispatcherConfig {
  routing?: Partial<RoutingConfig>;
  /** A2A client for LLM communication. */
  a2aClient?: A2AClient;
  /** L3 escalation callback. */
  onL3Escalation?: L3EscalationHandler;
}

/**
 * L2Dispatcher — full pipeline dispatcher with learning flywheel.
 */
export class L2Dispatcher {
  private router: L2Router;
  private ruleRegistry: RuleRegistry;
  private planConverter: PlanConverter;
  private learnedMatcher: LearnedPatternMatcher;
  private l0Interface: L0Interface;
  private l1Interface: L1Interface;
  private metrics: L2Metrics;
  private escalationTracker: EscalationTracker;

  constructor(
    graph: ActionGraph,
    config: L2DispatcherConfig = {},
    l1Planner?: L1Planner,
    l0Matcher?: L0RuleMatcher,
  ) {
    const routingConfig: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      ...config.routing,
    };

    const a2aClient = config.a2aClient ?? new NoOpA2AClient();
    const hybridPlanner = new HybridPlanner(a2aClient, graph, { routing: routingConfig });

    this.router = new L2Router(
      hybridPlanner,
      { routing: routingConfig, onL3Escalation: config.onL3Escalation },
      l1Planner,
      l0Matcher,
    );

    this.ruleRegistry = new RuleRegistry();
    this.planConverter = new PlanConverter(this.ruleRegistry);
    this.learnedMatcher = new LearnedPatternMatcher(this.ruleRegistry);
    this.l0Interface = new L0Interface(l0Matcher ?? null);
    this.l1Interface = new L1Interface(l1Planner ?? null);
    this.metrics = new L2Metrics();
    this.escalationTracker = new EscalationTracker();
  }

  /**
   * Resolve a goal through the full planning pipeline.
   *
   * 1. Check learned rules first
   * 2. Route through L0→L1→L2→L3
   * 3. Feed successful results into learning flywheel
   * 4. Record metrics
   */
  async resolve(
    state: PlannerState,
    goal: Goal,
    namedGoal?: NamedGoal,
    budget?: BudgetConfig,
  ): Promise<L2Result> {
    const startTime = Date.now();
    const goalPattern = namedGoal?.id ?? "unnamed";

    // Step 1: Check learned rules
    const learnedMatch = this.learnedMatcher.match(state, goalPattern);
    if (learnedMatch.matched && learnedMatch.plan) {
      this.ruleRegistry.recordSuccess(learnedMatch.rule!.id);
      const result: L2Result = {
        success: true,
        plan: learnedMatch.plan,
        confidence: {
          overall: learnedMatch.confidence,
          breakdown: { feasibility: 1, goalAlignment: 1, costEfficiency: 0.8, constraintSatisfaction: 1 },
        },
        escalatedToL3: false,
        planId: crypto.randomUUID(),
      };
      this.recordMetrics(result, startTime, "l0");
      return result;
    }

    // Step 2: Route through L0→L1→L2
    const result = await this.router.resolve(state, goal, namedGoal, budget);
    const handledBy = result.escalatedToL3 ? "l3" : "l2";
    this.recordMetrics(result, startTime, handledBy);

    // Step 3: Learning flywheel
    if (result.success && result.plan) {
      this.planConverter.learningCycle(result, goalPattern, state);
    }

    // Step 4: Track escalations
    if (result.escalatedToL3) {
      this.escalationTracker.record({
        id: result.planId,
        timestamp: Date.now(),
        fromLayer: "l2",
        toLayer: "l3",
        goalPattern,
        reason: result.error ?? "low confidence",
        correlationId: result.planId,
      });
    }

    return result;
  }

  /** Record metrics for an invocation. */
  private recordMetrics(result: L2Result, startTime: number, handledBy: string): void {
    this.metrics.record({
      planId: result.planId,
      timestamp: Date.now(),
      success: result.success,
      confidence: result.confidence.overall,
      escalatedToL3: result.escalatedToL3,
      latencyMs: Date.now() - startTime,
      candidateCount: result.selectedCandidate ? 1 : 0,
      planActionCount: result.plan?.actions.length ?? 0,
      planCost: result.plan?.totalCost ?? 0,
      handledBy: handledBy as "l0" | "l1" | "l2" | "l3",
    });
  }

  /** Access the rule registry. */
  getRuleRegistry(): RuleRegistry {
    return this.ruleRegistry;
  }

  /** Access L2 metrics. */
  getMetrics(): L2Metrics {
    return this.metrics;
  }

  /** Access escalation tracker. */
  getEscalationTracker(): EscalationTracker {
    return this.escalationTracker;
  }

  /** Access the L0 interface. */
  getL0Interface(): L0Interface {
    return this.l0Interface;
  }

  /** Access the L1 interface. */
  getL1Interface(): L1Interface {
    return this.l1Interface;
  }
}

/**
 * Routing interface — types for L0/L1/L2 planner routing decisions.
 *
 * Extends the existing L0Context and L1Result types with confidence-aware
 * routing, L2 context, and escalation metadata.
 */

import type { Goal, L0Context, L1Result, NamedGoal, Plan, PlannerState, SearchResult, ValidationResult } from "./types.ts";

// ── Confidence types ────────────────────────────────────────────────────────

/** Breakdown of individual confidence factors. */
export interface ConfidenceBreakdown {
  /** Plan feasibility score (0–1): can actions be executed in order? */
  feasibility: number;
  /** Goal alignment score (0–1): does plan satisfy goal constraints? */
  goalAlignment: number;
  /** Cost efficiency score (0–1): is cost reasonable vs alternatives? */
  costEfficiency: number;
  /** Constraint satisfaction score (0–1): are all constraints met? */
  constraintSatisfaction: number;
}

/** Confidence score with overall value and breakdown. */
export interface ConfidenceScore {
  /** Overall confidence 0–1 (weighted composite of breakdown). */
  overall: number;
  breakdown: ConfidenceBreakdown;
}

// ── L2 context and result types ─────────────────────────────────────────────

/** Why a lower layer failed or had low confidence. */
export interface FailureContext {
  layer: "l0" | "l1";
  reason: string;
  confidence?: number;
  /** The partial or failed result from the lower layer. */
  partialResult?: L1Result;
}

/** Context passed to the L2 planner. */
export interface L2Context {
  currentState: PlannerState;
  goal: Goal;
  namedGoal?: NamedGoal;
  /** Why the request escalated to L2. */
  failures: FailureContext[];
  /** Original L0 context if available. */
  l0Context?: L0Context;
  /** Correlation ID for tracing. */
  correlationId: string;
}

/** A candidate plan proposed by the LLM (A2A). */
export interface CandidatePlan {
  /** Actions in the proposed plan. */
  plan: Plan;
  /** Rationale from the LLM for this plan. */
  rationale: string;
  /** LLM's self-assessed confidence (0–1). */
  llmConfidence: number;
}

/** Result from A* validation of a candidate plan. */
export interface ValidationOutcome {
  /** Whether the A* validator considers the plan feasible. */
  feasible: boolean;
  /** The validated/optimized plan (may differ from candidate). */
  validatedPlan?: Plan;
  /** A* validation result. */
  validationResult: ValidationResult;
  /** If A* found a better plan, include it. */
  optimizedPlan?: Plan;
  /** Cost comparison: original vs optimized. */
  costDelta?: number;
}

/** Result from the L2 hybrid planner. */
export interface L2Result {
  success: boolean;
  plan?: Plan;
  confidence: ConfidenceScore;
  /** The candidate that was selected (if any). */
  selectedCandidate?: CandidatePlan;
  /** Validation outcome from A*. */
  validation?: ValidationOutcome;
  /** Search stats from A* validation. */
  searchResult?: SearchResult;
  /** If escalated to L3 (human). */
  escalatedToL3: boolean;
  /** Reason for failure or escalation. */
  error?: string;
  /** Plan ID for learning flywheel tracking. */
  planId: string;
}

// ── Routing decision types ──────────────────────────────────────────────────

/** Which layer should handle the request. */
export type RoutingTarget = "l0" | "l1" | "l2" | "l3_human";

/** A routing decision with rationale. */
export interface RoutingDecision {
  target: RoutingTarget;
  reason: string;
  confidence?: number;
  /** Context to pass to the selected layer. */
  context: L0Context | L2Context;
}

// ── Routing config types ────────────────────────────────────────────────────

/** Configuration for routing thresholds. */
export interface RoutingConfig {
  /** Minimum confidence for L0 result to be accepted (0–1). */
  l0ConfidenceThreshold: number;
  /** Minimum confidence for L1 result to be accepted (0–1). */
  l1ConfidenceThreshold: number;
  /** Minimum confidence for L2 result to be accepted (0–1). */
  l2ConfidenceThreshold: number;
  /** Maximum number of LLM candidates to request. */
  maxCandidates: number;
  /** Time budget for L2 planning (ms). */
  l2TimeBudgetMs: number;
  /** Whether to attempt L1 before escalating to L2. */
  tryL1BeforeL2: boolean;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  l0ConfidenceThreshold: 0.7,
  l1ConfidenceThreshold: 0.6,
  l2ConfidenceThreshold: 0.5,
  maxCandidates: 3,
  l2TimeBudgetMs: 30_000,
  tryL1BeforeL2: true,
};

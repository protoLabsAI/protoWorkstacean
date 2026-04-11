/**
 * QualityMetrics — individual metric computations for plan quality assessment.
 *
 * Used by ConfidenceScorer and monitoring systems to evaluate plan quality.
 */

import type { Plan, ValidationResult } from "./types.ts";

/** Quality metric result. */
export interface QualityMetric {
  name: string;
  value: number;
  /** 0–1 normalized score. */
  normalizedScore: number;
  description: string;
}

/**
 * Compute plan length quality — shorter plans are generally better.
 */
export function planLengthMetric(plan: Plan): QualityMetric {
  const len = plan.actions.length;
  // Score decays with length: 1/(1 + len/5)
  const normalizedScore = 1.0 / (1.0 + len / 5.0);
  return {
    name: "plan_length",
    value: len,
    normalizedScore,
    description: `Plan has ${len} actions`,
  };
}

/**
 * Compute total cost quality.
 */
export function totalCostMetric(plan: Plan): QualityMetric {
  const normalizedScore = 1.0 / (1.0 + plan.totalCost / 20.0);
  return {
    name: "total_cost",
    value: plan.totalCost,
    normalizedScore,
    description: `Total plan cost: ${plan.totalCost}`,
  };
}

/**
 * Compute plan completeness quality.
 */
export function completenessMetric(plan: Plan): QualityMetric {
  const value = plan.isComplete ? 1 : 0;
  return {
    name: "completeness",
    value,
    normalizedScore: value,
    description: plan.isComplete ? "Plan is complete" : "Plan is incomplete",
  };
}

/**
 * Compute validation quality.
 */
export function validationMetric(validation: ValidationResult): QualityMetric {
  const value = validation.valid ? 1 : 0;
  return {
    name: "validation",
    value,
    normalizedScore: value,
    description: validation.valid ? "Plan passes validation" : `Validation failed: ${validation.error}`,
  };
}

/**
 * Compute all quality metrics for a plan.
 */
export function computeAllMetrics(
  plan: Plan,
  validation: ValidationResult,
): QualityMetric[] {
  return [
    planLengthMetric(plan),
    totalCostMetric(plan),
    completenessMetric(plan),
    validationMetric(validation),
  ];
}

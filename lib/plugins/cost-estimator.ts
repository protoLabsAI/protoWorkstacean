/**
 * CostEstimator — pre-flight cost estimation for agent requests.
 *
 * Uses heuristic token counting (≈4 chars/token) since the Anthropic SDK is not
 * installed in this project. Deviation rule: when the counting API is unavailable,
 * activate fallback estimation at 1.5× observed average (FALLBACK_COST_MULTIPLIER).
 *
 * Bus topics:
 *   Subscribes: none (called directly by BudgetPlugin)
 *   Publishes:  none
 */

import {
  MODEL_RATES,
  FALLBACK_COST_MULTIPLIER,
  type CostEstimate,
} from "../types/budget.ts";

// ── Token counting heuristic ─────────────────────────────────────────────────

/**
 * Approximate token count from text using a 4-chars-per-token heuristic.
 * This is consistent with common LLM tokenization averages for English text.
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// ── Cost calculation ──────────────────────────────────────────────────────────

/**
 * Calculate estimated cost given token counts and a model ID.
 * Falls back to "default" rates if the model is not in MODEL_RATES.
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  modelId: string,
): number {
  const rates = MODEL_RATES[modelId] ?? MODEL_RATES["default"];
  return promptTokens * rates.input + completionTokens * rates.output;
}

// ── Pre-flight estimator ──────────────────────────────────────────────────────

export interface EstimateInput {
  /** Full prompt text (used for heuristic if token counts not provided) */
  promptText?: string;
  /** Override: caller-provided token count estimate */
  estimatedPromptTokens?: number;
  /** Override: caller-provided completion token estimate (defaults to 2× prompt if unset) */
  estimatedCompletionTokens?: number;
  /** Model to price against */
  modelId?: string;
}

/**
 * pre_flight_estimate — the main entry point for pre-flight cost estimation.
 *
 * Returns a CostEstimate with:
 *   - estimatedCost: best-guess cost at nominal rates
 *   - maxCost: conservative upper bound (FALLBACK_COST_MULTIPLIER × estimatedCost)
 *   - fallbackUsed: true when heuristics were needed
 */
export function pre_flight_estimate(input: EstimateInput): CostEstimate {
  const modelId = input.modelId ?? "default";
  let fallbackUsed = false;

  // Determine token counts
  let promptTokens: number;
  if (input.estimatedPromptTokens != null && input.estimatedPromptTokens > 0) {
    promptTokens = input.estimatedPromptTokens;
  } else if (input.promptText) {
    promptTokens = estimateTokenCount(input.promptText);
    fallbackUsed = true;
  } else {
    // No info — use a conservative floor
    promptTokens = 200;
    fallbackUsed = true;
  }

  let completionTokens: number;
  if (input.estimatedCompletionTokens != null && input.estimatedCompletionTokens > 0) {
    completionTokens = input.estimatedCompletionTokens;
  } else {
    // Completion is typically ~2× the prompt for ReAct-style agents
    completionTokens = Math.ceil(promptTokens * 2);
    fallbackUsed = true;
  }

  const estimatedCost = calculateCost(promptTokens, completionTokens, modelId);
  const maxCost = fallbackUsed
    ? estimatedCost * FALLBACK_COST_MULTIPLIER
    : estimatedCost;

  return {
    promptTokens,
    completionTokens,
    estimatedCost,
    maxCost,
    modelId,
    fallbackUsed,
  };
}

// ── Anthropic token_count_api wrapper (stub for deviation rule activation) ────

/**
 * Attempt to use a real token counting API.
 * If the API is unavailable (no key, no SDK, timeout), falls back to heuristics.
 * This function is exported so tests can verify the fallback path is taken.
 */
export async function token_count_api(
  input: EstimateInput,
): Promise<CostEstimate> {
  // The Anthropic SDK is not installed in this project.
  // Per deviation rules: "When Anthropic token counting API is unavailable,
  // activate fallback cost estimation using conservative heuristics (1.5x)."
  // We therefore go directly to the heuristic estimator with fallbackUsed=true.
  const estimate = pre_flight_estimate(input);
  return { ...estimate, fallbackUsed: true };
}

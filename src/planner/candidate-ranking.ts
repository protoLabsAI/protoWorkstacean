/**
 * Arc 6.4 — rank effect-based candidates by observed metrics.
 *
 * The ExecutorRegistry gives us a list of `EffectRegistration` candidates
 * that each claim to move world state toward a goal's desired (domain, path).
 * Before Arc 6.4 the planner sorted purely by `reg.confidence` — the
 * agent's self-declared card weight. That's a fine cold-start prior, but
 * ignores everything we've actually observed about which agents succeed.
 *
 * This module layers observed metrics on top:
 *   - success rate (from CostStore samples) — primary signal
 *   - average confidence-on-success (from ConfidenceStore) — secondary
 *   - average wall-time per call — tiebreak penalty (faster = better)
 *
 * Once an (agent, skill) pair has seen `MIN_SAMPLES_FOR_TRUST` samples we
 * use observed metrics; before that we use the card's self-declared
 * confidence so new agents aren't locked out of dispatch.
 *
 * Kept as a pure function + lookup-bag so tests can inject a fixed cost/
 * confidence map and exercise the sort deterministically without spinning
 * up the A2A extensions pipeline.
 */

import type { EffectRegistration } from "../executor/types.ts";
import type { CostSummary } from "../executor/extensions/cost.ts";
import type { ConfidenceSummary } from "../executor/extensions/confidence.ts";

/**
 * Minimum observed samples before we trust the metrics over the card's
 * self-declared confidence. Below this we're still cold-starting.
 */
export const MIN_SAMPLES_FOR_TRUST = 5;

export interface RankContext {
  costSummary: (agentName: string, skill: string) => CostSummary | undefined;
  confidenceSummary: (agentName: string, skill: string) => ConfidenceSummary | undefined;
}

/**
 * Score a single candidate. Higher is better. Visible for testing.
 *
 * Scoring model (picked for interpretability, not optimality — can be
 * swapped for a learned policy later without touching the sort sites):
 *
 *   warm candidate (>= MIN_SAMPLES_FOR_TRUST samples):
 *     score = 2.0 * successRate                     // proven dominant signal
 *           + 0.5 * avgConfidenceOnSuccess          // agent self-assessment
 *           - 0.3 * clamp(avgWallMs / 60_000, 0, 2) // wall-time penalty (up to ~2min)
 *
 *   cold candidate (no samples or missing agentName):
 *     score = reg.confidence                        // card's own prior
 *
 * The warm formula is deliberately favored when samples exist: a candidate
 * with 80% success rate and mid-range confidence will beat a card-declared
 * 1.0 confidence prior. That's the whole point — observations win over
 * self-advertisement once we have them.
 */
export function scoreCandidate(reg: EffectRegistration, ctx: RankContext): number {
  if (!reg.agentName) {
    // Can't look up store without agentName — trust the card prior.
    return reg.confidence;
  }
  const cost = ctx.costSummary(reg.agentName, reg.skill);
  if (!cost || cost.sampleCount < MIN_SAMPLES_FOR_TRUST) {
    return reg.confidence;
  }

  const confidence = ctx.confidenceSummary(reg.agentName, reg.skill);
  const observedConfidence =
    confidence && confidence.sampleCount >= MIN_SAMPLES_FOR_TRUST
      ? confidence.avgConfidenceOnSuccess
      : 0;

  const wallPenalty = Math.min(Math.max(cost.avgWallMs / 60_000, 0), 2);

  return 2.0 * cost.successRate + 0.5 * observedConfidence - 0.3 * wallPenalty;
}

/**
 * Sort the candidate list in descending score order.
 * Stable tiebreak on the card's self-declared confidence so deterministic
 * orderings survive identical scores (e.g. two cold-start candidates).
 */
export function rankByObservedMetrics(
  candidates: EffectRegistration[],
  ctx: RankContext,
): EffectRegistration[] {
  return [...candidates].sort((a, b) => {
    const diff = scoreCandidate(b, ctx) - scoreCandidate(a, ctx);
    if (diff !== 0) return diff;
    return b.confidence - a.confidence;
  });
}

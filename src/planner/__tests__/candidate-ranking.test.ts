/**
 * Arc 6.4 — unit tests for observation-weighted candidate ranking.
 */

import { describe, test, expect } from "bun:test";
import {
  rankByObservedMetrics,
  scoreCandidate,
  MIN_SAMPLES_FOR_TRUST,
  type RankContext,
} from "../candidate-ranking.ts";
import type { EffectRegistration } from "../../executor/types.ts";
import type { CostSummary } from "../../executor/extensions/cost.ts";
import type { ConfidenceSummary } from "../../executor/extensions/confidence.ts";

function reg(overrides: Partial<EffectRegistration> = {}): EffectRegistration {
  return {
    skill: "rebase_pr",
    agentName: "quinn",
    domain: "pr_pipeline",
    path: "data.blockedPRs",
    expectedDelta: -1,
    confidence: 0.7,
    ...overrides,
  };
}

function ctx(
  costs: Record<string, CostSummary>,
  confidences: Record<string, ConfidenceSummary> = {},
): RankContext {
  const key = (a: string, s: string) => `${a}::${s}`;
  return {
    costSummary: (a, s) => costs[key(a, s)],
    confidenceSummary: (a, s) => confidences[key(a, s)],
  };
}

describe("scoreCandidate", () => {
  test("cold start (no samples) → card's self-declared confidence wins", () => {
    const c = reg({ confidence: 0.42 });
    expect(scoreCandidate(c, ctx({}))).toBe(0.42);
  });

  test("fewer samples than MIN_SAMPLES_FOR_TRUST → still uses card prior", () => {
    const c = reg({ confidence: 0.6 });
    const costs: Record<string, CostSummary> = {
      "quinn::rebase_pr": {
        agentName: "quinn",
        skill: "rebase_pr",
        sampleCount: MIN_SAMPLES_FOR_TRUST - 1,
        avgTokensIn: 0,
        avgTokensOut: 0,
        avgWallMs: 1000,
        avgCostUsd: 0,
        successRate: 1.0,
      },
    };
    expect(scoreCandidate(c, ctx(costs))).toBe(0.6);
  });

  test("warm with high success rate outranks warm with low success rate", () => {
    const a = reg({ agentName: "ava" });
    const b = reg({ agentName: "quinn" });
    const costs: Record<string, CostSummary> = {
      "ava::rebase_pr":   { agentName: "ava",   skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.9 },
      "quinn::rebase_pr": { agentName: "quinn", skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.3 },
    };
    expect(scoreCandidate(a, ctx(costs))).toBeGreaterThan(scoreCandidate(b, ctx(costs)));
  });

  test("observed success rate overrides card confidence", () => {
    // Card says this agent is amazing (1.0) but observed success rate is 0.2.
    // A different agent with lower card confidence (0.5) but 0.95 observed
    // success should rank higher.
    const hyped = reg({ agentName: "hyped", confidence: 1.0 });
    const proven = reg({ agentName: "proven", confidence: 0.5 });
    const costs: Record<string, CostSummary> = {
      "hyped::rebase_pr":  { agentName: "hyped",  skill: "rebase_pr", sampleCount: 20, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.2 },
      "proven::rebase_pr": { agentName: "proven", skill: "rebase_pr", sampleCount: 20, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.95 },
    };
    expect(scoreCandidate(proven, ctx(costs))).toBeGreaterThan(scoreCandidate(hyped, ctx(costs)));
  });

  test("wall-time penalty breaks ties on equal success rate", () => {
    const fast = reg({ agentName: "fast" });
    const slow = reg({ agentName: "slow" });
    const costs: Record<string, CostSummary> = {
      "fast::rebase_pr": { agentName: "fast", skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 500,    avgCostUsd: 0, successRate: 0.8 },
      "slow::rebase_pr": { agentName: "slow", skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 90_000, avgCostUsd: 0, successRate: 0.8 },
    };
    expect(scoreCandidate(fast, ctx(costs))).toBeGreaterThan(scoreCandidate(slow, ctx(costs)));
  });

  test("observed confidence-on-success boosts score when samples exist", () => {
    const sure = reg({ agentName: "sure" });
    const unsure = reg({ agentName: "unsure" });
    const costs: Record<string, CostSummary> = {
      "sure::rebase_pr":   { agentName: "sure",   skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.8 },
      "unsure::rebase_pr": { agentName: "unsure", skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.8 },
    };
    const confidences: Record<string, ConfidenceSummary> = {
      "sure::rebase_pr":   { agentName: "sure",   skill: "rebase_pr", sampleCount: 10, avgConfidence: 0.9, avgConfidenceOnSuccess: 0.95, avgConfidenceOnFailure: 0.5, highConfFailures: 0 },
      "unsure::rebase_pr": { agentName: "unsure", skill: "rebase_pr", sampleCount: 10, avgConfidence: 0.5, avgConfidenceOnSuccess: 0.40, avgConfidenceOnFailure: 0.5, highConfFailures: 0 },
    };
    expect(scoreCandidate(sure, ctx(costs, confidences)))
      .toBeGreaterThan(scoreCandidate(unsure, ctx(costs, confidences)));
  });

  test("missing agentName → card prior only (store lookup impossible)", () => {
    const c = reg({ agentName: undefined, confidence: 0.33 });
    expect(scoreCandidate(c, ctx({}))).toBe(0.33);
  });
});

describe("rankByObservedMetrics", () => {
  test("sorts descending by score — warm data dominates cold priors", () => {
    const alice = reg({ agentName: "alice", confidence: 0.3 });
    const bob   = reg({ agentName: "bob",   confidence: 0.3 });
    const carol = reg({ agentName: "carol", confidence: 0.9 });
    const costs: Record<string, CostSummary> = {
      "alice::rebase_pr": { agentName: "alice", skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.95 },
      "bob::rebase_pr":   { agentName: "bob",   skill: "rebase_pr", sampleCount: 10, avgTokensIn: 0, avgTokensOut: 0, avgWallMs: 1000, avgCostUsd: 0, successRate: 0.50 },
      // carol has no samples — falls back to card prior 0.9
    };

    const ranked = rankByObservedMetrics([bob, carol, alice], ctx(costs));

    // alice warm-high (score ≈ 1.895) > bob warm-mid (≈ 0.995) > carol cold-high-prior (0.9).
    // Intentional: observed data beats self-declared priors once warm. A
    // card advertising 0.9 that has no supporting observations shouldn't
    // outrank a skill with 10 runs at 50% success — real samples win.
    expect(ranked.map((r) => r.agentName)).toEqual(["alice", "bob", "carol"]);
  });

  test("tiebreak on card confidence when scores are equal", () => {
    // Two cold candidates — card confidences differ, both should appear in that order
    const weak   = reg({ agentName: "weak",   confidence: 0.2 });
    const strong = reg({ agentName: "strong", confidence: 0.9 });
    const ranked = rankByObservedMetrics([weak, strong], ctx({}));
    expect(ranked.map((r) => r.agentName)).toEqual(["strong", "weak"]);
  });

  test("input array is not mutated", () => {
    const input = [reg({ agentName: "a" }), reg({ agentName: "b", confidence: 0.1 })];
    const ranked = rankByObservedMetrics(input, ctx({}));
    expect(input.map((r) => r.agentName)).toEqual(["a", "b"]);
    expect(ranked).not.toBe(input);
  });
});

import { describe, expect, test } from "bun:test";
import { classifyFailure, computeQuinnReviewStats, type EvalEvent } from "../quinn-review-eval.ts";

const T0 = 1_780_000_000_000;

function outcome(success: boolean, opts: { ms?: number; error?: string; ts?: number } = {}): EvalEvent {
  return {
    topic: "autonomous.outcome.user.pr_review",
    ts: opts.ts ?? T0,
    correlationId: crypto.randomUUID(),
    body: {
      skill: "pr_review",
      success,
      taskState: success ? "completed" : "failed",
      durationMs: opts.ms,
      ...(opts.error ? { error: opts.error } : {}),
    },
  };
}

function toolCall(cid: string, toolNames: string[], ts = T0): EvalEvent {
  return {
    topic: "agent.runtime.activity.tool.call",
    ts,
    correlationId: cid,
    body: { type: "tool.call", agentName: "quinn", skill: "pr_review", toolNames },
  };
}

function submitted(owner: string, repo: string, event: string, ts = T0): EvalEvent {
  return {
    topic: "quinn.review.submitted",
    ts,
    correlationId: crypto.randomUUID(),
    body: { owner, repo, prNumber: 1, event, prUrl: "u", bodyPreview: "b" },
  };
}

describe("classifyFailure", () => {
  test("buckets the known stuck modes", () => {
    expect(classifyFailure("Recursion limit of 37 reached without hitting a stop condition")).toBe("recursion_limit");
    expect(classifyFailure("The operation timed out.")).toBe("timeout");
    expect(classifyFailure("GitHub API 429 rate limit")).toBe("rate_limit");
    expect(classifyFailure("circuit breaker open")).toBe("circuit_open");
    expect(classifyFailure("something else entirely")).toBe("other");
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure("")).toBe("unknown");
  });
});

describe("computeQuinnReviewStats", () => {
  test("completion rate and failure-mode breakdown", () => {
    const events = [
      outcome(true, { ms: 1000 }),
      outcome(true, { ms: 3000 }),
      outcome(true, { ms: 5000 }),
      outcome(false, { error: "Recursion limit of 37 reached without hitting a stop condition" }),
      outcome(false, { error: "The operation timed out." }),
    ];
    const s = computeQuinnReviewStats(events);
    expect(s.outcomes.total).toBe(5);
    expect(s.outcomes.completed).toBe(3);
    expect(s.outcomes.failed).toBe(2);
    expect(s.outcomes.completionRate).toBeCloseTo(0.6, 5);
    expect(s.outcomes.failureModes.recursion_limit).toBe(1);
    expect(s.outcomes.failureModes.timeout).toBe(1);
  });

  test("latency percentiles from successful runs only", () => {
    const events = [1000, 2000, 3000, 4000, 5000].map((ms) => outcome(true, { ms }));
    const s = computeQuinnReviewStats(events);
    expect(s.latencyMs).not.toBeNull();
    expect(s.latencyMs!.min).toBe(1000);
    expect(s.latencyMs!.max).toBe(5000);
    expect(s.latencyMs!.avg).toBe(3000);
    expect(s.latencyMs!.median).toBe(3000);
  });

  test("clawpatch rate uses the longest (final) tool sequence per review", () => {
    const cidA = "a";
    const cidB = "b";
    const events = [
      // review A: cumulative frames, final includes clawpatch
      toolCall(cidA, ["pr_inspector"]),
      toolCall(cidA, ["pr_inspector", "pr_inspector", "clawpatch_review"]),
      // review B: never uses clawpatch
      toolCall(cidB, ["pr_inspector", "pr_inspector", "pr_inspector"]),
    ];
    const s = computeQuinnReviewStats(events);
    expect(s.toolUse.reviewsProfiled).toBe(2);
    expect(s.toolUse.clawpatchReviews).toBe(1);
    expect(s.toolUse.clawpatchRate).toBeCloseTo(0.5, 5);
    expect(s.toolUse.toolFrequency.pr_inspector).toBe(5); // 2 from A's final + 3 from B
    expect(s.toolUse.callsPerReview!.max).toBe(3);
  });

  test("verdict mix and per-repo from quinn.review.submitted", () => {
    const events = [
      submitted("protoLabsAI", "ORBIS", "COMMENT"),
      submitted("protoLabsAI", "ORBIS", "APPROVE"),
      submitted("protoLabsAI", "protoWorkstacean", "REQUEST_CHANGES"),
      submitted("protoLabsAI", "ORBIS", "APPROVE"),
    ];
    const s = computeQuinnReviewStats(events);
    expect(s.verdicts.APPROVE).toBe(2);
    expect(s.verdicts.COMMENT).toBe(1);
    expect(s.verdicts.REQUEST_CHANGES).toBe(1);
    expect(s.verdicts.total).toBe(4);
    expect(s.perRepo[0].repo).toBe("protoLabsAI/ORBIS");
    expect(s.perRepo[0].reviews).toBe(3);
    expect(s.perRepo[0].approve).toBe(2);
  });

  test("empty input degrades cleanly", () => {
    const s = computeQuinnReviewStats([]);
    expect(s.outcomes.total).toBe(0);
    expect(s.outcomes.completionRate).toBe(0);
    expect(s.latencyMs).toBeNull();
    expect(s.toolUse.callsPerReview).toBeNull();
    expect(s.perRepo).toEqual([]);
  });

  test("window spans min/max event timestamps", () => {
    const s = computeQuinnReviewStats([
      outcome(true, { ms: 1, ts: T0 }),
      outcome(true, { ms: 1, ts: T0 + 2 * 86_400_000 }),
    ]);
    expect(s.window.from).toBe(T0);
    expect(s.window.to).toBe(T0 + 2 * 86_400_000);
    expect(s.window.days).toBeCloseTo(2, 5);
  });
});

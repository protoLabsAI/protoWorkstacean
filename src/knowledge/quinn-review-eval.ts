/**
 * Quinn review-eval — a measurement baseline for the PR-review agent.
 *
 * Pure aggregation over bus events already persisted in events.db. No DB or IO
 * here so it unit-tests against synthetic events; `scripts/quinn-review-eval.ts`
 * is the thin reader that feeds it real rows.
 *
 * The field measures review agents by signal-to-noise, not raw volume
 * (CR-Bench / CR-Evaluator): beneficial findings vs noise, verdict mix, and —
 * critically for us — the rate at which a review fails to produce ANY verdict.
 * See docs/explanation/code-review-agent-design.md.
 *
 * Inputs are normalized events: the inner bus payload (`envelope.payload`) plus
 * topic/ts/correlationId. Consumes three topics:
 *   - autonomous.outcome.*.pr_review        → completion / failure-mode / latency
 *   - agent.runtime.activity.tool.call       → tool profile + clawpatch usage
 *   - quinn.review.submitted                 → formal verdict mix + per-repo
 */

export interface EvalEvent {
  topic: string;
  /** epoch ms */
  ts: number;
  correlationId: string;
  /** the inner bus payload (envelope.payload), already JSON-parsed */
  body: Record<string, unknown>;
}

export interface QuinnReviewStats {
  window: { from: number | null; to: number | null; days: number };
  outcomes: {
    total: number;
    completed: number;
    failed: number;
    completionRate: number;
    /** failure messages bucketed — the "where she gets stuck" view */
    failureModes: Record<string, number>;
  };
  verdicts: {
    /** formal GitHub reviews from quinn.review.submitted */
    APPROVE: number;
    COMMENT: number;
    REQUEST_CHANGES: number;
    total: number;
  };
  latencyMs: { min: number; median: number; p90: number; max: number; avg: number } | null;
  toolUse: {
    reviewsProfiled: number;
    clawpatchReviews: number;
    clawpatchRate: number;
    callsPerReview: { median: number; p90: number; max: number } | null;
    toolFrequency: Record<string, number>;
  };
  perRepo: Array<{ repo: string; reviews: number; approve: number; comment: number; requestChanges: number }>;
}

const PR_REVIEW_OUTCOME = /^autonomous\.outcome\..*\.pr_review$/;

/** Bucket a failure message into a stable, low-cardinality mode label. */
export function classifyFailure(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (!m) return "unknown";
  if (m.includes("recursion limit")) return "recursion_limit";
  if (m.includes("timed out") || m.includes("timeout") || m.includes("aborted")) return "timeout";
  if (m.includes("rate limit") || m.includes("429")) return "rate_limit";
  if (m.includes("circuit")) return "circuit_open";
  return "other";
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function computeQuinnReviewStats(events: EvalEvent[]): QuinnReviewStats {
  let from: number | null = null;
  let to: number | null = null;

  // ── outcomes ──────────────────────────────────────────────────────────────
  let completed = 0;
  let failed = 0;
  const failureModes: Record<string, number> = {};
  const latencies: number[] = [];

  // ── tool use (final toolNames per correlationId wins — the array is cumulative)
  const finalTools = new Map<string, string[]>();

  // ── verdicts / per-repo (from quinn.review.submitted) ──────────────────────
  const verdicts = { APPROVE: 0, COMMENT: 0, REQUEST_CHANGES: 0 };
  const repoMap = new Map<string, { reviews: number; approve: number; comment: number; requestChanges: number }>();

  for (const e of events) {
    if (e.ts) {
      from = from === null ? e.ts : Math.min(from, e.ts);
      to = to === null ? e.ts : Math.max(to, e.ts);
    }

    if (PR_REVIEW_OUTCOME.test(e.topic)) {
      const success = e.body.success === true;
      if (success) {
        completed++;
        const d = num(e.body.durationMs);
        if (d !== undefined) latencies.push(d);
      } else {
        failed++;
        const mode = classifyFailure(str(e.body.error) ?? str(e.body.textPreview));
        failureModes[mode] = (failureModes[mode] ?? 0) + 1;
      }
      continue;
    }

    if (e.topic === "agent.runtime.activity.tool.call" && e.body.skill === "pr_review") {
      const tn = Array.isArray(e.body.toolNames) ? (e.body.toolNames as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const prev = finalTools.get(e.correlationId);
      if (!prev || tn.length > prev.length) finalTools.set(e.correlationId, tn);
      continue;
    }

    if (e.topic === "quinn.review.submitted") {
      const event = str(e.body.event);
      const repo = `${str(e.body.owner) ?? "?"}/${str(e.body.repo) ?? "?"}`;
      const r = repoMap.get(repo) ?? { reviews: 0, approve: 0, comment: 0, requestChanges: 0 };
      r.reviews++;
      if (event === "APPROVE") { verdicts.APPROVE++; r.approve++; }
      else if (event === "COMMENT") { verdicts.COMMENT++; r.comment++; }
      else if (event === "REQUEST_CHANGES") { verdicts.REQUEST_CHANGES++; r.requestChanges++; }
      repoMap.set(repo, r);
      continue;
    }
  }

  const total = completed + failed;

  latencies.sort((a, b) => a - b);
  const latencyMs = latencies.length
    ? {
        min: latencies[0],
        median: pct(latencies, 0.5),
        p90: pct(latencies, 0.9),
        max: latencies[latencies.length - 1],
        avg: Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length),
      }
    : null;

  const toolFrequency: Record<string, number> = {};
  const lens: number[] = [];
  let clawpatch = 0;
  for (const seq of finalTools.values()) {
    lens.push(seq.length);
    for (const t of seq) toolFrequency[t] = (toolFrequency[t] ?? 0) + 1;
    if (seq.some((t) => t.includes("clawpatch"))) clawpatch++;
  }
  lens.sort((a, b) => a - b);
  const reviewsProfiled = finalTools.size;

  return {
    window: {
      from,
      to,
      days: from !== null && to !== null ? Math.max(0, (to - from) / 86_400_000) : 0,
    },
    outcomes: {
      total,
      completed,
      failed,
      completionRate: total ? completed / total : 0,
      failureModes,
    },
    verdicts: { ...verdicts, total: verdicts.APPROVE + verdicts.COMMENT + verdicts.REQUEST_CHANGES },
    latencyMs,
    toolUse: {
      reviewsProfiled,
      clawpatchReviews: clawpatch,
      clawpatchRate: reviewsProfiled ? clawpatch / reviewsProfiled : 0,
      callsPerReview: lens.length ? { median: pct(lens, 0.5), p90: pct(lens, 0.9), max: lens[lens.length - 1] } : null,
      toolFrequency,
    },
    perRepo: [...repoMap.entries()]
      .map(([repo, r]) => ({ repo, reviews: r.reviews, approve: r.approve, comment: r.comment, requestChanges: r.requestChanges }))
      .sort((a, b) => b.reviews - a.reviews),
  };
}

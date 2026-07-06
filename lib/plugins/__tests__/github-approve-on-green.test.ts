/**
 * Deterministic approve-on-terminal-green (#748, #848).
 *
 * Quinn never reliably chooses review_approve on the CI-completion re-dispatch,
 * so the merge-on-green gate never opens. `_handleCiCompletion` now posts a
 * formal APPROVE programmatically when CI is terminal-GREEN and Quinn's latest
 * review is a held COMMENT (no blockers) OR a prior CHANGES_REQUESTED (blocker
 * resolved). These tests cover the pure decision gates plus the orchestration's
 * fire / fall-through behavior with a stubbed GitHub API.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { allChecksGreen, quinnLatestReviewState, GitHubPlugin } from "../github.ts";
import { InMemoryEventBus } from "../../bus.ts";
import { ProjectRegistry } from "../../../src/plugins/project-registry.ts";

// ── Pure gates ────────────────────────────────────────────────────────────────

describe("allChecksGreen", () => {
  test("all completed + benign conclusions → green", () => {
    expect(allChecksGreen([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ])).toBe(true);
  });
  test("any failing conclusion → NOT green", () => {
    expect(allChecksGreen([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ])).toBe(false);
    for (const bad of ["cancelled", "timed_out", "action_required", "stale", null]) {
      expect(allChecksGreen([{ status: "completed", conclusion: bad }])).toBe(false);
    }
  });
  test("any non-terminal check → NOT green (terminal is necessary but not sufficient)", () => {
    expect(allChecksGreen([
      { status: "completed", conclusion: "success" },
      { status: "in_progress" },
    ])).toBe(false);
    expect(allChecksGreen([{ status: "queued" }])).toBe(false);
  });
  test("fail closed: empty / undefined check set is NOT green (no positive signal)", () => {
    expect(allChecksGreen(undefined)).toBe(false);
    expect(allChecksGreen([])).toBe(false);
  });
});

describe("quinnLatestReviewState", () => {
  test("returns the LATEST protoquinn review state (case-normalized)", () => {
    expect(quinnLatestReviewState([
      { user: { login: "protoquinn[bot]" }, state: "COMMENTED" },
    ])).toBe("COMMENTED");
    expect(quinnLatestReviewState([
      { user: { login: "ProtoQuinn" }, state: "commented" },
      { user: { login: "protoquinn[bot]" }, state: "approved" },
    ])).toBe("APPROVED");
  });
  test("ignores non-Quinn reviews when picking the latest", () => {
    expect(quinnLatestReviewState([
      { user: { login: "protoquinn[bot]" }, state: "COMMENTED" },
      { user: { login: "mabry1985" }, state: "CHANGES_REQUESTED" },
    ])).toBe("COMMENTED");
  });
  test("undefined when Quinn has no review", () => {
    expect(quinnLatestReviewState([])).toBeUndefined();
    expect(quinnLatestReviewState(undefined)).toBeUndefined();
    expect(quinnLatestReviewState([{ user: { login: "coderabbitai[bot]" }, state: "COMMENTED" }])).toBeUndefined();
  });
});

// ── Orchestration: _handleCiCompletion ─────────────────────────────────────────

const OWNER = "protoLabsAI";
const REPO = "widget";
const PR = 42;
const SHA = "deadbeefcafe";

interface StubOpts {
  reviews: Array<Record<string, unknown>>;
  /** Returns the check-runs body, or a 403 Response to simulate the CiAccessError path. */
  checkRuns?: Array<Record<string, unknown>>;
  checkRunsStatus?: number; // default 200
  /**
   * Review-thread resolution for the GraphQL gate (#858):
   *   true  → an unresolved thread remains, false → all resolved/none,
   *   null  → GraphQL errors (unknown). Default false (no unresolved threads).
   */
  threadsUnresolved?: boolean | null;
}

/** Records every APPROVE review submission, ack timeline comment, and merge PUT. */
interface Captured {
  approvePosts: Array<Record<string, unknown>>;
  commentPosts: Array<Record<string, unknown>>;
  mergePuts: Array<Record<string, unknown>>;
}

function ciCompletionPayload(): Record<string, unknown> {
  return {
    action: "completed",
    workflow_run: { head_sha: SHA },
    repository: { name: REPO, owner: { login: OWNER } },
  };
}

function stubFetch(opts: StubOpts): Captured {
  const captured: Captured = { approvePosts: [], commentPosts: [], mergePuts: [] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // approve-on-green ack timeline comment (#887)
    if (url.includes(`/issues/${PR}/comments`) && method === "POST") {
      captured.commentPosts.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ id: 1001 });
    }

    // _handleCiCompletion: resolve PRs for the SHA
    if (url.includes(`/commits/${SHA}/pulls`)) {
      return json([{ number: PR, state: "open", draft: false, head: { sha: SHA }, title: "t", html_url: "u", user: { login: "dev" } }]);
    }
    // reviews list (GET)
    if (url.includes(`/pulls/${PR}/reviews`) && method === "GET") {
      return json(opts.reviews);
    }
    // check-runs (both _ciTerminal and _ciGreen)
    if (url.includes(`/commits/${SHA}/check-runs`)) {
      const status = opts.checkRunsStatus ?? 200;
      if (status !== 200) return json({ message: "Forbidden" }, status);
      return json({ check_runs: opts.checkRuns ?? [] });
    }
    // GraphQL review-thread resolution (#858 gate for CHANGES_REQUESTED)
    if (url.includes("/graphql") && method === "POST") {
      const u = opts.threadsUnresolved === undefined ? false : opts.threadsUnresolved;
      if (u === null) return json({ message: "error" }, 500); // unknown
      const nodes = u ? [{ isResolved: false }] : [{ isResolved: true }];
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
    }
    // APPROVE submission (POST .../reviews) via submitPrReview (lib/github-review.ts)
    if (url.includes(`/pulls/${PR}/reviews`) && method === "POST") {
      captured.approvePosts.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ id: 999 });
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  }) as typeof fetch;

  return captured;
}

async function runCiCompletion(opts: StubOpts): Promise<Captured> {
  const captured = stubFetch(opts);
  const bus = new InMemoryEventBus();
  const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
  const getToken = async () => "fake-token";
  // _handleCiCompletion is private orchestration; drive it directly.
  await (plugin as unknown as {
    _handleCiCompletion: (e: string, p: Record<string, unknown>, b: InMemoryEventBus, g: () => Promise<string>) => Promise<void>;
  })._handleCiCompletion("workflow_run", ciCompletionPayload(), bus, getToken);
  return captured;
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

/** Let the fire-and-forget ack-comment POST (#887) settle before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("_handleCiCompletion — deterministic approve-on-green", () => {
  test("(a) terminal-green + prior COMMENTED → posts formal APPROVE", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.event).toBe("APPROVE");
    expect(captured.approvePosts[0]!.commit_id).toBe(SHA);
  });

  test("(a2) approve-on-green posts a visible promotion ack comment (#887)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    await flush();
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.commentPosts.length).toBe(1);
    const body = String(captured.commentPosts[0]!.body);
    expect(body).toContain("approve-on-green policy");
    expect(body).toContain("APPROVED");
  });

  test("no approve → no ack comment (the ack only rides a real promotion)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "failure" }], // red
    });
    await flush();
    expect(captured.approvePosts.length).toBe(0);
    expect(captured.commentPosts.length).toBe(0);
  });

  test("(a3) terminal-green + prior COMMENTED + UNRESOLVED thread → no approve (open finding on a WARN must not auto-merge)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
      threadsUnresolved: true,
    });
    expect(captured.approvePosts.length).toBe(0); // a CodeRabbit/Quinn finding thread is unresolved
  });

  test("(a4) terminal-green + prior COMMENTED + thread state unknown → no approve (fail-safe)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
      threadsUnresolved: null,
    });
    expect(captured.approvePosts.length).toBe(0); // unknown → conservative, defer to re-review
  });

  test("(b) terminal-green + prior CHANGES_REQUESTED + no unresolved threads → APPROVE (blocker resolved, #848/#858)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
      threadsUnresolved: false,
    });
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.event).toBe("APPROVE");
    expect(captured.approvePosts[0]!.commit_id).toBe(SHA);
    expect(captured.approvePosts[0]!.body).toContain("blocker resolved");
  });

  test("(b2) terminal-green + prior CHANGES_REQUESTED + UNRESOLVED thread → no approve (#858 — code concern remains)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
      threadsUnresolved: true,
    });
    expect(captured.approvePosts.length).toBe(0); // a real concern → don't auto-clear
  });

  test("(b3) terminal-green + prior CHANGES_REQUESTED + thread state unknown → no approve (#858 fail-safe)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
      threadsUnresolved: null,
    });
    expect(captured.approvePosts.length).toBe(0); // unknown → conservative, defer to re-review
  });

  test("(c) terminal-green + no prior Quinn review → no blind approve (falls through)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "mabry1985" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    expect(captured.approvePosts.length).toBe(0);
  });

  test("(d) terminal but RED + prior COMMENTED → no approve (falls through)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
    });
    expect(captured.approvePosts.length).toBe(0);
  });

  test("(f) terminal but RED + prior CHANGES_REQUESTED → no approve (blocker not resolved)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED" }],
      checkRuns: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
    });
    expect(captured.approvePosts.length).toBe(0);
  });

  test("(e) CI inaccessible (403) + prior COMMENTED → no approve (fail closed)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRunsStatus: 403,
    });
    expect(captured.approvePosts.length).toBe(0);
  });

  test("already APPROVED → no duplicate approve (latest state gate)", async () => {
    const captured = await runCiCompletion({
      reviews: [
        { user: { login: "protoquinn[bot]" }, state: "COMMENTED" },
        { user: { login: "protoquinn[bot]" }, state: "APPROVED" },
      ],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    expect(captured.approvePosts.length).toBe(0);
  });

  test("needs-review (Quinn COMMENTED but CI RED) is not swallowed — still re-dispatches (regression on the refactor)", async () => {
    // The extraction of _evaluateApproveOnGreen must keep the webhook's LLM
    // re-dispatch on a "needs-review" decision. Red CI + prior COMMENTED → no
    // auto-approve, and the CI-completion path re-dispatches pr_review.
    const captured = stubFetch({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
    });
    const bus = new InMemoryEventBus();
    let dispatched = false;
    bus.subscribe("message.inbound.github.#", "t", () => { dispatched = true; });
    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
    await (plugin as unknown as {
      _handleCiCompletion: (e: string, p: Record<string, unknown>, b: InMemoryEventBus, g: () => Promise<string>) => Promise<void>;
    })._handleCiCompletion("workflow_run", ciCompletionPayload(), bus, async () => "fake-token");
    expect(captured.approvePosts.length).toBe(0);
    expect(dispatched).toBe(true); // fell through to the LLM re-review
  });

  test("co-arriving terminal webhooks → exactly one APPROVE (dedup guard)", async () => {
    // Reproduces the duplicate-approval spam: GitHub fires check_suite,
    // workflow_run, and check_run completions near-simultaneously. They run
    // concurrently and each reads `reviews` as COMMENTED before any APPROVE
    // lands (the stub always returns COMMENTED, mirroring the real TOCTOU), so
    // without the in-flight dedup every webhook would post its own approval.
    const captured = stubFetch({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    const bus = new InMemoryEventBus();
    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
    const getToken = async () => "fake-token";
    const drive = () => (plugin as unknown as {
      _handleCiCompletion: (e: string, p: Record<string, unknown>, b: InMemoryEventBus, g: () => Promise<string>) => Promise<void>;
    })._handleCiCompletion("workflow_run", ciCompletionPayload(), bus, getToken);

    await Promise.all([drive(), drive(), drive()]);

    expect(captured.approvePosts.length).toBe(1);
  });
});

// ── Reconciliation sweep: _reconcileApproveOnGreen (#879) ──────────────────────
// Level-triggered backstop for the edge-triggered CI-completion webhook. When a
// workflow_run/check_suite completion is missed, the PR sits green forever; the
// sweep walks every open PR and re-runs the same approve decision.

interface SweepPr {
  number: number;
  sha: string;
  reviews: Array<Record<string, unknown>>;
  checkRuns: Array<Record<string, unknown>>;
  base?: string;
  /** HTTP status for a PUT /pulls/{n}/merge (default 200). */
  mergeStatus?: number;
  /** ISO created_at for the pulls listing (default: undefined — reads as "too young" for rescue). */
  createdAt?: string;
}

/** Stub GitHub REST for a reconciliation sweep over one repo's open PRs. */
function stubSweepFetch(prs: SweepPr[]): Captured {
  const captured: Captured = { approvePosts: [], commentPosts: [], mergePuts: [] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const byNum = new Map(prs.map((p) => [p.number, p]));
  const byNumFromUrl = (url: string) => {
    const m = url.match(/\/pulls\/(\d+)/);
    return m ? byNum.get(Number(m[1])) : undefined;
  };
  const bySha = new Map(prs.map((p) => [p.sha, p]));

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // approve-on-green ack timeline comment (#887)
    if (url.match(/\/issues\/\d+\/comments/) && method === "POST") {
      captured.commentPosts.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ id: 1001 });
    }
    // open-PR listing for the sweep
    if (url.includes("/pulls?state=open")) {
      return json(prs.map((p) => ({
        number: p.number, state: "open", draft: false,
        head: { sha: p.sha }, base: { ref: p.base ?? "feature/x" },
        title: "t", html_url: "u", user: { login: "dev" }, created_at: p.createdAt,
      })));
    }
    if (url.match(/\/pulls\/\d+\/reviews/) && method === "GET") {
      return json(byNumFromUrl(url)?.reviews ?? []);
    }
    if (url.includes("/check-runs")) {
      const sha = url.match(/\/commits\/([^/]+)\/check-runs/)?.[1] ?? "";
      return json({ check_runs: bySha.get(sha)?.checkRuns ?? [] });
    }
    if (url.includes("/graphql") && method === "POST") {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }] } } } } });
    }
    if (url.match(/\/pulls\/\d+\/reviews/) && method === "POST") {
      captured.approvePosts.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ id: 999 });
    }
    // merge-completion backstop (ws-5sc): PUT /pulls/{n}/merge
    if (url.match(/\/pulls\/\d+\/merge$/) && method === "PUT") {
      const p = byNumFromUrl(url);
      const status = p?.mergeStatus ?? 200;
      captured.mergePuts.push({ url, ...JSON.parse(String(init?.body ?? "{}")) });
      if (status !== 200) return json({ message: "refused" }, status);
      return json({ sha: "mergedsha", merged: true });
    }
    throw new Error(`unexpected fetch in sweep test: ${method} ${url}`);
  }) as typeof fetch;

  return captured;
}

async function runSweep(prs: SweepPr[]): Promise<Captured> {
  return (await runSweepWithPlugin(prs)).captured;
}

/** A one-off PR fixture in the wedged state: Quinn APPROVED, CI green, still open. */
function approvedGreenPr(number: number, sha: string, base: string): SweepPr {
  return {
    number,
    sha,
    base,
    reviews: [
      { user: { login: "protoquinn[bot]" }, state: "COMMENTED" },
      { user: { login: "protoquinn[bot]" }, state: "APPROVED" },
    ],
    checkRuns: [{ status: "completed", conclusion: "success" }],
  };
}

async function runSweepWithPlugin(
  prs: SweepPr[],
  opts: { seedWatch?: { key: string; ageMs: number }; plugin?: GitHubPlugin } = {},
): Promise<{ captured: Captured; plugin: GitHubPlugin; dispatched: string[] }> {
  const captured = stubSweepFetch(prs);
  const registry = new ProjectRegistry();
  // Registry is populated from a remote fetch in prod; stub the one accessor the
  // sweep reads so it iterates our fixture repo.
  (registry as unknown as { getGithubCoords: () => string[] }).getGithubCoords = () => [`${OWNER}/${REPO}`];
  const plugin = opts.plugin ?? new GitHubPlugin("/tmp/nonexistent-ws", registry);
  if (opts.seedWatch) {
    (plugin as unknown as { mergeCompletionFirstSeen: Map<string, number> }).mergeCompletionFirstSeen.set(
      opts.seedWatch.key,
      Date.now() - opts.seedWatch.ageMs,
    );
  }
  const bus = new InMemoryEventBus();
  const dispatched: string[] = [];
  bus.subscribe("message.inbound.github.#", "t", (m) => { dispatched.push(m.topic); });
  await (plugin as unknown as {
    _reconcileApproveOnGreen: (b: InMemoryEventBus, g: () => Promise<string>) => Promise<void>;
  })._reconcileApproveOnGreen(bus, async () => "fake-token");
  return { captured, plugin, dispatched };
}

describe("_reconcileApproveOnGreen — level-triggered backstop (#879)", () => {
  test("approves a stranded green PR the webhook missed (Quinn COMMENTED + terminal-green)", async () => {
    const captured = await runSweep([
      { number: 878, sha: "aaa1111", reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
        checkRuns: [{ status: "completed", conclusion: "success" }] },
    ]);
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.event).toBe("APPROVE");
    expect(captured.approvePosts[0]!.commit_id).toBe("aaa1111");
    await flush();
    expect(captured.commentPosts.length).toBe(1); // visible promotion ack (#887)
    expect(String(captured.commentPosts[0]!.body)).toContain("approve-on-green policy");
  });

  test("leaves an already-APPROVED PR alone (idempotent — no duplicate approve)", async () => {
    const captured = await runSweep([
      { number: 878, sha: "aaa1111", reviews: [
        { user: { login: "protoquinn[bot]" }, state: "COMMENTED" },
        { user: { login: "protoquinn[bot]" }, state: "APPROVED" },
      ], checkRuns: [{ status: "completed", conclusion: "success" }] },
    ]);
    expect(captured.approvePosts.length).toBe(0);
  });

  test("does not touch a PR Quinn never reviewed (no blind approve, no LLM spam)", async () => {
    const captured = await runSweep([
      { number: 878, sha: "aaa1111", reviews: [], checkRuns: [{ status: "completed", conclusion: "success" }] },
    ]);
    expect(captured.approvePosts.length).toBe(0);
  });

  test("skips a still-red PR; approves a sibling green PR in the same sweep", async () => {
    const captured = await runSweep([
      { number: 876, sha: "red0000", reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
        checkRuns: [{ status: "completed", conclusion: "failure" }] },
      { number: 878, sha: "grn1111", reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
        checkRuns: [{ status: "completed", conclusion: "success" }] },
    ]);
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.commit_id).toBe("grn1111");
  });

  test("APPROVED + green + still open, first sweep → watch only, NO merge (grace for native auto-merge)", async () => {
    const { captured, plugin } = await runSweepWithPlugin([approvedGreenPr(905, "abc9055", "main")]);
    expect(captured.mergePuts.length).toBe(0);
    expect(captured.approvePosts.length).toBe(0); // no duplicate approve either
    const watch = (plugin as unknown as { mergeCompletionFirstSeen: Map<string, number> }).mergeCompletionFirstSeen;
    expect(watch.size).toBe(1); // watching, will complete next sweep
  });

  test("APPROVED + green + open past grace → sweep completes the squash merge with head-SHA guard + timeline ack (ws-5sc)", async () => {
    const { captured } = await runSweepWithPlugin(
      [approvedGreenPr(905, "abc9055", "main")],
      { seedWatch: { key: `${OWNER}/${REPO}#905@abc9055`, ageMs: 10 * 60_000 } },
    );
    expect(captured.mergePuts.length).toBe(1);
    expect(captured.mergePuts[0]!.merge_method).toBe("squash");
    expect(captured.mergePuts[0]!.sha).toBe("abc9055"); // post-approval push would 409, never merge blind
    await flush();
    expect(captured.commentPosts.length).toBe(1);
    expect(String(captured.commentPosts[0]!.body)).toContain("ws-5sc");
  });

  test("stacked PR (base != main) APPROVED + green → never machine-merged, never watched", async () => {
    const { captured, plugin } = await runSweepWithPlugin(
      [approvedGreenPr(910, "stk0910", "feature/base-pr")],
      { seedWatch: { key: `${OWNER}/${REPO}#910@stk0910`, ageMs: 10 * 60_000 } },
    );
    expect(captured.mergePuts.length).toBe(0);
    // the seeded entry stays untouched but the stacked PR adds nothing new
    const watch = (plugin as unknown as { mergeCompletionFirstSeen: Map<string, number> }).mergeCompletionFirstSeen;
    expect(watch.size).toBe(1);
  });

  test("merge PUT 409 (head moved) → watch dropped, no ack, no crash; 405 keeps the watch for retry", async () => {
    const conflicted = { ...approvedGreenPr(911, "mvd0911", "main"), mergeStatus: 409 };
    const r1 = await runSweepWithPlugin([conflicted], { seedWatch: { key: `${OWNER}/${REPO}#911@mvd0911`, ageMs: 10 * 60_000 } });
    expect(r1.captured.mergePuts.length).toBe(1); // attempted
    await flush();
    expect(r1.captured.commentPosts.length).toBe(0); // refused → no ack
    const watch1 = (r1.plugin as unknown as { mergeCompletionFirstSeen: Map<string, number> }).mergeCompletionFirstSeen;
    expect(watch1.size).toBe(0); // stale watch dropped

    const blocked = { ...approvedGreenPr(912, "blk0912", "main"), mergeStatus: 405 };
    const r2 = await runSweepWithPlugin([blocked], { seedWatch: { key: `${OWNER}/${REPO}#912@blk0912`, ageMs: 10 * 60_000 } });
    expect(r2.captured.mergePuts.length).toBe(1);
    const watch2 = (r2.plugin as unknown as { mergeCompletionFirstSeen: Map<string, number> }).mergeCompletionFirstSeen;
    expect(watch2.size).toBe(1); // kept — retry next sweep
  });

  test("rescues an old unreviewed terminal PR with ONE dispatched review; second sweep is silent (ws-22l)", async () => {
    const stranded: SweepPr = {
      number: 906, sha: "los0906", reviews: [], createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      checkRuns: [{ status: "completed", conclusion: "success" }],
    };
    const r1 = await runSweepWithPlugin([stranded]);
    expect(r1.dispatched.length).toBe(1); // rescue review dispatched
    expect(r1.captured.approvePosts.length).toBe(0); // never a blind approve

    // same plugin, next sweep — the rescue map holds, no duplicate
    const r2 = await runSweepWithPlugin([stranded], { plugin: r1.plugin });
    expect(r2.dispatched.length).toBe(0);
  });

  test("does NOT rescue a young unreviewed PR (opened-dispatch may still be in flight)", async () => {
    const fresh: SweepPr = {
      number: 909, sha: "yng0909", reviews: [], createdAt: new Date().toISOString(),
      checkRuns: [{ status: "completed", conclusion: "success" }],
    };
    const { dispatched } = await runSweepWithPlugin([fresh]);
    expect(dispatched.length).toBe(0);
  });

  test("does NOT rescue an unreviewed PR whose CI is still running", async () => {
    const pending: SweepPr = {
      number: 910, sha: "pnd0910", reviews: [], createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      checkRuns: [{ status: "in_progress" }],
    };
    const { dispatched } = await runSweepWithPlugin([pending]);
    expect(dispatched.length).toBe(0);
  });

  test("covers a reviewed-but-UNREGISTERED repo (the approve-on-green gap fix)", async () => {
    // Registry is empty (repo not tagged / not in EXPLICIT), but Quinn reviewed
    // it this process → the sweep must still cover it via reviewedRepoCoords.
    // Without the union this green+COMMENTED PR is stranded (portfolio-plugin).
    const captured = stubSweepFetch([
      { number: 38, sha: "por0038", reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }],
        checkRuns: [{ status: "completed", conclusion: "success" }] },
    ]);
    const registry = new ProjectRegistry();
    (registry as unknown as { getGithubCoords: () => string[] }).getGithubCoords = () => []; // NOT registered
    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", registry);
    (plugin as unknown as { reviewedRepoCoords: Set<string> }).reviewedRepoCoords.add(`${OWNER}/${REPO}`);
    await (plugin as unknown as {
      _reconcileApproveOnGreen: (b: InMemoryEventBus, g: () => Promise<string>) => Promise<void>;
    })._reconcileApproveOnGreen(new InMemoryEventBus(), async () => "fake-token");
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.commit_id).toBe("por0038");
  });
});

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

/** Records every POST .../reviews submission so a test can assert the APPROVE. */
interface Captured {
  approvePosts: Array<Record<string, unknown>>;
}

function ciCompletionPayload(): Record<string, unknown> {
  return {
    action: "completed",
    workflow_run: { head_sha: SHA },
    repository: { name: REPO, owner: { login: OWNER } },
  };
}

function stubFetch(opts: StubOpts): Captured {
  const captured: Captured = { approvePosts: [] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

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
    // APPROVE submission (POST .../reviews) via GitHubReviewSubmitter
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
}

/** Stub GitHub REST for a reconciliation sweep over one repo's open PRs. */
function stubSweepFetch(prs: SweepPr[]): Captured {
  const captured: Captured = { approvePosts: [] };
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

    // open-PR listing for the sweep
    if (url.includes("/pulls?state=open")) {
      return json(prs.map((p) => ({
        number: p.number, state: "open", draft: false,
        head: { sha: p.sha }, base: { ref: p.base ?? "feature/x" },
        title: "t", html_url: "u", user: { login: "dev" },
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
    throw new Error(`unexpected fetch in sweep test: ${method} ${url}`);
  }) as typeof fetch;

  return captured;
}

async function runSweep(prs: SweepPr[]): Promise<Captured> {
  const captured = stubSweepFetch(prs);
  const registry = new ProjectRegistry();
  // Registry is populated from a remote fetch in prod; stub the one accessor the
  // sweep reads so it iterates our fixture repo.
  (registry as unknown as { getGithubCoords: () => string[] }).getGithubCoords = () => [`${OWNER}/${REPO}`];
  const plugin = new GitHubPlugin("/tmp/nonexistent-ws", registry);
  await (plugin as unknown as {
    _reconcileApproveOnGreen: (g: () => Promise<string>) => Promise<void>;
  })._reconcileApproveOnGreen(async () => "fake-token");
  return captured;
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
});

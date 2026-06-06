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

  test("(b) terminal-green + prior CHANGES_REQUESTED → posts formal APPROVE (blocker resolved, #848)", async () => {
    const captured = await runCiCompletion({
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED" }],
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });
    expect(captured.approvePosts.length).toBe(1);
    expect(captured.approvePosts[0]!.event).toBe("APPROVE");
    expect(captured.approvePosts[0]!.commit_id).toBe(SHA);
    expect(captured.approvePosts[0]!.body).toContain("blocker resolved");
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

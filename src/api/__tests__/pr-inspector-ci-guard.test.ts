/**
 * pr-inspector CI-terminal verdict guard (#3886).
 *
 * A formal verdict (APPROVE / REQUEST_CHANGES) requires every check on the
 * PR head to be terminal. While any check is still queued/in_progress the
 * verdict is held (409) so Quinn can't wedge a PR on a timing artifact
 * (#3886) or approve into a race with a still-running build (#3881). COMMENT
 * is always allowed.
 *
 * The module resolves `makeGitHubAuth()` at import time, so GITHUB_TOKEN is
 * set before the dynamic import (PAT path — no network call to mint a token).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRoutes, setGithubAuthForTesting } from "../pr-inspector.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { ApiContext } from "../types.ts";

const REPO = "protoLabsAI/widget";
const [OWNER, NAME] = REPO.split("/");
const PR = 42;
const HEAD_SHA = "deadbeefcafe0000deadbeefcafe0000deadbeef";

type CheckRun = { name: string; status: string; conclusion: string | null };

let checkRuns: CheckRun[];
let reviewsPosted: Array<{ event: string; body: string }>;
let origFetch: typeof globalThis.fetch;
// When true, the check-runs endpoint returns 403 — the reviewer-can't-see-CI
// access gap (#fix: CI-403 → Gap, not a blocking FAIL).
let ciForbidden: boolean;

function ctx(): ApiContext {
  return { bus: new InMemoryEventBus(), executorRegistry: {} as never } as unknown as ApiContext;
}

function getHandler() {
  const routes = createRoutes(ctx());
  const route = routes.find((r) => r.path === "/api/pr/inspect" && r.method === "POST");
  if (!route) throw new Error("pr/inspect route not found");
  return route.handler;
}

function inspect(body: Record<string, unknown>): Request {
  return new Request("http://local/api/pr/inspect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  // Inject a working auth getter via the test seam. We can't rely on the
  // real makeGitHubAuth() here: the onboarding suite mock.module()s
  // ../lib/github-auth.ts process-wide, so the resolver pr-inspector would
  // otherwise hit is whatever that mock was last left returning.
  setGithubAuthForTesting(async () => "test-token");
  checkRuns = [];
  reviewsPosted = [];
  ciForbidden = false;
  origFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";

    // PR detail → head SHA
    if (url.endsWith(`/pulls/${PR}`) && method === "GET") {
      return new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
    }
    // check-runs for head SHA
    if (url.includes(`/commits/${HEAD_SHA}/check-runs`)) {
      if (ciForbidden) return new Response("Forbidden", { status: 403 });
      return new Response(JSON.stringify({ check_runs: checkRuns }), { status: 200 });
    }
    // review submission
    if (url.endsWith(`/pulls/${PR}/reviews`) && method === "POST") {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { event: string; body: string };
      reviewsPosted.push({ event: parsed.event, body: parsed.body });
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  setGithubAuthForTesting(undefined); // reset to lazy makeGitHubAuth()
});

const PENDING: CheckRun[] = [
  { name: "test", status: "completed", conclusion: "success" },
  { name: "build", status: "in_progress", conclusion: null },
];
const TERMINAL_GREEN: CheckRun[] = [
  { name: "test", status: "completed", conclusion: "success" },
  { name: "build", status: "completed", conclusion: "success" },
];
const TERMINAL_RED: CheckRun[] = [
  { name: "test", status: "completed", conclusion: "failure" },
  { name: "build", status: "completed", conclusion: "success" },
];

describe("pr-inspector CI-terminal verdict guard (#3886)", () => {
  test("REQUEST_CHANGES held with 409 while a check is in_progress", async () => {
    checkRuns = PENDING;
    const res = await getHandler()(inspect({
      action: "review_request_changes", repo: REPO, pr_number: PR, body: "needs work",
    }), {});
    expect(res.status).toBe(409);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("CI is still running");
    expect(json.error).toContain("build"); // names the pending check
    expect(reviewsPosted).toHaveLength(0); // verdict NOT submitted
  });

  test("APPROVE held with 409 while a check is in_progress (anti-#3881 race)", async () => {
    checkRuns = PENDING;
    const res = await getHandler()(inspect({
      action: "review_approve", repo: REPO, pr_number: PR,
    }), {});
    expect(res.status).toBe(409);
    expect(reviewsPosted).toHaveLength(0);
  });

  test("COMMENT is always allowed, even with pending CI", async () => {
    checkRuns = PENDING;
    const res = await getHandler()(inspect({
      action: "review_comment", repo: REPO, pr_number: PR, body: "interim findings",
    }), {});
    expect(res.status).toBe(200);
    expect(reviewsPosted).toEqual([{ event: "COMMENT", body: "interim findings" }]);
  });

  test("REQUEST_CHANGES proceeds once every check is terminal", async () => {
    checkRuns = TERMINAL_RED;
    const res = await getHandler()(inspect({
      action: "review_request_changes", repo: REPO, pr_number: PR, body: "test failed",
    }), {});
    expect(res.status).toBe(200);
    expect(reviewsPosted).toEqual([{ event: "REQUEST_CHANGES", body: "test failed" }]);
  });

  test("APPROVE proceeds once every check is terminal-green", async () => {
    checkRuns = TERMINAL_GREEN;
    const res = await getHandler()(inspect({
      action: "review_approve", repo: REPO, pr_number: PR, body: "lgtm",
    }), {});
    expect(res.status).toBe(200);
    expect(reviewsPosted).toEqual([{ event: "APPROVE", body: "lgtm" }]);
  });

  test("verdict allowed when the PR has no checks at all (nothing to wait for)", async () => {
    checkRuns = [];
    const res = await getHandler()(inspect({
      action: "review_approve", repo: REPO, pr_number: PR,
    }), {});
    expect(res.status).toBe(200);
    expect(reviewsPosted).toHaveLength(1);
    expect(reviewsPosted[0]!.event).toBe("APPROVE");
  });
});

describe("pr-inspector CI inaccessible (403) → Gap, not a blocking FAIL", () => {
  test("check_ci returns a graceful Gap message (no 500) on 403", async () => {
    ciForbidden = true;
    const res = await getHandler()(inspect({
      action: "check_ci", repo: REPO, pr_number: PR,
    }), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { result: string } };
    expect(json.success).toBe(true);
    expect(json.data.result).toContain("not accessible");
    expect(json.data.result).toContain("403");
    expect(json.data.result).toContain("Gap");
  });

  test("APPROVE held with 409 (not 500) when CI is inaccessible", async () => {
    ciForbidden = true;
    const res = await getHandler()(inspect({
      action: "review_approve", repo: REPO, pr_number: PR,
    }), {});
    expect(res.status).toBe(409);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("not accessible");
    expect(json.error).toContain("review_comment");
    expect(reviewsPosted).toHaveLength(0);
  });

  test("REQUEST_CHANGES held with 409 (not a blocking verdict) when CI is inaccessible", async () => {
    ciForbidden = true;
    const res = await getHandler()(inspect({
      action: "review_request_changes", repo: REPO, pr_number: PR, body: "x",
    }), {});
    expect(res.status).toBe(409);
    expect(reviewsPosted).toHaveLength(0);
  });

  test("COMMENT is allowed when CI is inaccessible", async () => {
    ciForbidden = true;
    const res = await getHandler()(inspect({
      action: "review_comment", repo: REPO, pr_number: PR, body: "review with CI-access gap noted",
    }), {});
    expect(res.status).toBe(200);
    expect(reviewsPosted).toEqual([{ event: "COMMENT", body: "review with CI-access gap noted" }]);
  });
});

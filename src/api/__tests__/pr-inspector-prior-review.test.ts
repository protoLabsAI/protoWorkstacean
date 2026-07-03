/**
 * pr-inspector `prior_review` action — re-review memory. Recalls the reviewer's
 * OWN most-recent verdict on a PR so a re-review is incremental, not a cold
 * start. GitHub is the source of truth (formal reviews + head SHA); the action
 * isolates protoquinn[bot]'s verdict from CodeRabbit / human reviews and reports
 * whether the head moved since that review.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRoutes, setGithubAuthForTesting } from "../pr-inspector.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { ApiContext } from "../types.ts";

const OWNER = "protoLabsAI";
const REPO = "widget";
const PR = 42;

interface Stub {
  /** head.sha the PR GET returns. */
  headSha?: string;
  /** reviews list the reviews GET returns. */
  reviews?: Array<Record<string, unknown>>;
  /** status for the PR GET (default 200). */
  prStatus?: number;
}

let origFetch: typeof globalThis.fetch;

function ctx(): ApiContext {
  return { bus: new InMemoryEventBus(), executorRegistry: {} as never } as unknown as ApiContext;
}

function handler() {
  const route = createRoutes(ctx()).find((r) => r.path === "/api/pr/inspect" && r.method === "POST");
  if (!route) throw new Error("route not found");
  return route.handler;
}

function inspect(body: Record<string, unknown>): Request {
  return new Request("http://local/api/pr/inspect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function stub(s: Stub): void {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/pulls/${PR}/reviews?per_page=100`)) return json(s.reviews ?? []);
    if (url.endsWith(`/pulls/${PR}`)) {
      if (s.prStatus && s.prStatus !== 200) return json({ message: "Forbidden" }, s.prStatus);
      return json({ head: { sha: s.headSha ?? "aaaaaaa000" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
}

async function run(body: Record<string, unknown>): Promise<{ status: number; result: string }> {
  const res = await handler()(inspect({ action: "prior_review", repo: `${OWNER}/${REPO}`, pr_number: PR, ...body }), {});
  const j = (await res.json()) as { success: boolean; data?: { result: string }; error?: string };
  return { status: res.status, result: j.data?.result ?? j.error ?? "" };
}

beforeEach(() => {
  setGithubAuthForTesting(async () => "test-token");
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  setGithubAuthForTesting(undefined);
});

describe("pr-inspector prior_review", () => {
  test("no prior reviewer review → first-pass message", async () => {
    stub({ reviews: [{ user: { login: "coderabbitai[bot]" }, state: "COMMENTED", body: "cr", commit_id: "x", submitted_at: "2026-07-01T00:00:00Z" }] });
    const { status, result } = await run({});
    expect(status).toBe(200);
    expect(result).toContain("FIRST pass");
  });

  test("prior COMMENTED + head unchanged → 'CI settling, reaffirm' + prior body", async () => {
    stub({
      headSha: "sha1111aaaa",
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "COMMENTED", body: "VERDICT: WARN\nObservations\n- LOW: nit", commit_id: "sha1111aaaa", submitted_at: "2026-07-02T10:00:00Z" }],
    });
    const { result } = await run({});
    expect(result).toContain("COMMENTED");
    expect(result).toContain("unchanged");
    expect(result).toContain("reaffirm");
    expect(result).toContain("LOW: nit"); // prior verdict body echoed back
  });

  test("prior CHANGES_REQUESTED + head advanced → 'INCREMENTAL' delta guidance", async () => {
    stub({
      headSha: "newsha2222",
      reviews: [{ user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED", body: "VERDICT: FAIL", commit_id: "oldsha1111", submitted_at: "2026-07-02T10:00:00Z" }],
    });
    const { result } = await run({});
    expect(result).toContain("CHANGES_REQUESTED");
    expect(result).toContain("INCREMENTAL");
    expect(result).toContain("newsha2"); // current head short SHA
    expect(result).toContain("oldsha1"); // reviewed short SHA
  });

  test("picks the LATEST reviewer verdict, ignoring CodeRabbit + humans", async () => {
    stub({
      headSha: "headaaaa11",
      reviews: [
        { user: { login: "protoquinn[bot]" }, state: "CHANGES_REQUESTED", body: "old", commit_id: "s1", submitted_at: "2026-07-01T00:00:00Z" },
        { user: { login: "coderabbitai[bot]" }, state: "COMMENTED", body: "cr", commit_id: "s2", submitted_at: "2026-07-02T00:00:00Z" },
        { user: { login: "mabry1985" }, state: "APPROVED", body: "lgtm", commit_id: "s2", submitted_at: "2026-07-02T01:00:00Z" },
        { user: { login: "protoquinn[bot]" }, state: "APPROVED", body: "now good", commit_id: "headaaaa11", submitted_at: "2026-07-03T00:00:00Z" },
      ],
    });
    const { result } = await run({});
    expect(result).toContain("APPROVED"); // Quinn's latest, not her earlier CHANGES_REQUESTED
    expect(result).toContain("now good");
    expect(result).not.toContain("lgtm"); // human review ignored
  });

  test("403 on the PR fetch → advisory fallback, not an error", async () => {
    stub({ prStatus: 403, reviews: [] });
    const { status, result } = await run({});
    expect(status).toBe(200);
    expect(result).toContain("not accessible");
    expect(result).toContain("full review");
  });

  test("missing pr_number → 400", async () => {
    stub({ reviews: [] });
    const res = await handler()(inspect({ action: "prior_review", repo: `${OWNER}/${REPO}` }), {});
    expect(res.status).toBe(400);
  });
});

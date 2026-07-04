/**
 * Structural-review (clawpatch) trigger (#891). `diff_summary` computes the
 * objective trigger — >3 files / >120 changed lines / a sensitive path — from
 * authoritative GitHub metrics (PR JSON + full-diff paths, neither truncated),
 * so clawpatch stops under-firing because the model couldn't count a truncated
 * diff. Covers the pure decision + the diff_summary directive wiring.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRoutes, setGithubAuthForTesting, computeStructuralTrigger } from "../pr-inspector.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { ApiContext } from "../types.ts";

// ── Pure trigger ──────────────────────────────────────────────────────────────

describe("computeStructuralTrigger", () => {
  test("small contained diff → not required", () => {
    const t = computeStructuralTrigger({ changedFiles: 2, linesChanged: 40, sensitivePaths: [] });
    expect(t.required).toBe(false);
    expect(t.reasons).toHaveLength(0);
  });
  test("> 3 files → required", () => {
    const t = computeStructuralTrigger({ changedFiles: 4, linesChanged: 10, sensitivePaths: [] });
    expect(t.required).toBe(true);
    expect(t.reasons[0]).toContain("4 files");
  });
  test("boundary: exactly 3 files / 120 lines → NOT required (strictly greater)", () => {
    expect(computeStructuralTrigger({ changedFiles: 3, linesChanged: 120, sensitivePaths: [] }).required).toBe(false);
  });
  test("> 120 lines → required", () => {
    const t = computeStructuralTrigger({ changedFiles: 1, linesChanged: 121, sensitivePaths: [] });
    expect(t.required).toBe(true);
    expect(t.reasons[0]).toContain("121 lines");
  });
  test("sensitive path → required even when tiny", () => {
    const t = computeStructuralTrigger({ changedFiles: 1, linesChanged: 3, sensitivePaths: ["lib/auth/session.ts"] });
    expect(t.required).toBe(true);
    expect(t.reasons[0]).toContain("sensitive");
  });
  test("multiple triggers accumulate reasons", () => {
    const t = computeStructuralTrigger({ changedFiles: 9, linesChanged: 500, sensitivePaths: [".github/workflows/ci.yml"] });
    expect(t.required).toBe(true);
    expect(t.reasons).toHaveLength(3);
  });
});

// ── diff_summary wiring ───────────────────────────────────────────────────────

const OWNER = "protoLabsAI";
const REPO = "widget";
const PR = 42;

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

/** Stub PR JSON (metrics) + the raw .diff response. */
function stub(meta: { changed_files: number; additions: number; deletions: number }, diff: string): void {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? "";
    // the raw-diff fetch uses Accept: application/vnd.github.v3.diff
    if (accept.includes("diff")) return new Response(diff, { status: 200 });
    return json(meta); // PR JSON metrics
  }) as typeof globalThis.fetch;
}

async function runDiff(): Promise<string> {
  const res = await handler()(inspect({ action: "diff_summary", repo: `${OWNER}/${REPO}`, pr_number: PR }), {});
  const j = (await res.json()) as { data?: { result: string } };
  return j.data?.result ?? "";
}

beforeEach(() => {
  setGithubAuthForTesting(async () => "test-token");
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  setGithubAuthForTesting(undefined);
});

describe("pr-inspector diff_summary — structural trigger directive", () => {
  test("large diff → STRUCTURAL REVIEW REQUIRED with file/line reasons", async () => {
    stub(
      { changed_files: 8, additions: 200, deletions: 60 },
      "diff --git a/src/a.ts b/src/a.ts\n+one\ndiff --git a/src/b.ts b/src/b.ts\n+two",
    );
    const out = await runDiff();
    expect(out).toContain("STRUCTURAL REVIEW REQUIRED");
    expect(out).toContain("8 files");
    expect(out).toContain("260 lines");
    expect(out).toContain("(8 files, +200/-60)");
  });

  test("tiny non-sensitive diff → Structural review optional", async () => {
    stub(
      { changed_files: 1, additions: 3, deletions: 1 },
      "diff --git a/README.md b/README.md\n+docs tweak",
    );
    const out = await runDiff();
    expect(out).toContain("Structural review optional");
    expect(out).not.toContain("REQUIRED");
  });

  test("tiny but sensitive path → REQUIRED (parsed from the full diff, not the metrics)", async () => {
    stub(
      { changed_files: 1, additions: 4, deletions: 0 },
      "diff --git a/lib/auth/session.ts b/lib/auth/session.ts\n+const token = mint()",
    );
    const out = await runDiff();
    expect(out).toContain("STRUCTURAL REVIEW REQUIRED");
    expect(out).toContain("sensitive path");
    expect(out).toContain("lib/auth/session.ts");
  });

  test("still returns the diff preview", async () => {
    stub({ changed_files: 1, additions: 1, deletions: 0 }, "diff --git a/x b/x\n+line");
    const out = await runDiff();
    expect(out).toContain("```diff");
    expect(out).toContain("+line");
  });
});

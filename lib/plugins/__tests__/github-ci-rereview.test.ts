/**
 * CI-completion → pr_review re-dispatch gating (#721). Quinn's terminal-CI
 * guard holds the formal verdict to a provisional COMMENT while checks run;
 * these are the pure gates that decide when CI completion re-invokes Quinn so
 * that COMMENT upgrades to a formal APPROVE / REQUEST_CHANGES.
 */

import { describe, expect, test } from "bun:test";
import {
  ciCompletionHeadSha,
  prEligibleForCiReview,
  allChecksTerminal,
  quinnHasReviewed,
} from "../github.ts";

describe("ciCompletionHeadSha", () => {
  test("reads head_sha from a workflow_run payload", () => {
    expect(ciCompletionHeadSha({ workflow_run: { head_sha: "abc123" } })).toBe("abc123");
  });
  test("reads head_sha from a check_suite payload", () => {
    expect(ciCompletionHeadSha({ check_suite: { head_sha: "def456" } })).toBe("def456");
  });
  test("undefined when neither present or sha is empty/non-string", () => {
    expect(ciCompletionHeadSha({})).toBeUndefined();
    expect(ciCompletionHeadSha({ workflow_run: { head_sha: "" } })).toBeUndefined();
    expect(ciCompletionHeadSha({ check_suite: { head_sha: 42 } })).toBeUndefined();
  });
});

describe("prEligibleForCiReview", () => {
  const base = { number: 5, state: "open", draft: false, head: { sha: "sha1" } };

  test("open, non-draft PR whose head is still the SHA → eligible", () => {
    expect(prEligibleForCiReview(base, "sha1")).toBe(true);
  });
  test("rejects closed / merged PRs", () => {
    expect(prEligibleForCiReview({ ...base, state: "closed" }, "sha1")).toBe(false);
  });
  test("rejects drafts", () => {
    expect(prEligibleForCiReview({ ...base, draft: true }, "sha1")).toBe(false);
  });
  test("rejects a stale head — a newer push already triggers a fresh synchronize review", () => {
    expect(prEligibleForCiReview({ ...base, head: { sha: "sha2" } }, "sha1")).toBe(false);
  });
  test("rejects when number is missing", () => {
    expect(prEligibleForCiReview({ state: "open", draft: false, head: { sha: "sha1" } }, "sha1")).toBe(false);
  });
});

describe("allChecksTerminal", () => {
  test("no checks → terminal (nothing to wait for)", () => {
    expect(allChecksTerminal(undefined)).toBe(true);
    expect(allChecksTerminal([])).toBe(true);
  });
  test("all completed → terminal regardless of conclusion (pass or fail)", () => {
    expect(allChecksTerminal([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ])).toBe(true);
  });
  test("any in-flight check → not terminal (defer the formal verdict)", () => {
    expect(allChecksTerminal([
      { status: "completed", conclusion: "success" },
      { status: "in_progress" },
    ])).toBe(false);
    expect(allChecksTerminal([{ status: "queued" }])).toBe(false);
  });
});

describe("quinnHasReviewed", () => {
  test("true when a protoquinn[bot] review exists (the provisional→formal case)", () => {
    expect(quinnHasReviewed([{ user: { login: "protoquinn[bot]" }, state: "COMMENTED" }])).toBe(true);
    expect(quinnHasReviewed([{ user: { login: "ProtoQuinn" }, state: "COMMENTED" }])).toBe(true);
  });
  test("false when only humans / other bots have reviewed — never a surprise first-touch from CI", () => {
    expect(quinnHasReviewed([{ user: { login: "mabry1985" } }, { user: { login: "coderabbitai[bot]" } }])).toBe(false);
    expect(quinnHasReviewed([])).toBe(false);
    expect(quinnHasReviewed(undefined)).toBe(false);
  });
});

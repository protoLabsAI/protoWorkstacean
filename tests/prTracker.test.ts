import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PullRequestTracker } from "../src/state/prTracker.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let tracker: PullRequestTracker;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pr-tracker-test-"));
  tracker = new PullRequestTracker(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PullRequestTracker", () => {
  test("returns null for untracked PR", async () => {
    const sha = await tracker.getLastReviewedSha("owner", "repo", 1);
    expect(sha).toBeNull();
  });

  test("stores and retrieves last reviewed SHA", async () => {
    await tracker.setLastReviewedSha("owner", "repo", 42, "abc123");
    const sha = await tracker.getLastReviewedSha("owner", "repo", 42);
    expect(sha).toBe("abc123");
  });

  test("updates SHA when called again", async () => {
    await tracker.setLastReviewedSha("owner", "repo", 1, "sha-first");
    await tracker.setLastReviewedSha("owner", "repo", 1, "sha-second");
    const sha = await tracker.getLastReviewedSha("owner", "repo", 1);
    expect(sha).toBe("sha-second");
  });

  test("tracks multiple PRs independently", async () => {
    await tracker.setLastReviewedSha("owner", "repo", 1, "sha-pr1");
    await tracker.setLastReviewedSha("owner", "repo", 2, "sha-pr2");
    await tracker.setLastReviewedSha("owner", "other-repo", 1, "sha-other");

    expect(await tracker.getLastReviewedSha("owner", "repo", 1)).toBe("sha-pr1");
    expect(await tracker.getLastReviewedSha("owner", "repo", 2)).toBe("sha-pr2");
    expect(await tracker.getLastReviewedSha("owner", "other-repo", 1)).toBe("sha-other");
  });

  test("clearPR removes tracking for a PR", async () => {
    await tracker.setLastReviewedSha("owner", "repo", 5, "sha-abc");
    await tracker.clearPR("owner", "repo", 5);
    const sha = await tracker.getLastReviewedSha("owner", "repo", 5);
    expect(sha).toBeNull();
  });

  test("persists state across instances (file-based)", async () => {
    await tracker.setLastReviewedSha("owner", "repo", 10, "persistent-sha");

    // Create new instance pointing to same directory
    const tracker2 = new PullRequestTracker(tmpDir);
    const sha = await tracker2.getLastReviewedSha("owner", "repo", 10);
    expect(sha).toBe("persistent-sha");
  });

  test("handles clearPR on non-existent PR gracefully", async () => {
    // Should not throw
    await tracker.clearPR("owner", "repo", 999);
    const sha = await tracker.getLastReviewedSha("owner", "repo", 999);
    expect(sha).toBeNull();
  });
});

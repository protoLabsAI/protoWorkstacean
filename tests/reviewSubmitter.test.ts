import { describe, test, expect } from "bun:test";
import { toGitHubComment } from "../src/github/types.ts";
import type { ValidatedComment } from "../src/diff/types.ts";

describe("toGitHubComment", () => {
  test("converts single-line comment correctly", () => {
    const comment: ValidatedComment = {
      path: "src/foo.ts",
      line: 42,
      side: "RIGHT",
      body: "This is a bug",
      severity: "blocker",
      category: "bug",
    };

    const gh = toGitHubComment(comment);
    expect(gh.path).toBe("src/foo.ts");
    expect(gh.line).toBe(42);
    expect(gh.side).toBe("RIGHT");
    expect(gh.body).toBe("This is a bug");
    expect(gh.start_line).toBeUndefined();
    expect(gh.start_side).toBeUndefined();
  });

  test("converts multi-line comment with start_line", () => {
    const comment: ValidatedComment = {
      path: "src/bar.ts",
      line: 50,
      start_line: 45,
      side: "RIGHT",
      body: "Multi-line issue",
      severity: "suggestion",
      category: "performance",
    };

    const gh = toGitHubComment(comment);
    expect(gh.line).toBe(50);
    expect(gh.start_line).toBe(45);
    expect(gh.start_side).toBe("RIGHT");
  });

  test("omits start_line when it equals line", () => {
    const comment: ValidatedComment = {
      path: "src/baz.ts",
      line: 10,
      start_line: 10,
      side: "RIGHT",
      body: "Same line",
      severity: "nit",
      category: "style",
    };

    const gh = toGitHubComment(comment);
    expect(gh.start_line).toBeUndefined();
    expect(gh.start_side).toBeUndefined();
  });
});

describe("GitHubReviewSubmitter — headSha validation", () => {
  test("throws if headSha is empty string", async () => {
    const { GitHubReviewSubmitter } = await import("../src/github/reviewSubmitter.ts");
    const submitter = new GitHubReviewSubmitter(async () => "fake-token");

    await expect(
      submitter.submitReview("owner", "repo", 1, "", "APPROVE", "summary", [])
    ).rejects.toThrow("commit_id");
  });
});

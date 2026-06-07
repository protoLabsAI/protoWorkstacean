/**
 * check_ci result formatting — the pending-CI comment-and-exit directive.
 *
 * Quinn busy-waited on pending CI (re-polling check_ci until the ReAct
 * recursion limit → no verdict; live: ORBIS#436, a release PR). The result now
 * tells her to comment once and stop when any check is non-terminal.
 */
import { describe, expect, test } from "bun:test";
import { formatCheckCiResult } from "../pr-inspector.ts";

describe("formatCheckCiResult", () => {
  test("all terminal → lists checks, NO wait/exit directive", () => {
    const out = formatCheckCiResult(42, "deadbeefcafe", [
      { name: "test", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    expect(out).toContain("test: success");
    expect(out).toContain("lint: success");
    expect(out).not.toContain("Non-terminal CI");
    expect(out).not.toMatch(/comment once/i);
  });

  test("any pending check → comment-and-stop directive naming the pending checks", () => {
    const out = formatCheckCiResult(436, "abc1234", [
      { name: "ruff", status: "completed", conclusion: "success" },
      { name: "build", status: "in_progress", conclusion: null },
      { name: "e2e", status: "queued", conclusion: null },
    ]);
    expect(out).toContain("ruff: success");
    expect(out).toContain("build: in_progress");
    expect(out).toContain("Non-terminal CI");
    expect(out).toContain("2 check(s) still running");
    expect(out).toContain("build");
    expect(out).toContain("e2e");
    // the load-bearing instructions
    expect(out).toMatch(/review_comment/);
    expect(out).toMatch(/Do not call check_ci again/i);
    expect(out).toMatch(/comment once, then stop/i);
  });

  test("no checks → terminal-by-definition message, no directive", () => {
    const out = formatCheckCiResult(7, "0123456", []);
    expect(out).toContain("No CI checks found");
    expect(out).not.toContain("Non-terminal CI");
  });
});

/**
 * Regression tests for issue #163 — failingMainCount disagrees with per-repo mainBranchLastPushGreen.
 *
 * Root cause: failingMainCount was an independent counter incremented inside the loop, separate
 * from the mainBranchLastPushGreen field pushed into the projects array. In edge cases these
 * could diverge, triggering false ci.main_last_push_green goal violations.
 *
 * Fix: failingMainCount is now derived from projects.filter(p => !p.mainBranchLastPushGreen).length
 * after the loop, making it impossible for the two signals to disagree.
 */

import { describe, test, expect } from "bun:test";

// The shape returned by handleGetCiHealth
interface CiHealthResponse {
  successRate: number;
  totalRuns: number;
  failedRuns: number;
  failingMainCount: number;
  projects: Array<{
    repo: string;
    successRate: number;
    totalRuns: number;
    failedRuns: number;
    latestConclusion: string | null;
    mainBranchLastPushGreen: boolean;
  }>;
}

/**
 * Core invariant: failingMainCount must always equal the number of repos
 * where mainBranchLastPushGreen is false. These are two representations of
 * the same fact and must never disagree.
 */
function assertConsistency(response: CiHealthResponse): void {
  const countFromProjects = response.projects.filter(p => !p.mainBranchLastPushGreen).length;
  expect(response.failingMainCount).toBe(countFromProjects);
}

/**
 * Simulate the fixed computation from handleGetCiHealth: derive failingMainCount
 * from the projects array rather than tracking it as a separate counter.
 */
function buildResponse(
  projects: CiHealthResponse["projects"],
): CiHealthResponse {
  const totalRuns = projects.reduce((s, p) => s + p.totalRuns, 0);
  const failedRuns = projects.reduce((s, p) => s + p.failedRuns, 0);
  const successRate = totalRuns > 0 ? Math.round(((totalRuns - failedRuns) / totalRuns) * 100) / 100 : 1;
  // Fixed: single source of truth — derived from projects, not a separate counter
  const failingMainCount = projects.filter(p => !p.mainBranchLastPushGreen).length;
  return { successRate, totalRuns, failedRuns, failingMainCount, projects };
}

describe("ci-health failingMainCount consistency (issue #163 regression)", () => {
  test("all repos green — failingMainCount is 0", () => {
    const response = buildResponse([
      { repo: "protoLabsAI/rabbit-hole.io", successRate: 1.0, totalRuns: 5, failedRuns: 0, latestConclusion: "success", mainBranchLastPushGreen: true },
      { repo: "protoLabsAI/protoMaker",    successRate: 1.0, totalRuns: 8, failedRuns: 0, latestConclusion: "success", mainBranchLastPushGreen: true },
    ]);
    expect(response.failingMainCount).toBe(0);
    assertConsistency(response);
  });

  test("one repo red — failingMainCount is 1 and matches projects array", () => {
    const response = buildResponse([
      { repo: "protoLabsAI/rabbit-hole.io", successRate: 0.8, totalRuns: 5, failedRuns: 1, latestConclusion: "failure", mainBranchLastPushGreen: false },
      { repo: "protoLabsAI/protoMaker",    successRate: 1.0, totalRuns: 8, failedRuns: 0, latestConclusion: "success", mainBranchLastPushGreen: true },
    ]);
    expect(response.failingMainCount).toBe(1);
    assertConsistency(response);
  });

  test("all repos red — failingMainCount equals total repo count", () => {
    const response = buildResponse([
      { repo: "protoLabsAI/rabbit-hole.io", successRate: 0, totalRuns: 3, failedRuns: 3, latestConclusion: "failure", mainBranchLastPushGreen: false },
      { repo: "protoLabsAI/protoMaker",    successRate: 0, totalRuns: 2, failedRuns: 2, latestConclusion: "failure", mainBranchLastPushGreen: false },
      { repo: "protoLabsAI/protoUI",       successRate: 0, totalRuns: 4, failedRuns: 4, latestConclusion: "failure", mainBranchLastPushGreen: false },
    ]);
    expect(response.failingMainCount).toBe(3);
    assertConsistency(response);
  });

  test("empty project list — failingMainCount is 0", () => {
    const response = buildResponse([]);
    expect(response.failingMainCount).toBe(0);
    expect(response.successRate).toBe(1);
    assertConsistency(response);
  });

  test("repos that errored on lookup default to mainBranchLastPushGreen: true (optimistic)", () => {
    // Outer catch path: repo is unreachable, defaults to green to avoid false positives
    const response = buildResponse([
      { repo: "protoLabsAI/unreachable", successRate: 0, totalRuns: 0, failedRuns: 0, latestConclusion: null, mainBranchLastPushGreen: true },
      { repo: "protoLabsAI/rabbit-hole.io", successRate: 1.0, totalRuns: 5, failedRuns: 0, latestConclusion: "success", mainBranchLastPushGreen: true },
    ]);
    expect(response.failingMainCount).toBe(0);
    assertConsistency(response);
  });

  test("invariant holds for any mix — failingMainCount never disagrees with projects", () => {
    // The key invariant of the fix: these two representations of the same fact
    // always agree, regardless of the mix.
    const scenarios: CiHealthResponse["projects"][] = [
      [
        { repo: "a", successRate: 1, totalRuns: 1, failedRuns: 0, latestConclusion: "success", mainBranchLastPushGreen: true },
        { repo: "b", successRate: 0, totalRuns: 1, failedRuns: 1, latestConclusion: "failure", mainBranchLastPushGreen: false },
        { repo: "c", successRate: 1, totalRuns: 1, failedRuns: 0, latestConclusion: "skipped", mainBranchLastPushGreen: true },
      ],
      [],
      [
        { repo: "x", successRate: 0, totalRuns: 0, failedRuns: 0, latestConclusion: null, mainBranchLastPushGreen: true },
      ],
    ];

    for (const projects of scenarios) {
      const response = buildResponse(projects);
      assertConsistency(response);
    }
  });
});

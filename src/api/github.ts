/**
 * GitHub API routes — CI health, PR pipeline, branch drift.
 * All poll GitHub REST API, subject to rate limits.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function loadProjectRepos(workspaceDir: string): string[] {
  const projectsPath = join(workspaceDir, "projects.yaml");
  if (!existsSync(projectsPath)) return [];
  try {
    const parsed = parseYaml(readFileSync(projectsPath, "utf8")) as { projects?: Array<{ github?: string }> };
    return (parsed.projects ?? []).map(p => p.github).filter((g): g is string => !!g);
  } catch { return []; }
}

async function ghApi(path: string): Promise<unknown> {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${path}`);
  return resp.json();
}

export function createRoutes(ctx: ApiContext): Route[] {
  const repos = () => loadProjectRepos(ctx.workspaceDir);

  async function handleGetCiHealth(): Promise<Response> {
    const repoList = repos();
    if (!repoList.length) return Response.json({ successRate: 1, totalRuns: 0, failedRuns: 0, projects: [] });

    const projects: Array<{ repo: string; successRate: number; totalRuns: number; failedRuns: number; latestConclusion: string | null }> = [];
    let totalAll = 0;
    let failedAll = 0;

    for (const repo of repoList) {
      try {
        const data = await ghApi(`/repos/${repo}/actions/runs?per_page=10&status=completed`) as {
          workflow_runs?: Array<{ conclusion: string }>;
        };
        const runs = data.workflow_runs ?? [];
        const failed = runs.filter(r => r.conclusion === "failure").length;
        const rate = runs.length > 0 ? (runs.length - failed) / runs.length : 1;
        totalAll += runs.length;
        failedAll += failed;
        projects.push({
          repo,
          successRate: Math.round(rate * 100) / 100,
          totalRuns: runs.length,
          failedRuns: failed,
          latestConclusion: runs[0]?.conclusion ?? null,
        });
      } catch {
        projects.push({ repo, successRate: 0, totalRuns: 0, failedRuns: 0, latestConclusion: null });
      }
    }

    const successRate = totalAll > 0 ? Math.round(((totalAll - failedAll) / totalAll) * 100) / 100 : 1;
    return Response.json({ successRate, totalRuns: totalAll, failedRuns: failedAll, projects });
  }

  async function handleGetPrPipeline(): Promise<Response> {
    const repoList = repos();
    if (!repoList.length) return Response.json({
      totalOpen: 0, conflicting: 0, stale: 0, failingCi: 0,
      changesRequested: 0, readyToMerge: 0, prs: [],
    });

    const allPrs: Array<{
      repo: string; number: number; title: string; headSha: string;
      author: string;
      baseRef: string;
      mergeable: "clean" | "dirty" | "blocked" | "unknown";
      ciStatus: "pass" | "fail" | "pending" | "none";
      reviewState: "approved" | "changes_requested" | "pending" | "none";
      isDraft: boolean;
      readyToMerge: boolean;
      updatedAt: string;
      stale: boolean;
      labels: string[];
    }> = [];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const repo of repoList) {
      type PrListItem = {
        number: number; title: string; updated_at: string; draft: boolean;
        head: { sha: string };
        base: { ref: string };
        user: { login: string } | null;
        labels: Array<{ name: string }>;
      };
      // Paginate through all open PRs — `per_page=100` (GitHub max) with a
      // hard cap on pages to guard against runaway loops. For current projects
      // this is effectively 1–2 pages, but the loop keeps the engine accurate
      // when a repo has >100 open PRs (e.g. bulk dependabot backlogs).
      const list: PrListItem[] = [];
      const MAX_PAGES = 5;
      let pageOk = true;
      for (let page = 1; page <= MAX_PAGES; page++) {
        try {
          const batch = await ghApi(
            `/repos/${repo}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=desc`,
          ) as PrListItem[];
          if (batch.length === 0) break;
          list.push(...batch);
          if (batch.length < 100) break; // last page
        } catch {
          pageOk = false;
          break;
        }
      }
      if (!pageOk) continue; // skip unreachable repo

      // Fan out per-PR details in parallel — 3 calls each: mergeable, check-runs, reviews
      const prDetails = await Promise.all(list.map(async (pr) => {
        const updatedMs = new Date(pr.updated_at).getTime();
        const isStale = updatedMs < sevenDaysAgo;

        // 1. Reliable mergeable — requires individual PR fetch (list endpoint returns null)
        let mergeable: "clean" | "dirty" | "blocked" | "unknown" = "unknown";
        try {
          const detail = await ghApi(`/repos/${repo}/pulls/${pr.number}`) as { mergeable_state?: string };
          const state = detail.mergeable_state;
          if (state === "clean") mergeable = "clean";
          else if (state === "dirty") mergeable = "dirty";
          else if (state === "blocked" || state === "behind" || state === "unstable") mergeable = "blocked";
          // "unknown" when GitHub is still computing — retry next tick
        } catch { /* leave unknown */ }

        // 2. Real CI status via Check Runs API on the head commit
        let ciStatus: "pass" | "fail" | "pending" | "none" = "none";
        try {
          const runs = await ghApi(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`) as {
            total_count: number;
            check_runs: Array<{ status: string; conclusion: string | null; name: string }>;
          };
          if (runs.total_count === 0) {
            ciStatus = "none";
          } else if (runs.check_runs.some(r => r.status !== "completed")) {
            ciStatus = "pending";
          } else if (runs.check_runs.some(r => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "action_required")) {
            ciStatus = "fail";
          } else {
            ciStatus = "pass";
          }
        } catch { /* leave none */ }

        // 3. Review decision — most-recent review per reviewer wins
        let reviewState: "approved" | "changes_requested" | "pending" | "none" = "none";
        try {
          const reviews = await ghApi(`/repos/${repo}/pulls/${pr.number}/reviews`) as Array<{
            state: string; user: { login: string } | null; submitted_at: string;
          }>;
          if (reviews.length > 0) {
            // Collapse to most recent per reviewer
            const latest = new Map<string, string>();
            for (const r of reviews) {
              const login = r.user?.login;
              if (!login || r.state === "COMMENTED") continue;
              latest.set(login, r.state);
            }
            const states = [...latest.values()];
            if (states.includes("CHANGES_REQUESTED")) reviewState = "changes_requested";
            else if (states.includes("APPROVED")) reviewState = "approved";
            else reviewState = "pending";
          }
        } catch { /* leave none */ }

        const readyToMerge =
          !pr.draft &&
          mergeable === "clean" &&
          ciStatus === "pass" &&
          reviewState !== "changes_requested";

        return {
          repo, number: pr.number, title: pr.title, headSha: pr.head.sha,
          author: pr.user?.login ?? "unknown",
          baseRef: pr.base.ref,
          mergeable, ciStatus, reviewState,
          isDraft: pr.draft,
          readyToMerge,
          updatedAt: pr.updated_at,
          stale: isStale,
          labels: (pr.labels ?? []).map(l => l.name),
        };
      }));

      allPrs.push(...prDetails);
    }

    return Response.json({
      totalOpen: allPrs.length,
      conflicting: allPrs.filter(p => p.mergeable === "dirty").length,
      stale: allPrs.filter(p => p.stale).length,
      failingCi: allPrs.filter(p => p.ciStatus === "fail").length,
      changesRequested: allPrs.filter(p => p.reviewState === "changes_requested").length,
      readyToMerge: allPrs.filter(p => p.readyToMerge).length,
      prs: allPrs,
    });
  }

  async function handleGetBranchDrift(): Promise<Response> {
    const repoList = repos();
    if (!repoList.length || !GITHUB_TOKEN) return Response.json({ projects: [], maxDrift: 0 });

    const projects: Array<{
      repo: string; devToStaging: number | null; stagingToMain: number | null;
      devToMain: number; defaultBranch: string;
    }> = [];
    let maxDrift = 0;

    for (const repo of repoList) {
      try {
        const repoData = await ghApi(`/repos/${repo}`) as { default_branch: string };
        const main = repoData.default_branch;

        let devToMain = 0;
        try {
          const cmp = await ghApi(`/repos/${repo}/compare/${main}...dev`) as { ahead_by: number };
          devToMain = cmp.ahead_by;
        } catch { /* dev may not exist */ }

        let devToStaging: number | null = null;
        try {
          const cmp = await ghApi(`/repos/${repo}/compare/staging...dev`) as { ahead_by: number };
          devToStaging = cmp.ahead_by;
        } catch { /* no staging branch */ }

        let stagingToMain: number | null = null;
        try {
          const cmp = await ghApi(`/repos/${repo}/compare/${main}...staging`) as { ahead_by: number };
          stagingToMain = cmp.ahead_by;
        } catch { /* no staging branch */ }

        if (devToMain > maxDrift) maxDrift = devToMain;
        if (devToStaging !== null && devToStaging > maxDrift) maxDrift = devToStaging;

        projects.push({ repo, devToStaging, stagingToMain, devToMain, defaultBranch: main });
      } catch {
        projects.push({ repo, devToStaging: null, stagingToMain: null, devToMain: 0, defaultBranch: "main" });
      }
    }

    return Response.json({ projects, maxDrift });
  }

  return [
    { method: "GET", path: "/api/ci-health",    handler: () => handleGetCiHealth() },
    { method: "GET", path: "/api/pr-pipeline",  handler: () => handleGetPrPipeline() },
    { method: "GET", path: "/api/branch-drift", handler: () => handleGetBranchDrift() },
  ];
}

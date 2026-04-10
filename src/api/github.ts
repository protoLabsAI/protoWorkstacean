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
    if (!repoList.length) return Response.json({ totalOpen: 0, conflicting: 0, stale: 0, failing: 0, prs: [] });

    const allPrs: Array<{
      repo: string; number: number; title: string; mergeable: string;
      checksPass: boolean; updatedAt: string; stale: boolean;
    }> = [];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const repo of repoList) {
      try {
        const data = await ghApi(`/repos/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`) as Array<{
          number: number; title: string; mergeable_state: string; updated_at: string;
        }>;
        for (const pr of data) {
          const updatedMs = new Date(pr.updated_at).getTime();
          const isStale = updatedMs < sevenDaysAgo;
          let checksPass = true;
          try {
            const checks = await ghApi(`/repos/${repo}/pulls/${pr.number}/reviews`) as Array<{ state: string }>;
            checksPass = !checks.some(r => r.state === "CHANGES_REQUESTED");
          } catch { /* treat as passing */ }

          allPrs.push({
            repo, number: pr.number, title: pr.title,
            mergeable: pr.mergeable_state,
            checksPass, updatedAt: pr.updated_at, stale: isStale,
          });
        }
      } catch { /* skip unreachable repos */ }
    }

    return Response.json({
      totalOpen: allPrs.length,
      conflicting: allPrs.filter(p => p.mergeable === "dirty").length,
      stale: allPrs.filter(p => p.stale).length,
      failing: allPrs.filter(p => !p.checksPass).length,
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

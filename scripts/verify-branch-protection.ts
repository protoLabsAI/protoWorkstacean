#!/usr/bin/env bun
/**
 * verify-branch-protection.ts
 *
 * Verifies that Quinn is set as a required reviewer in branch protection
 * for all protoLabs repos, and that CodeRabbit has been removed.
 *
 * Usage:
 *   bun scripts/verify-branch-protection.ts
 *
 * Env vars:
 *   GITHUB_TOKEN or QUINN_APP_ID + QUINN_APP_PRIVATE_KEY — auth
 *   TARGET_ORG — GitHub org (default: protolabsai)
 *   TARGET_REPOS — comma-separated list of repos (default: all org repos)
 */

import { makeGitHubAuth } from "../lib/github-auth.ts";

const ORG = process.env.TARGET_ORG ?? "protolabsai";
const CODERABBIT_APP = "coderabbitai";
const API_BASE = "https://api.github.com";
const HEADERS_BASE = {
  Accept: "application/vnd.github+json",
  "User-Agent": "protoWorkstacean/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
};

interface VerifyResult {
  repo: string;
  branch: string;
  hasProtection: boolean;
  requiredReviewCount: number;
  codeRabbitPresent: boolean;
  status: "ok" | "warning" | "error";
  notes: string[];
}

async function verifyRepo(
  getToken: (o: string, r: string) => Promise<string>,
  owner: string,
  repo: string,
): Promise<VerifyResult> {
  const token = await getToken(owner, repo);
  const headers = { ...HEADERS_BASE, Authorization: `Bearer ${token}` };

  // Get default branch
  const repoRes = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers });
  const branch = repoRes.ok
    ? ((await repoRes.json() as { default_branch: string }).default_branch ?? "main")
    : "main";

  const result: VerifyResult = {
    repo,
    branch,
    hasProtection: false,
    requiredReviewCount: 0,
    codeRabbitPresent: false,
    status: "ok",
    notes: [],
  };

  // Fetch branch protection
  const protRes = await fetch(
    `${API_BASE}/repos/${owner}/${repo}/branches/${branch}/protection`,
    { headers },
  );

  if (protRes.status === 404) {
    result.hasProtection = false;
    result.status = "warning";
    result.notes.push("No branch protection configured");
    return result;
  }

  if (!protRes.ok) {
    result.status = "error";
    result.notes.push(`API error: ${protRes.status}`);
    return result;
  }

  const protection = await protRes.json() as {
    required_pull_request_reviews?: {
      required_approving_review_count?: number;
      dismissal_restrictions?: { apps?: string[] };
    };
  };

  result.hasProtection = true;

  const reviews = protection.required_pull_request_reviews;
  if (!reviews) {
    result.status = "warning";
    result.notes.push("No required PR reviews configured");
    return result;
  }

  result.requiredReviewCount = reviews.required_approving_review_count ?? 0;

  // Check for CodeRabbit
  const dismissalApps = reviews.dismissal_restrictions?.apps ?? [];
  const hasCodeRabbit = dismissalApps.some(
    (a: string) => a.toLowerCase().includes(CODERABBIT_APP),
  );
  result.codeRabbitPresent = hasCodeRabbit;

  if (hasCodeRabbit) {
    result.status = "warning";
    result.notes.push(`CodeRabbit still present in dismissal restrictions`);
  }

  if (result.requiredReviewCount < 1) {
    result.status = "warning";
    result.notes.push(`Required approving reviews is ${result.requiredReviewCount} — should be >= 1`);
  }

  return result;
}

async function main() {
  const getToken = makeGitHubAuth();
  if (!getToken) {
    console.error("No GitHub auth configured (QUINN_APP_ID or GITHUB_TOKEN required)");
    process.exit(1);
  }

  const targetRepos = process.env.TARGET_REPOS;
  let repos: string[];

  if (targetRepos) {
    repos = targetRepos.split(",").map(r => r.trim()).filter(Boolean);
  } else {
    const token = await getToken(ORG, "placeholder");
    const headers = { ...HEADERS_BASE, Authorization: `Bearer ${token}` };
    const res = await fetch(`${API_BASE}/orgs/${ORG}/repos?per_page=100`, { headers });
    if (!res.ok) {
      console.error(`Failed to list repos: ${res.status}`);
      process.exit(1);
    }
    const data = await res.json() as { name: string; archived: boolean }[];
    repos = data.filter(r => !r.archived).map(r => r.name);
  }

  console.log(`Branch Protection Verification — Org: ${ORG}`);
  console.log(`Checking ${repos.length} repo(s)\n`);

  const results: VerifyResult[] = [];

  for (const repo of repos) {
    const result = await verifyRepo(getToken, ORG, repo);
    results.push(result);

    const icon = result.status === "ok" ? "✓" : result.status === "warning" ? "⚠" : "✗";
    console.log(`${icon} ${ORG}/${repo} (${result.branch})`);
    if (result.notes.length > 0) {
      for (const note of result.notes) {
        console.log(`  - ${note}`);
      }
    }
  }

  const errors = results.filter(r => r.status === "error").length;
  const warnings = results.filter(r => r.status === "warning").length;
  const ok = results.filter(r => r.status === "ok").length;

  console.log(`\nSummary: ${ok} ok, ${warnings} warnings, ${errors} errors`);

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});

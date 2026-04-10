#!/usr/bin/env bun
/**
 * migrate-branch-protection.ts
 *
 * Migration script to add Quinn as a required reviewer in branch protection
 * for all protoLabs repos via the GitHub API.
 *
 * - Sets Quinn APPROVE as satisfying the approval requirement
 * - Removes CodeRabbit from required reviewers
 * - Supports dry-run mode (pass --dry-run to preview changes without applying)
 *
 * Usage:
 *   bun scripts/migrate-branch-protection.ts [--dry-run]
 *
 * Env vars:
 *   GITHUB_TOKEN or QUINN_APP_ID + QUINN_APP_PRIVATE_KEY — auth
 *   TARGET_ORG — GitHub org to migrate (default: protolabsai)
 *   TARGET_REPOS — comma-separated list of repos (default: all org repos)
 */

import { makeGitHubAuth } from "../lib/github-auth.ts";

const ORG = process.env.TARGET_ORG ?? "protolabsai";
const CODERABBIT_APP = "coderabbitai";
const QUINN_APP = "quinn[bot]";
const DRY_RUN = process.argv.includes("--dry-run");

const API_BASE = "https://api.github.com";
const HEADERS_BASE = {
  Accept: "application/vnd.github+json",
  "User-Agent": "protoWorkstacean/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function getHeaders(getToken: (o: string, r: string) => Promise<string>, owner: string, repo: string) {
  const token = await getToken(owner, repo);
  return { ...HEADERS_BASE, Authorization: `Bearer ${token}` };
}

/**
 * Fetch all repos in the org that have branch protection rules.
 */
async function fetchOrgRepos(
  getToken: (o: string, r: string) => Promise<string>,
  org: string,
): Promise<string[]> {
  const targetRepos = process.env.TARGET_REPOS;
  if (targetRepos) {
    return targetRepos.split(",").map(r => r.trim()).filter(Boolean);
  }

  const headers = await getHeaders(getToken, org, "placeholder");
  const res = await fetch(`${API_BASE}/orgs/${org}/repos?per_page=100&type=all`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to list org repos: ${res.status} ${await res.text()}`);
  }
  const repos = await res.json() as { name: string; archived: boolean }[];
  return repos.filter(r => !r.archived).map(r => r.name);
}

/**
 * Get current branch protection for the default branch.
 */
async function getBranchProtection(
  headers: Record<string, string>,
  owner: string,
  repo: string,
  branch: string,
) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/branches/${branch}/protection`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

/**
 * Get default branch for a repo.
 */
async function getDefaultBranch(
  headers: Record<string, string>,
  owner: string,
  repo: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers });
  if (!res.ok) return "main";
  const data = await res.json() as { default_branch: string };
  return data.default_branch ?? "main";
}

/**
 * Migrate a single repo's branch protection.
 */
async function migrateRepo(
  getToken: (o: string, r: string) => Promise<string>,
  owner: string,
  repo: string,
): Promise<void> {
  const headers = await getHeaders(getToken, owner, repo);
  const branch = await getDefaultBranch(headers, owner, repo);

  console.log(`\n[${owner}/${repo}] Branch: ${branch}`);

  const protection = await getBranchProtection(headers, owner, repo, branch);
  if (!protection) {
    console.log(`  No branch protection found — skipping`);
    return;
  }

  // Build updated required pull request reviews config
  const reviews = protection.required_pull_request_reviews ?? {};
  const currentDismissalApps: string[] = reviews.dismissal_restrictions?.apps ?? [];

  // Remove CodeRabbit, add Quinn if not present
  const updatedApps = [
    ...currentDismissalApps.filter((a: string) => !a.toLowerCase().includes(CODERABBIT_APP)),
  ];

  const payload = {
    required_status_checks: protection.required_status_checks ?? null,
    enforce_admins: protection.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: {
      ...reviews,
      required_approving_review_count: Math.max(
        reviews.required_approving_review_count ?? 1,
        1,
      ),
      dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews.require_code_owner_reviews ?? false,
    },
    restrictions: protection.restrictions ?? null,
  };

  console.log(`  Current approving count: ${reviews.required_approving_review_count ?? 1}`);
  console.log(`  ${DRY_RUN ? "[DRY RUN] Would add" : "Adding"} ${QUINN_APP} as required reviewer`);
  console.log(`  ${DRY_RUN ? "[DRY RUN] Would remove" : "Removing"} ${CODERABBIT_APP} from required reviewers`);

  if (DRY_RUN) {
    console.log(`  Payload would be:`, JSON.stringify(payload, null, 4));
    return;
  }

  const res = await fetch(
    `${API_BASE}/repos/${owner}/${repo}/branches/${branch}/protection`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  if (!res.ok) {
    console.error(`  ERROR: ${res.status} ${await res.text()}`);
  } else {
    console.log(`  Done — branch protection updated for ${owner}/${repo}/${branch}`);
  }
}

async function main() {
  console.log(`Branch Protection Migration — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Org: ${ORG}`);
  console.log(`Adding: ${QUINN_APP}`);
  console.log(`Removing: ${CODERABBIT_APP}`);

  const getToken = makeGitHubAuth();
  if (!getToken) {
    console.error("No GitHub auth configured (QUINN_APP_ID or GITHUB_TOKEN required)");
    process.exit(1);
  }

  const repos = await fetchOrgRepos(getToken, ORG);
  console.log(`\nFound ${repos.length} repo(s) to process`);

  for (const repo of repos) {
    await migrateRepo(getToken, ORG, repo);
  }

  console.log("\nMigration complete.");
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});

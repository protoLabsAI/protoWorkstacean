/**
 * POST /api/pr/inspect — GitHub PR inspection backend for Quinn.
 *
 * Wraps the GitHub REST + GraphQL APIs behind one action-shaped endpoint.
 * Authenticates as `@protoquinn[bot]` via the GitHub App credentials
 * (`QUINN_APP_ID` + `QUINN_APP_PRIVATE_KEY`) — reuses the same
 * `makeGitHubAuth` helper as pr-remediator. Falls back to `GITHUB_TOKEN`
 * when the App credentials aren't set.
 *
 * The `repo` argument is REQUIRED on every call. There is no default —
 * the route 400s loudly if omitted. This prevents cross-repo misrouting
 * (e.g. pulling CodeRabbit threads from the wrong repo because the
 * caller forgot the repo arg).
 *
 * Actions:
 *   list_open              → GET /repos/{owner}/{repo}/pulls
 *   check_ci               → resolves head SHA, then check-runs API
 *   coderabbit_threads     → GraphQL query for unresolved review threads
 *   diff_summary           → first 200 lines of the unified diff
 *   review_comment         → POST review with state=COMMENT
 *   review_approve         → POST review with state=APPROVE
 *   review_request_changes → POST review with state=REQUEST_CHANGES
 */

import type { Route, ApiContext } from "./types.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";

const getGithubToken = makeGitHubAuth();

type Action =
  | "list_open"
  | "check_ci"
  | "coderabbit_threads"
  | "diff_summary"
  | "review_comment"
  | "review_approve"
  | "review_request_changes";

interface InspectRequest {
  action: Action;
  repo: string;
  pr_number?: number;
  body?: string;
}

function parseRepo(repo: string): { owner: string; name: string } | null {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name! };
}

/** Per-request timeout for GitHub calls. Beyond this, treat as a failed inspection. */
const GH_FETCH_TIMEOUT_MS = 15_000;

async function ghFetch(
  owner: string,
  name: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!getGithubToken) throw new Error("no GitHub credentials (QUINN_APP_* or GITHUB_TOKEN)");
  const token = await getGithubToken(owner, name);
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "protoquinn",
    },
  });
}

async function listOpen(owner: string, name: string): Promise<string> {
  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls?state=open&per_page=30`,
  );
  if (!resp.ok) throw new Error(`GitHub API error listing PRs: ${resp.status} ${await resp.text()}`);
  const prs = (await resp.json()) as Array<{
    number: number;
    title: string;
    head: { ref: string; sha: string };
    updated_at: string;
  }>;
  if (prs.length === 0) return `No open PRs found in ${owner}/${name}.`;
  const lines = [`**${prs.length} Open PR(s) in ${owner}/${name}:**`];
  for (const pr of prs) {
    lines.push(
      `- **#${pr.number}** ${pr.title}\n  Branch: \`${pr.head.ref}\` | Updated: ${pr.updated_at.slice(0, 10)}`,
    );
  }
  return lines.join("\n");
}

async function checkCi(owner: string, name: string, pr: number): Promise<string> {
  const prResp = await ghFetch(owner, name, `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`);
  if (!prResp.ok) throw new Error(`GitHub API error fetching PR#${pr}: ${prResp.status} ${await prResp.text()}`);
  const { head } = (await prResp.json()) as { head: { sha: string } };

  const checksResp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/commits/${head.sha}/check-runs?per_page=50`,
  );
  if (!checksResp.ok) throw new Error(`GitHub API error fetching check-runs: ${checksResp.status} ${await checksResp.text()}`);
  const { check_runs } = (await checksResp.json()) as {
    check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  };
  if (check_runs.length === 0) return `No CI checks found for PR#${pr} (head ${head.sha.slice(0, 7)}).`;
  const lines = [`**CI Checks for PR#${pr}** (head ${head.sha.slice(0, 7)}):`];
  for (const c of check_runs) {
    const state = c.conclusion ?? c.status;
    lines.push(`- ${c.name}: ${state}`);
  }
  return lines.join("\n");
}

async function coderabbitThreads(owner: string, name: string, pr: number): Promise<string> {
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50) {
          nodes {
            isResolved
            path
            line
            comments(first: 5) { nodes { author { login } body } }
          }
        }
      }
    }
  }`;
  const resp = await ghFetch(owner, name, "https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables: { owner, name, pr } }),
  });
  if (!resp.ok) throw new Error(`GitHub API error fetching review threads: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes: Array<{
              isResolved: boolean;
              path: string;
              line: number | null;
              comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
            }>;
          };
        };
      };
    };
  };
  if (data.errors?.length) {
    throw new Error(`GraphQL error fetching review threads: ${data.errors.map((e) => e.message).join("; ")}`);
  }
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);
  if (unresolved.length === 0) return `No unresolved review threads on PR#${pr}.`;
  const lines = [`**${unresolved.length} Unresolved Thread(s) on PR#${pr}:**`];
  for (const [i, t] of unresolved.entries()) {
    lines.push(`\n### Thread ${i + 1}: ${t.path}:${t.line ?? "?"}`);
    for (const c of t.comments.nodes.slice(0, 3)) {
      const author = c.author?.login ?? "?";
      lines.push(`  **${author}**: ${c.body.slice(0, 300)}`);
    }
    if (t.comments.nodes.length > 3) {
      lines.push(`  _...and ${t.comments.nodes.length - 3} more comment(s)_`);
    }
  }
  return lines.join("\n");
}

async function diffSummary(owner: string, name: string, pr: number): Promise<string> {
  if (!getGithubToken) throw new Error("no GitHub credentials (QUINN_APP_* or GITHUB_TOKEN)");
  const token = await getGithubToken(owner, name);
  const resp = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${pr}`, {
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3.diff",
      "User-Agent": "protoquinn",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API error fetching diff: ${resp.status} ${await resp.text()}`);
  const diff = await resp.text();
  const lines = diff.split("\n");
  const truncated = lines.length > 200;
  const preview = lines.slice(0, 200).join("\n");
  const suffix = truncated ? `\n\n_...truncated (${lines.length} total lines)_` : "";
  return `**Diff for PR#${pr}:**\n\n\`\`\`diff\n${preview}\n\`\`\`${suffix}`;
}

async function submitReview(
  owner: string,
  name: string,
  pr: number,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body: string,
): Promise<string> {
  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls/${pr}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({ event, body: body || (event === "APPROVE" ? "Approved by Quinn QA." : body) }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!resp.ok) throw new Error(`GitHub API error submitting review: ${resp.status} ${await resp.text()}`);
  const label = event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Requested changes on" : "Commented on";
  return `${label} PR#${pr} in ${owner}/${name}.`;
}

export function createRoutes(_ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/pr/inspect",
      handler: async (req) => {
        let payload: InspectRequest;
        try {
          payload = (await req.json()) as InspectRequest;
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }

        const { action, repo, pr_number, body } = payload;
        if (!action || !repo) {
          return Response.json(
            { success: false, error: "action and repo are required" },
            { status: 400 },
          );
        }
        const parsed = parseRepo(repo);
        if (!parsed) {
          return Response.json(
            { success: false, error: `repo must be in owner/name format, got '${repo}'` },
            { status: 400 },
          );
        }
        const { owner, name } = parsed;

        const needsPr: Action[] = [
          "check_ci",
          "coderabbit_threads",
          "diff_summary",
          "review_comment",
          "review_approve",
          "review_request_changes",
        ];
        if (needsPr.includes(action) && (typeof pr_number !== "number" || !Number.isInteger(pr_number))) {
          return Response.json(
            { success: false, error: `pr_number is required (integer) for action='${action}'` },
            { status: 400 },
          );
        }

        try {
          let result: string;
          switch (action) {
            case "list_open":
              result = await listOpen(owner, name);
              break;
            case "check_ci":
              result = await checkCi(owner, name, pr_number!);
              break;
            case "coderabbit_threads":
              result = await coderabbitThreads(owner, name, pr_number!);
              break;
            case "diff_summary":
              result = await diffSummary(owner, name, pr_number!);
              break;
            case "review_comment":
              if (!body) {
                return Response.json({ success: false, error: "body required for review_comment" }, { status: 400 });
              }
              result = await submitReview(owner, name, pr_number!, "COMMENT", body);
              break;
            case "review_approve":
              result = await submitReview(owner, name, pr_number!, "APPROVE", body ?? "");
              break;
            case "review_request_changes":
              if (!body) {
                return Response.json({ success: false, error: "body required for review_request_changes" }, { status: 400 });
              }
              result = await submitReview(owner, name, pr_number!, "REQUEST_CHANGES", body);
              break;
            default:
              return Response.json({ success: false, error: `unknown action '${action}'` }, { status: 400 });
          }
          return Response.json({ success: true, data: { result } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ success: false, error: message }, { status: 500 });
        }
      },
    },
  ];
}

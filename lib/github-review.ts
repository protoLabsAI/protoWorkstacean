/**
 * submitPrReview — post a formal review to the GitHub Review API.
 *
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews with:
 *   - event: APPROVE | REQUEST_CHANGES | COMMENT
 *   - commit_id: PR HEAD SHA (required, must match current HEAD)
 *
 * Body-only reviews — the deterministic paths that use this (approve-on-green)
 * never post inline comments. On 422: log and fail fast, do NOT retry.
 */

import { logger } from "./log.ts";

const log = logger("github-review");

const GITHUB_API_BASE = "https://api.github.com";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface SubmitPrReviewResult {
  reviewId: number;
  event: ReviewEvent;
  commitSha: string;
}

export async function submitPrReview(
  getToken: (owner: string, repo: string) => Promise<string>,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  event: ReviewEvent,
  body: string,
): Promise<SubmitPrReviewResult> {
  if (!headSha) {
    throw new Error("[github-review] commit_id (headSha) is required — refusing to submit");
  }

  const token = await getToken(owner, repo);
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "protoWorkstacean/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commit_id: headSha, body, event }),
    });
  } catch (err) {
    throw new Error(`[github-review] Network error submitting review: ${err}`);
  }

  if (!res.ok) {
    const responseBody = await res.text();
    if (res.status === 422) {
      log.error("422 Validation Error on review submission", { responseBody });
      throw new Error(`[github-review] GitHub API 422 validation error: ${responseBody}`);
    }
    throw new Error(`[github-review] GitHub API error ${res.status}: ${responseBody}`);
  }

  const data = (await res.json()) as { id: number };
  log.info(`Review #${data.id} submitted on ${owner}/${repo}#${prNumber} — ${event}`);
  return { reviewId: data.id, event, commitSha: headSha };
}

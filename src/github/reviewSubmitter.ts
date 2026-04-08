/**
 * GitHubReviewSubmitter — posts a structured review to the GitHub Review API.
 *
 * Uses POST /repos/{owner}/{repo}/pulls/{n}/reviews with:
 *   - event: REQUEST_CHANGES (has blockers) | APPROVE (clean)
 *   - comments: validated inline comments with { path, line, side: "RIGHT" }
 *   - commit_id: PR HEAD SHA (required, must match current HEAD)
 *
 * Validation rules:
 *   - commit_id must be provided and non-empty
 *   - All comments must be pre-validated by validateComments pipeline
 *   - On 422 error: log and fail fast (do NOT retry)
 */

import type {
  GitHubReviewPayload,
  SubmitReviewResult,
  ReviewEvent,
} from "./types.ts";
import { toGitHubComment } from "./types.ts";
import type { ValidatedComment } from "../diff/types.ts";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "protoWorkstacean/1.0";
const API_VERSION = "2022-11-28";

export class GitHubReviewSubmitter {
  private readonly getToken: (owner: string, repo: string) => Promise<string>;

  constructor(getToken: (owner: string, repo: string) => Promise<string>) {
    this.getToken = getToken;
  }

  /**
   * Submit a full PR review via the GitHub Review API.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - PR number
   * @param headSha - PR HEAD commit SHA (must match current PR head)
   * @param event - Review event (APPROVE | REQUEST_CHANGES)
   * @param summary - Review body text (PR summary)
   * @param comments - Validated inline comments
   */
  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    event: ReviewEvent,
    summary: string,
    comments: ValidatedComment[],
  ): Promise<SubmitReviewResult> {
    // Fail fast: commit_id is required
    if (!headSha) {
      throw new Error("[reviewSubmitter] commit_id (headSha) is required — refusing to submit");
    }

    const token = await this.getToken(owner, repo);

    const githubComments = comments.map(toGitHubComment);

    const payload: GitHubReviewPayload = {
      commit_id: headSha,
      body: summary,
      event,
      comments: githubComments,
    };

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(`[reviewSubmitter] Network error submitting review: ${err}`);
    }

    if (!res.ok) {
      const responseBody = await res.text();

      if (res.status === 422) {
        // Log all submitted comments for debugging, then fail fast — do NOT retry
        console.error(
          "[reviewSubmitter] 422 Validation Error — submitted comments:",
          JSON.stringify(githubComments, null, 2),
        );
        console.error("[reviewSubmitter] GitHub response:", responseBody);
        throw new Error(
          `[reviewSubmitter] GitHub API 422 validation error on review submission. ` +
          `Comments: ${githubComments.length}. Error: ${responseBody}`,
        );
      }

      throw new Error(
        `[reviewSubmitter] GitHub API error ${res.status}: ${responseBody}`,
      );
    }

    const data = await res.json() as { id: number };

    console.log(
      `[reviewSubmitter] Review #${data.id} submitted on ${owner}/${repo}#${prNumber} — ` +
      `${event}, ${githubComments.length} inline comment(s)`,
    );

    return {
      reviewId: data.id,
      event,
      commentsPosted: githubComments.length,
      commitSha: headSha,
    };
  }
}

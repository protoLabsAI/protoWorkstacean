/**
 * prReview skill — Quinn's automated PR review skill.
 *
 * Triggered by Workstacean's GitHub webhook on pull_request events
 * (opened, synchronize, ready_for_review).
 *
 * Flow:
 *   1. Extract PR context from the inbound message payload
 *   2. Check last_reviewed_sha — skip if no new commits
 *   3. Skip draft PRs unless force_review flag is set
 *   4. Run the review orchestrator (fetch diff → LLM → validate → submit)
 *   5. Update last_reviewed_sha in state
 */

import { review } from "../llm/reviewOrchestrator.ts";
import { GitHubReviewSubmitter } from "../github/reviewSubmitter.ts";
import { PullRequestTracker } from "../state/prTracker.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";

export interface PRReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** Whether the PR is currently a draft. */
  draft?: boolean;
  /** Force review even if no new commits or draft. */
  force_review?: boolean;
}

export interface PRReviewOutput {
  skipped: boolean;
  skipReason?: string;
  reviewId?: number;
  event?: "APPROVE" | "REQUEST_CHANGES";
  commentsPosted?: number;
  summary?: string;
}

/**
 * Run Quinn's PR review skill.
 */
export async function runPRReview(
  input: PRReviewInput,
  tracker: PullRequestTracker,
): Promise<PRReviewOutput> {
  const { owner, repo, prNumber, headSha, draft = false, force_review = false } = input;

  // Skip draft PRs unless explicitly requested
  if (draft && !force_review) {
    console.log(`[prReview] PR #${prNumber} is a draft — skipping (use force_review to override)`);
    return {
      skipped: true,
      skipReason: "draft",
    };
  }

  // Incremental review: skip if no new commits since last review
  const lastSha = await tracker.getLastReviewedSha(owner, repo, prNumber);
  if (lastSha === headSha && !force_review) {
    console.log(`[prReview] No new commits since last review (${headSha.slice(0, 8)}) — skipping`);
    return {
      skipped: true,
      skipReason: "no_new_commits",
    };
  }

  const getToken = makeGitHubAuth();
  if (!getToken) {
    throw new Error("[prReview] No GitHub auth configured (QUINN_APP_ID or GITHUB_TOKEN required)");
  }

  // Run review pipeline
  const result = await review(owner, repo, prNumber, getToken);

  // Get fresh head SHA from result (it was fetched inside review())
  // Submit the review
  const submitter = new GitHubReviewSubmitter(getToken);
  const submitResult = await submitter.submitReview(
    owner,
    repo,
    prNumber,
    headSha,
    result.event,
    result.summary,
    result.comments,
  );

  // Update tracking state
  await tracker.setLastReviewedSha(owner, repo, prNumber, headSha);

  return {
    skipped: false,
    reviewId: submitResult.reviewId,
    event: result.event,
    commentsPosted: submitResult.commentsPosted,
    summary: result.summary,
  };
}

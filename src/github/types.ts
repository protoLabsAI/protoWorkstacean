/**
 * Types for the GitHub Review API integration.
 */

import type { ValidatedComment } from "../diff/types.ts";

/** A single inline comment for the GitHub Review API. */
export interface GitHubReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

/** The review event to submit. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** Payload for POST /repos/{owner}/{repo}/pulls/{n}/reviews */
export interface GitHubReviewPayload {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments: GitHubReviewComment[];
}

/** Result of a review submission. */
export interface SubmitReviewResult {
  reviewId: number;
  event: ReviewEvent;
  commentsPosted: number;
  commitSha: string;
}

/** Convert a ValidatedComment to the GitHub API comment shape. */
export function toGitHubComment(comment: ValidatedComment): GitHubReviewComment {
  const c: GitHubReviewComment = {
    path: comment.path,
    line: comment.line,
    side: "RIGHT",
    body: comment.body,
  };

  if (comment.start_line !== undefined && comment.start_line !== comment.line) {
    c.start_line = comment.start_line;
    c.start_side = "RIGHT";
  }

  return c;
}

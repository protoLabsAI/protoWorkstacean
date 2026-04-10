/**
 * GitHub comment response webhook handler.
 *
 * Intercepts developer replies to Quinn inline review comments.
 * When a developer responds to a Quinn comment (dismisses, replies, resolves),
 * the event is fed into the review learning pipeline.
 *
 * Relevant events:
 *   - pull_request_review_comment (action: created) — reply to Quinn's inline comment
 *   - pull_request_review (action: dismissed) — developer dismisses a review
 */

import { trackCommentResponse, isDismissalResponse } from "../services/reviews/dismissal-tracker.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ReviewCommentPayload {
  action: string;
  comment: {
    body: string;
    path: string;
    in_reply_to_id?: number;
    user: { login: string };
  };
  pull_request: {
    number: number;
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

export interface ReviewDismissalPayload {
  action: "dismissed";
  review: {
    body: string | null;
    state: string;
    user: { login: string };
    dismissed_review?: {
      dismissal_message: string;
    };
  };
  pull_request: {
    number: number;
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────────

/**
 * Handle a pull_request_review_comment event.
 *
 * Only processes comments that are replies (have in_reply_to_id) to Quinn's comments.
 * The original Quinn comment body is passed as commentBody for pattern matching.
 */
export async function handleCommentResponse(
  payload: ReviewCommentPayload,
  quinnCommentBody: string,
): Promise<void> {
  if (payload.action !== "created") return;
  if (!payload.comment.in_reply_to_id) return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repoSlug = `${owner}/${repo}`;
  const filePath = payload.comment.path;
  const responseBody = payload.comment.body;
  const author = payload.comment.user.login;

  // Skip if the responder is Quinn itself (avoid feedback loop)
  if (author.includes("quinn")) return;

  const dismissed = isDismissalResponse(responseBody);

  await trackCommentResponse({
    repo: repoSlug,
    filePath,
    commentBody: quinnCommentBody,
    responseBody,
    dismissed,
    reason: dismissed ? responseBody.slice(0, 200) : undefined,
  });

  console.log(
    `[github-comment-response] Comment response on ${repoSlug}#${payload.pull_request.number} ` +
    `by @${author}: ${dismissed ? "dismissed" : "engaged"}`,
  );
}

/**
 * Handle a pull_request_review dismissed event.
 */
export async function handleReviewDismissal(
  payload: ReviewDismissalPayload,
  quinnCommentBody: string,
  filePath: string,
): Promise<void> {
  if (payload.action !== "dismissed") return;
  if (!payload.review.user.login.includes("quinn")) return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repoSlug = `${owner}/${repo}`;
  const reason = payload.review.dismissed_review?.dismissal_message ?? "";

  await trackCommentResponse({
    repo: repoSlug,
    filePath,
    commentBody: quinnCommentBody,
    responseBody: reason,
    dismissed: true,
    reason: reason.slice(0, 200),
  });

  console.log(
    `[github-comment-response] Review dismissed on ${repoSlug}#${payload.pull_request.number}` +
    (reason ? `: ${reason}` : ""),
  );
}

/**
 * Parse and route a raw GitHub webhook event to the appropriate handler.
 * Returns true if the event was handled.
 */
export function parseCommentResponsePayload(
  event: string,
  payload: unknown,
): { type: "comment_response" | "review_dismissal" | "unhandled" } {
  if (event === "pull_request_review_comment") {
    const p = payload as ReviewCommentPayload;
    if (p.action === "created" && p.comment.in_reply_to_id) {
      return { type: "comment_response" };
    }
  }

  if (event === "pull_request_review") {
    const p = payload as ReviewDismissalPayload;
    if (p.action === "dismissed") {
      return { type: "review_dismissal" };
    }
  }

  return { type: "unhandled" };
}

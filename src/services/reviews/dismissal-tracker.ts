/**
 * Dismissal tracker — intercepts developer responses to Quinn inline comments
 * and feeds them into the review learning loop.
 *
 * Called by the github-comment-response webhook handler when a developer
 * replies to or dismisses a Quinn review comment.
 */

import { recordDismissalEvent } from "../qdrant/review-learnings-indexer.ts";

export interface CommentResponseEvent {
  repo: string;
  filePath: string;
  commentBody: string;
  responseBody: string;
  dismissed: boolean;
  reason?: string;
}

/**
 * Detect file type from file path extension.
 */
function fileTypeFromPath(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() ?? "unknown";
}

/**
 * Process a developer response to a Quinn comment.
 *
 * Records the dismissal or approval in quinn-review-learnings.
 * Logs error but does not throw — failure here must not block the review flow.
 */
export async function trackCommentResponse(event: CommentResponseEvent): Promise<void> {
  const fileType = fileTypeFromPath(event.filePath);

  try {
    await recordDismissalEvent({
      repo: event.repo,
      fileType,
      commentPattern: event.commentBody,
      dismissed: event.dismissed,
      reason: event.reason,
    });

    console.log(
      `[dismissal-tracker] ${event.dismissed ? "Dismissed" : "Approved"} pattern in ${event.repo} (${fileType})` +
      (event.reason ? `: ${event.reason}` : ""),
    );
  } catch (err) {
    console.error("[dismissal-tracker] Failed to record comment response:", err);
    // Non-fatal — learning loop failure must not block review
  }
}

/**
 * Determine whether a developer response body indicates dismissal.
 *
 * Heuristics: "won't fix", "not applicable", "disagree", "by design", etc.
 */
export function isDismissalResponse(responseBody: string): boolean {
  const lower = responseBody.toLowerCase();
  const dismissalPhrases = [
    "won't fix",
    "wontfix",
    "not applicable",
    "n/a",
    "by design",
    "disagree",
    "false positive",
    "not an issue",
    "intentional",
    "this is fine",
  ];
  return dismissalPhrases.some(phrase => lower.includes(phrase));
}

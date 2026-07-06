/**
 * Typed bus event definitions for skill execution progress.
 */

export interface SkillProgressEvent {
  /** Correlation ID linking this event to the originating skill request */
  correlationId: string;
  /** Name of the skill being executed */
  skill: string;
  /** Name of the agent executing the skill */
  agentName: string;
  /** Type of intermediate event emitted by the agent */
  eventType: "tool_call" | "text" | "tool_result";
  /** Raw content of the event (tool input/output, text chunk, etc.) */
  content: unknown;
  /** Unix timestamp (ms) when this event was emitted */
  timestamp: number;
}

/** Bus topic for SkillProgressEvent messages */
export const SKILL_PROGRESS_TOPIC = "skill.progress" as const;

// ── release.published ────────────────────────────────────────────────────────

/**
 * Payload for `release.published` — a GitHub release went live on any fleet
 * repo. Normalized by the GitHub plugin from the `release` webhook.
 */
export interface ReleasePublishedPayload {
  owner: string;
  repo: string;
  /** The release tag, e.g. "v1.4.0". */
  version: string;
  /** Release title; falls back to the version when GitHub leaves it null. */
  name: string;
  /** Release notes body (markdown). Empty string when none. */
  body: string;
  /** Canonical GitHub Release URL. */
  url: string;
  /** Login of the actor who published the release. */
  author: string;
  prerelease: boolean;
  /** ISO timestamp from GitHub, or publish-handling time as a fallback. */
  publishedAt: string;
}

// ── review.* (review-learning signals) ───────────────────────────────────────
// The GitHub plugin publishes these raw webhook signals; the app-side
// ReviewLearningPlugin subscribes and runs the Qdrant indexing / dismissal
// tracking with its own GitHub auth. Keeps the heavy review-learning services
// out of the integration plugin — the bus is the contract.

/** Payload for `review.pr.merged` — a PR merged on a fleet repo. */
export interface ReviewPrMergedPayload {
  owner: string;
  repo: string;
  prNumber: number;
  /** The raw `pull_request` webhook payload (action=closed, merged=true). */
  webhook: Record<string, unknown>;
}

/**
 * Payload for `review.comment.replied` — someone replied to an inline review
 * comment (`pull_request_review_comment` created with `in_reply_to_id`).
 */
export interface ReviewCommentRepliedPayload {
  owner: string;
  repo: string;
  /** id of the parent comment this reply targets. */
  inReplyToId: number;
  /** The raw `pull_request_review_comment` webhook payload. */
  webhook: Record<string, unknown>;
}

/** Payload for `review.verdict.dismissed` — a formal PR review was dismissed. */
export interface ReviewDismissedPayload {
  owner: string;
  repo: string;
  /** Login of the review's author (the reviewer whose verdict was dismissed). */
  reviewAuthor: string;
  /** The raw `pull_request_review` webhook payload (action=dismissed). */
  webhook: Record<string, unknown>;
}

/**
 * ReviewLearningPlugin — subscribes to the raw review-learning signals the
 * GitHub plugin publishes and runs the heavy side of the pipeline: Qdrant
 * indexing of merged PRs, and dismissal-tracking of developer pushback on
 * Quinn's reviews.
 *
 * The GitHub plugin (lib/plugins/github.ts) stays a pure webhook↔bus bridge;
 * everything that needs src/services (diff fetching, chunking, embeddings,
 * Qdrant) lives here, behind three topics:
 *
 *   review.pr.merged          → index diff + symbols + review decision
 *   review.comment.replied    → fetch parent comment; if Quinn's, track reply
 *   review.verdict.dismissed  → if Quinn's review, record the dismissal
 *
 * All handlers are best-effort: a Qdrant/network failure logs a warning and
 * never propagates (the webhook path already acked).
 */

import type { EventBus, Plugin, BusMessage } from "../../lib/types.ts";
import type {
  ReviewPrMergedPayload,
  ReviewCommentRepliedPayload,
  ReviewDismissedPayload,
} from "../../lib/types/events.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";
import { logger } from "../../lib/log.ts";
import { handlePRMerge, parsePRMergePayload } from "../webhooks/github-pr-merge.ts";
import {
  handleCommentResponse,
  handleReviewDismissal,
  type ReviewCommentPayload,
  type ReviewDismissalPayload,
} from "../webhooks/github-comment-response.ts";

const log = logger("review-learning");

/** Reviewer-bot login prefix whose comments/reviews feed the learning loop. */
const REVIEWER_LOGIN_PREFIX = "protoquinn";

export class ReviewLearningPlugin implements Plugin {
  readonly name = "review-learning";
  readonly description = "Feeds merged PRs and review pushback into the Qdrant review-learning pipeline";
  readonly capabilities = ["review-learning"];
  readonly subscribes = ["review.pr.merged", "review.comment.replied", "review.verdict.dismissed"];

  private bus?: EventBus;
  private subscriptionIds: string[] = [];

  install(bus: EventBus): void {
    const getToken = makeGitHubAuth();
    if (!getToken) {
      log.warn("No GitHub auth configured — review-learning disabled");
      return;
    }
    this.bus = bus;

    this.subscriptionIds.push(
      bus.subscribe("review.pr.merged", this.name, (msg: BusMessage) => {
        const p = msg.payload as ReviewPrMergedPayload;
        const mergePayload = parsePRMergePayload("pull_request", p.webhook);
        if (!mergePayload) return;
        void handlePRMerge(mergePayload, getToken).catch((err) =>
          log.warn(`PR-merge indexing failed for ${p.owner}/${p.repo}#${p.prNumber}`, { err }),
        );
      }),
      bus.subscribe("review.comment.replied", this.name, (msg: BusMessage) => {
        const p = msg.payload as ReviewCommentRepliedPayload;
        void this._trackCommentResponse(p, getToken).catch((err) =>
          log.warn("comment-response tracking failed", { err }),
        );
      }),
      bus.subscribe("review.verdict.dismissed", this.name, (msg: BusMessage) => {
        const p = msg.payload as ReviewDismissedPayload;
        void this._trackReviewDismissal(p).catch((err) =>
          log.warn("review-dismissal tracking failed", { err }),
        );
      }),
    );
  }

  uninstall(): void {
    for (const id of this.subscriptionIds) this.bus?.unsubscribe(id);
    this.subscriptionIds = [];
  }

  /**
   * A developer replied to an inline review comment. If the parent comment was
   * Quinn's, feed the reply into the review-learning pipeline (dismissal-tracker)
   * with Quinn's original comment as the matched context.
   */
  private async _trackCommentResponse(
    p: ReviewCommentRepliedPayload,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    // Fetch the parent comment — only track replies to *Quinn's* comments.
    const token = await getToken(p.owner, p.repo);
    const res = await fetch(
      `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/comments/${p.inReplyToId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "protoWorkstacean/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      log.warn(`parent-comment fetch failed (${res.status}) for ${p.owner}/${p.repo} comment ${p.inReplyToId}`);
      return;
    }
    const parent = (await res.json()) as { user?: { login?: string }; body?: string };
    const parentAuthor = parent?.user?.login;
    if (!parentAuthor || !parentAuthor.toLowerCase().startsWith(REVIEWER_LOGIN_PREFIX)) return;

    await handleCommentResponse(p.webhook as unknown as ReviewCommentPayload, parent.body ?? "");
  }

  /** A Quinn review was dismissed — record the dismissal + reason for learning. */
  private async _trackReviewDismissal(p: ReviewDismissedPayload): Promise<void> {
    if (!p.reviewAuthor.toLowerCase().startsWith(REVIEWER_LOGIN_PREFIX)) return;
    const review = (p.webhook.review ?? {}) as Record<string, unknown>;
    await handleReviewDismissal(p.webhook as unknown as ReviewDismissalPayload, (review.body as string | null) ?? "", "");
  }
}

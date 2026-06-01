/**
 * Routing contract for the webhook handlers now wired into GitHubPlugin (#724 C).
 * These pure parse functions decide what _handleEvent dispatches to the
 * PR-merge indexer and the review-learning pipeline.
 */

import { describe, test, expect } from "bun:test";
import { parsePRMergePayload } from "../github-pr-merge.ts";
import { parseCommentResponsePayload } from "../github-comment-response.ts";

describe("parsePRMergePayload", () => {
  const merged = {
    action: "closed",
    pull_request: { number: 7, merged: true, merged_at: "2026-06-01T00:00:00Z", head: { sha: "s" }, base: { ref: "main", sha: "b" }, html_url: "u", title: "t" },
    repository: { name: "r", owner: { login: "o" } },
  };

  test("returns the payload for a merged pull_request.closed", () => {
    expect(parsePRMergePayload("pull_request", merged)).not.toBeNull();
  });
  test("null for a close-without-merge", () => {
    expect(parsePRMergePayload("pull_request", { ...merged, pull_request: { ...merged.pull_request, merged: false } })).toBeNull();
  });
  test("null for non-closed actions and non-PR events", () => {
    expect(parsePRMergePayload("pull_request", { ...merged, action: "opened" })).toBeNull();
    expect(parsePRMergePayload("push", merged)).toBeNull();
  });
});

describe("parseCommentResponsePayload", () => {
  test("routes a reply (in_reply_to_id) on a review comment to comment_response", () => {
    const p = { action: "created", comment: { in_reply_to_id: 99, body: "ok", path: "f", user: { login: "dev" } }, pull_request: { number: 1 }, repository: { name: "r", owner: { login: "o" } } };
    expect(parseCommentResponsePayload("pull_request_review_comment", p).type).toBe("comment_response");
  });
  test("a top-level review comment (no in_reply_to_id) is unhandled — not a reply to Quinn", () => {
    const p = { action: "created", comment: { body: "ok", path: "f", user: { login: "dev" } }, pull_request: { number: 1 }, repository: { name: "r", owner: { login: "o" } } };
    expect(parseCommentResponsePayload("pull_request_review_comment", p).type).toBe("unhandled");
  });
  test("routes a dismissed review to review_dismissal", () => {
    const p = { action: "dismissed", review: { body: null, state: "dismissed", user: { login: "protoquinn[bot]" } }, pull_request: { number: 1 }, repository: { name: "r", owner: { login: "o" } } };
    expect(parseCommentResponsePayload("pull_request_review", p).type).toBe("review_dismissal");
  });
  test("unrelated events are unhandled", () => {
    expect(parseCommentResponsePayload("issues", {}).type).toBe("unhandled");
    expect(parseCommentResponsePayload("pull_request_review", { action: "submitted" }).type).toBe("unhandled");
  });
});

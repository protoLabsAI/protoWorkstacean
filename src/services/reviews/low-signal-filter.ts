/**
 * Low-signal filter — queries quinn-review-learnings to determine whether a
 * comment pattern has historically been dismissed by developers.
 *
 * If dismissal rate > 50% for this repo/file_type combo, the pattern is
 * considered low-signal and should be skipped or de-prioritized.
 */

import { searchPoints } from "../qdrant/client.ts";
import { COLLECTION_REVIEW_LEARNINGS } from "../qdrant/collections.ts";
import { embed } from "../embeddings/ollama-client.ts";

export interface LowSignalCheckResult {
  isLowSignal: boolean;
  dismissalRate: number;
  dismissedCount: number;
  approvalCount: number;
  mostRecentReason: string;
}

const DISMISSAL_THRESHOLD = 0.5;
const MIN_SAMPLES = 3; // Need at least 3 data points to classify as low-signal

/**
 * Check whether a comment pattern is low-signal for the given repo and file type.
 *
 * Returns { isLowSignal: false } if Qdrant is unavailable, embedding fails,
 * or there are insufficient samples — erring on the side of showing comments.
 */
export async function isLowSignalPattern(
  repo: string,
  fileType: string,
  commentText: string,
): Promise<LowSignalCheckResult> {
  const defaultResult: LowSignalCheckResult = {
    isLowSignal: false,
    dismissalRate: 0,
    dismissedCount: 0,
    approvalCount: 0,
    mostRecentReason: "",
  };

  const vector = await embed(commentText);
  if (!vector) return defaultResult;

  const filter = {
    must: [
      { key: "repo", match: { value: repo } },
      { key: "file_type", match: { value: fileType } },
    ],
  };

  const results = await searchPoints(COLLECTION_REVIEW_LEARNINGS, vector, 1, filter);
  if (results.length === 0) return defaultResult;

  const top = results[0];
  // Only use results with high similarity (same pattern)
  if (top.score < 0.85) return defaultResult;

  const dismissed = Number(top.payload.dismissed_count ?? 0);
  const approved = Number(top.payload.approval_count ?? 0);
  const total = dismissed + approved;

  if (total < MIN_SAMPLES) return defaultResult;

  const dismissalRate = dismissed / total;

  return {
    isLowSignal: dismissalRate > DISMISSAL_THRESHOLD,
    dismissalRate,
    dismissedCount: dismissed,
    approvalCount: approved,
    mostRecentReason: String(top.payload.most_recent_reason ?? ""),
  };
}

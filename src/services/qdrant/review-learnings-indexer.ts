/**
 * Review learnings indexer — stores and updates dismissed Quinn comment patterns
 * in quinn-review-learnings.
 *
 * Tracks dismissal/approval counts per (repo, file_type, pattern) so the
 * low-signal filter can skip historically dismissed comments.
 */

import { upsertPoints, searchPoints } from "./client.ts";
import { COLLECTION_REVIEW_LEARNINGS } from "./collections.ts";
import { embed } from "../embeddings/ollama-client.ts";

export interface DismissalEvent {
  repo: string;
  fileType: string;
  commentPattern: string;
  dismissed: boolean;
  reason?: string;
}

export interface LearningRecord {
  repo: string;
  fileType: string;
  dismissedCount: number;
  approvalCount: number;
  mostRecentReason: string;
  lastUpdated: string;
}

/**
 * Upsert a dismissal event into quinn-review-learnings.
 *
 * If a similar pattern already exists (cosine similarity > 0.9), increments
 * its counters. Otherwise creates a new entry.
 */
export async function recordDismissalEvent(event: DismissalEvent): Promise<boolean> {
  const vector = await embed(event.commentPattern);
  if (!vector) return false;

  // Search for an existing similar pattern in this repo+file_type context
  const filter = {
    must: [
      { key: "repo", match: { value: event.repo } },
      { key: "file_type", match: { value: event.fileType } },
    ],
  };

  const existing = await searchPoints(COLLECTION_REVIEW_LEARNINGS, vector, 1, filter);

  let dismissedCount = event.dismissed ? 1 : 0;
  let approvalCount = event.dismissed ? 0 : 1;
  let pointId: number;

  if (existing.length > 0 && existing[0].score > 0.9) {
    // Update existing record
    const prev = existing[0].payload;
    dismissedCount += Number(prev.dismissed_count ?? 0);
    approvalCount += Number(prev.approval_count ?? 0);
    pointId = Number(existing[0].id);
  } else {
    // New pattern
    pointId = hashString(`${event.repo}-${event.fileType}-${event.commentPattern}-${Date.now()}`);
  }

  return await upsertPoints(COLLECTION_REVIEW_LEARNINGS, [{
    id: pointId,
    vector,
    payload: {
      repo: event.repo,
      file_type: event.fileType,
      dismissed_count: dismissedCount,
      approval_count: approvalCount,
      most_recent_reason: event.reason ?? "",
      last_updated: new Date().toISOString(),
    },
  }]);
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

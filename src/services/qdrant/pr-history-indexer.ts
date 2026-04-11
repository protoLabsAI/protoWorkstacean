/**
 * PR history indexer — indexes merged PR diff chunks into quinn-pr-history.
 *
 * Called on PR merge webhook. For each file chunk in the diff:
 *   1. Embed the chunk text via Ollama
 *   2. Store to Qdrant with metadata: repo, pr_number, file, decision, merged_at, pr_url
 */

import { upsertPoints } from "./client.ts";
import { COLLECTION_PR_HISTORY } from "./collections.ts";
import { embed } from "../embeddings/ollama-client.ts";
import type { DiffChunk } from "../diff/chunker.ts";
import type { PRMetadata, ReviewDecision } from "../github/diff-fetcher.ts";

export interface PRHistoryRecord {
  meta: PRMetadata;
  chunks: DiffChunk[];
  decision: ReviewDecision;
  reviewIssues: string;
}

/**
 * Index all diff chunks from a merged PR into quinn-pr-history.
 *
 * Skips chunks that fail to embed (logs warning).
 * Returns the number of points successfully indexed.
 */
export async function indexPRHistory(record: PRHistoryRecord): Promise<number> {
  const { meta, chunks, decision, reviewIssues } = record;
  let indexed = 0;
  let failures = 0;

  for (const chunk of chunks) {
    const text = `File: ${chunk.filePath}\n\n${chunk.content}`;
    const vector = await embed(text);

    if (!vector) {
      failures++;
      const total = indexed + failures;
      if (total >= 10 && failures / total > 0.1) {
        console.warn(`[pr-history-indexer] High embedding failure rate: ${failures}/${total}`);
      }
      continue;
    }

    const id = `${meta.owner}-${meta.repo}-${meta.prNumber}-${chunk.filePath.replace(/\//g, "_")}-${chunk.chunkIndex}`;
    // Use a numeric hash for the Qdrant point ID
    const pointId = hashString(id);

    const success = await upsertPoints(COLLECTION_PR_HISTORY, [{
      id: pointId,
      vector,
      payload: {
        repo: `${meta.owner}/${meta.repo}`,
        pr_number: meta.prNumber,
        file: chunk.filePath,
        decision,
        merged_at: meta.mergedAt,
        pr_url: meta.prUrl,
        chunk_index: chunk.chunkIndex,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        review_issues: reviewIssues,
      },
    }]);

    if (success) indexed++;
  }

  console.log(`[pr-history-indexer] PR #${meta.prNumber} ${meta.owner}/${meta.repo}: ${indexed} chunks indexed, ${failures} failed`);
  return indexed;
}

/** Simple deterministic hash for stable point IDs. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0; // keep unsigned 32-bit
  }
  return h;
}

/**
 * Initialize Qdrant collections for Quinn's vector context pipeline.
 *
 * Three collections:
 *   quinn-pr-history       — embedded diff chunks from merged PRs
 *   quinn-code-patterns    — symbol definitions and surrounding context
 *   quinn-review-learnings — dismissed comment patterns for low-signal filtering
 *
 * Calls ensureCollection for each — creates if not present, no-ops if already exists.
 */

import {
  ensureCollection,
  getCollectionVectorSize,
  deleteCollection,
} from "./client.ts";
import { logger } from "../../../lib/log.ts";

const log = logger("qdrant");

// Vector dimension must match the configured embedding model. We embed through
// the fleet gateway's `qwen3-embedding` (Qwen3-Embedding-0.6B), which is
// 1024-dimensional. (Was 768 under the retired Ollama `nomic-embed-text`.)
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE ?? "1024", 10);

export const COLLECTION_PR_HISTORY = "quinn-pr-history";
export const COLLECTION_CODE_PATTERNS = "quinn-code-patterns";
export const COLLECTION_REVIEW_LEARNINGS = "quinn-review-learnings";

/**
 * Initialize all three Quinn Qdrant collections.
 * Safe to call multiple times — uses PUT which is idempotent.
 * Returns true if all collections are ready.
 */
export async function initializeCollections(): Promise<boolean> {
  // Migration guard: Qdrant can't resize vectors in place. If a collection
  // already exists at a different dimension (e.g. the old 768-dim Ollama vectors
  // after the move to 1024-dim qwen3-embedding), drop it so it's recreated at
  // the current size. The embedded content rebuilds from source (PR history /
  // code / review learnings) on the next indexing pass — no durable data lost.
  for (const name of [COLLECTION_PR_HISTORY, COLLECTION_CODE_PATTERNS, COLLECTION_REVIEW_LEARNINGS]) {
    const existing = await getCollectionVectorSize(name);
    if (existing !== null && existing !== VECTOR_SIZE) {
      log.warn(
        `Collection ${name} is ${existing}-dim but config is ${VECTOR_SIZE}-dim — ` +
          `recreating (embedding-model dimension change). Old vectors are dropped and re-indexed.`,
      );
      await deleteCollection(name);
    }
  }

  const results = await Promise.all([
    ensureCollection(COLLECTION_PR_HISTORY, {
      vectorSize: VECTOR_SIZE,
      distance: "Cosine",
    }),
    ensureCollection(COLLECTION_CODE_PATTERNS, {
      vectorSize: VECTOR_SIZE,
      distance: "Cosine",
    }),
    ensureCollection(COLLECTION_REVIEW_LEARNINGS, {
      vectorSize: VECTOR_SIZE,
      distance: "Cosine",
    }),
  ]);

  const allReady = results.every(r => r);

  if (allReady) {
    log.info("Collections initialized: quinn-pr-history, quinn-code-patterns, quinn-review-learnings");
  } else {
    log.warn("One or more collections failed to initialize — vector context will be unavailable");
  }

  return allReady;
}

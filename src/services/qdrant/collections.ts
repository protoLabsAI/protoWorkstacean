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

import { ensureCollection } from "./client.ts";
import { CONFIG } from "../../config/env.ts";

// Vector dimension must match the configured Ollama embedding model.
// nomic-embed-text produces 768-dimensional vectors.
const VECTOR_SIZE = parseInt(CONFIG.QDRANT_VECTOR_SIZE ?? "768", 10);

export const COLLECTION_PR_HISTORY = "quinn-pr-history";
export const COLLECTION_CODE_PATTERNS = "quinn-code-patterns";
export const COLLECTION_REVIEW_LEARNINGS = "quinn-review-learnings";

/**
 * Initialize all three Quinn Qdrant collections.
 * Safe to call multiple times — uses PUT which is idempotent.
 * Returns true if all collections are ready.
 */
export async function initializeCollections(): Promise<boolean> {
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
    console.log("[qdrant] Collections initialized: quinn-pr-history, quinn-code-patterns, quinn-review-learnings");
  } else {
    console.warn("[qdrant] One or more collections failed to initialize — vector context will be unavailable");
  }

  return allReady;
}

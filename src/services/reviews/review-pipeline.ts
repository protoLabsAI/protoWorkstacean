/**
 * Quinn review pipeline — orchestrates the full Qdrant context retrieval and
 * prompt assembly pipeline.
 *
 * Steps:
 *   1. Parse diff → extract symbols
 *   2. Retrieve past PR decisions for each changed file (from quinn-pr-history)
 *   3. Find similar code patterns for each changed symbol (from quinn-code-patterns)
 *   4. Format CODEBASE CONTEXT block
 *   5. Apply token budget
 *   6. Assemble review prompt
 *
 * If Qdrant is unavailable at any step, logs a warning and continues with
 * diff-only review (no CODEBASE CONTEXT block).
 */

import { parseDiff, chunkDiff } from "../diff/chunker.ts";
import { extractAllSymbols } from "../diff/symbol-extractor.ts";
import { retrieveAllPastPRDecisions } from "../qdrant/past-pr-retriever.ts";
import { findAllSimilarPatterns } from "../qdrant/pattern-searcher.ts";
import { assembleReviewPrompt } from "./quinn-review-prompt.ts";
import { checkHealth } from "../qdrant/client.ts";
import type { AssembledPrompt } from "./quinn-review-prompt.ts";
import type { CodebaseContext } from "./context-formatter.ts";

export interface PipelineInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  title: string;
  diff: string;
  promptBudget?: number;
}

export interface PipelineResult {
  assembled: AssembledPrompt;
  qdrantAvailable: boolean;
  symbolCount: number;
  fileCount: number;
}

/**
 * Run the full Quinn context retrieval and prompt assembly pipeline.
 */
export async function runReviewPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { repo, prNumber, prUrl, title, diff } = input;

  // Parse diff into files and symbols
  const diffFiles = parseDiff(diff);
  const symbols = extractAllSymbols(diffFiles);
  const filePaths = [...new Set(diffFiles.map(f => f.path))];

  // Check Qdrant availability
  const qdrantAvailable = await checkHealth();

  let context: CodebaseContext | undefined;

  if (qdrantAvailable) {
    try {
      const [pastDecisions, similarPatterns] = await Promise.all([
        retrieveAllPastPRDecisions(repo, filePaths),
        findAllSimilarPatterns(symbols),
      ]);

      if (pastDecisions.size > 0 || similarPatterns.size > 0) {
        context = { pastDecisions, similarPatterns };
      }
    } catch (err) {
      console.warn("[review-pipeline] Qdrant context retrieval failed — proceeding with diff-only review:", err);
    }
  } else {
    console.warn("[review-pipeline] Qdrant unavailable — proceeding with diff-only review");
  }

  const assembled = assembleReviewPrompt({
    diff,
    repo,
    prNumber,
    prUrl,
    title,
    context,
    promptBudget: input.promptBudget,
  });

  console.log(
    `[review-pipeline] PR #${prNumber} ${repo}: ` +
    `${filePaths.length} files, ${symbols.length} symbols, ` +
    `context=${assembled.hasContext}, tokens=${assembled.totalTokens}`,
  );

  return {
    assembled,
    qdrantAvailable,
    symbolCount: symbols.length,
    fileCount: filePaths.length,
  };
}

/**
 * Index PR history after a merge (called from the merge webhook).
 * Extracted here to allow the review pipeline to also trigger indexing.
 */
export { indexPRHistory } from "../qdrant/pr-history-indexer.ts";
export { initializeCollections } from "../qdrant/collections.ts";

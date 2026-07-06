/**
 * Quinn codebase-context retrieval — the READ side of the review-learning
 * flywheel.
 *
 * Steps: parse diff → extract changed symbols → retrieve past PR decisions
 * for the changed files (quinn-pr-history) + similar code patterns for the
 * changed symbols (quinn-code-patterns) → format the CODEBASE CONTEXT block →
 * token-budget it (context is capped at 20% of the review budget).
 *
 * Consumed by pr_inspector's `diff_summary` action, so every review that
 * reads a diff also reads what past merges to those files taught. Best-effort
 * end to end: Qdrant unavailable, embedding failure, or an empty store all
 * return null and the review proceeds diff-only — never an error, never a
 * stall.
 */

import { parseDiff } from "../diff/chunker.ts";
import { extractAllSymbols } from "../diff/symbol-extractor.ts";
import { retrieveAllPastPRDecisions } from "../qdrant/past-pr-retriever.ts";
import { findAllSimilarPatterns } from "../qdrant/pattern-searcher.ts";
import { checkHealth } from "../qdrant/client.ts";
import { formatCodebaseContext, type CodebaseContext } from "./context-formatter.ts";
import { applyTokenBudget } from "./token-budgeter.ts";
import { logger } from "../../../lib/log.ts";

const log = logger("review-pipeline");

/** Review-prompt budget the context is carved from (applyTokenBudget caps context at 20%). */
const REVIEW_PROMPT_BUDGET = 8_000;

/**
 * Retrieval fan-out caps. Each file and each symbol costs one gateway embed
 * call plus one Qdrant search on the diff_summary hot path, so a 40-file PR
 * must not turn into 100+ network calls. The first files/symbols of the diff
 * carry the bulk of the signal.
 */
const MAX_FILES = 6;
const MAX_SYMBOLS = 8;

/**
 * Build the CODEBASE CONTEXT block for a review, or null when there is
 * nothing to say (Qdrant down, store empty, retrieval failed).
 */
export async function buildCodebaseContext(repo: string, diff: string): Promise<string | null> {
  if (!(await checkHealth())) {
    log.warn(`Qdrant unavailable — ${repo} reviews diff-only`);
    return null;
  }

  try {
    const diffFiles = parseDiff(diff);
    const filePaths = [...new Set(diffFiles.map((f) => f.path))].slice(0, MAX_FILES);
    const symbols = extractAllSymbols(diffFiles).slice(0, MAX_SYMBOLS);

    const [pastDecisions, similarPatterns] = await Promise.all([
      retrieveAllPastPRDecisions(repo, filePaths),
      findAllSimilarPatterns(symbols),
    ]);
    if (pastDecisions.size === 0 && similarPatterns.size === 0) return null;

    const context: CodebaseContext = { pastDecisions, similarPatterns };
    const block = formatCodebaseContext(applyTokenBudget(context, REVIEW_PROMPT_BUDGET));
    if (!block) return null;

    log.info(
      `${repo}: context block built — ${pastDecisions.size} file(s) with history, ` +
        `${similarPatterns.size} symbol(s) with patterns`,
    );
    return block;
  } catch (err) {
    log.warn(`context retrieval failed — ${repo} reviews diff-only`, { err });
    return null;
  }
}

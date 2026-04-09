/**
 * Token budgeter — enforces a 20% token budget cap on the CODEBASE CONTEXT block.
 *
 * Token estimation: 1 token ≈ 4 characters (GPT-style approximation).
 *
 * Priority order when truncating:
 *   1. Past PR decisions (always keep — highest value)
 *   2. Similar code patterns (trim from lowest-scored pattern)
 *   3. Learnings summary (drop first if over budget)
 */

import type { CodebaseContext } from "./context-formatter.ts";
import type { SimilarPattern } from "../qdrant/pattern-searcher.ts";

const CHARS_PER_TOKEN = 4;
const CONTEXT_BUDGET_FRACTION = 0.2;

/**
 * Estimate token count from a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Apply token budget to the CodebaseContext.
 *
 * totalPromptBudget: total token budget for the full prompt.
 * Returns a trimmed CodebaseContext that fits within 20% of that budget.
 */
export function applyTokenBudget(
  ctx: CodebaseContext,
  totalPromptBudget: number,
): CodebaseContext {
  const maxContextTokens = Math.floor(totalPromptBudget * CONTEXT_BUDGET_FRACTION);

  // Start with the full context and measure
  let currentTokens = estimateContextTokens(ctx);

  if (currentTokens <= maxContextTokens) return ctx;

  // Trim similar patterns (lowest priority, trim from end) until within budget
  const trimmedPatterns = new Map(
    [...ctx.similarPatterns].map(([k, v]) => [k, [...v]])
  );

  while (currentTokens > maxContextTokens) {
    const removed = removeLowestScoredPattern(trimmedPatterns);
    if (!removed) break; // Nothing left to remove
    currentTokens = estimateContextTokens({
      pastDecisions: ctx.pastDecisions,
      similarPatterns: trimmedPatterns,
    });
  }

  return {
    pastDecisions: ctx.pastDecisions,
    similarPatterns: trimmedPatterns,
  };
}

/**
 * Estimate tokens used by a CodebaseContext.
 */
function estimateContextTokens(ctx: CodebaseContext): number {
  let chars = "CODEBASE CONTEXT:\n".length;

  for (const [filePath, decisions] of ctx.pastDecisions) {
    chars += filePath.length + 20;
    for (const d of decisions) {
      chars += `PR #${d.prNumber} (${d.mergedAt}): ${d.decision} — ${d.reviewIssues}`.length + 10;
    }
  }

  for (const [symbolKey, patterns] of ctx.similarPatterns) {
    chars += symbolKey.length + 10;
    for (const p of patterns) {
      chars += p.file.length + p.context.length + 30;
    }
  }

  return estimateTokens(chars.toString()) + Math.floor(chars / CHARS_PER_TOKEN);
}

/**
 * Remove the lowest-scored pattern from the map.
 * Returns false if no patterns remain.
 */
function removeLowestScoredPattern(
  patterns: Map<string, SimilarPattern[]>,
): boolean {
  let lowestKey: string | null = null;
  let lowestScore = Infinity;
  let lowestIndex = -1;

  for (const [key, pats] of patterns) {
    for (let i = 0; i < pats.length; i++) {
      if (pats[i].score < lowestScore) {
        lowestScore = pats[i].score;
        lowestKey = key;
        lowestIndex = i;
      }
    }
  }

  if (lowestKey === null || lowestIndex === -1) return false;

  const pats = patterns.get(lowestKey)!;
  pats.splice(lowestIndex, 1);
  if (pats.length === 0) patterns.delete(lowestKey);

  return true;
}

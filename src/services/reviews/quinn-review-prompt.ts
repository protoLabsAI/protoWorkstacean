/**
 * Quinn review prompt assembler.
 *
 * Builds the full review prompt by prepending a CODEBASE CONTEXT block
 * (retrieved from Qdrant) before the diff section.
 *
 * The context block is token-budgeted to at most 20% of the total prompt budget.
 */

import { formatCodebaseContext } from "./context-formatter.ts";
import { applyTokenBudget, estimateTokens } from "./token-budgeter.ts";
import type { CodebaseContext } from "./context-formatter.ts";

// Default total prompt token budget (conservative estimate for most models)
const DEFAULT_PROMPT_BUDGET = 8_000;

export interface ReviewPromptInput {
  diff: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  title: string;
  context?: CodebaseContext;
  promptBudget?: number;
}

export interface AssembledPrompt {
  prompt: string;
  contextTokens: number;
  diffTokens: number;
  totalTokens: number;
  hasContext: boolean;
}

/**
 * Assemble the full Quinn review prompt with optional CODEBASE CONTEXT block.
 *
 * Structure:
 *   [CODEBASE CONTEXT block — if context available]
 *   PR: <title>
 *   Repo: <owner/repo> | PR #<n>
 *   URL: <pr_url>
 *
 *   <diff>
 */
export function assembleReviewPrompt(input: ReviewPromptInput): AssembledPrompt {
  const budget = input.promptBudget ?? DEFAULT_PROMPT_BUDGET;

  let contextBlock = "";
  if (input.context) {
    const budgeted = applyTokenBudget(input.context, budget);
    contextBlock = formatCodebaseContext(budgeted);
  }

  const header = [
    `PR: ${input.title}`,
    `Repo: ${input.repo} | PR #${input.prNumber}`,
    `URL: ${input.prUrl}`,
  ].join("\n");

  const parts = [
    contextBlock,
    header,
    "",
    input.diff,
  ].filter(Boolean);

  const prompt = parts.join("\n");

  const contextTokens = estimateTokens(contextBlock);
  const diffTokens = estimateTokens(input.diff);
  const totalTokens = estimateTokens(prompt);

  return {
    prompt,
    contextTokens,
    diffTokens,
    totalTokens,
    hasContext: contextBlock.length > 0,
  };
}

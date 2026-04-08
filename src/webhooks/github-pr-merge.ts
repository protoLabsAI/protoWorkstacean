/**
 * GitHub PR merge webhook handler.
 *
 * Listens for pull_request.closed events with merged=true.
 * On merge:
 *   1. Fetch full PR diff via GitHub API
 *   2. Parse diff and chunk for embedding
 *   3. Extract symbols from changed files
 *   4. Index diff chunks to quinn-pr-history (Qdrant)
 *   5. Fetch symbol contexts and index to quinn-code-patterns
 *
 * This handler is designed to be called from the existing GitHubPlugin
 * webhook receiver or a standalone HTTP handler.
 */

import { fetchPRDiff, fetchReviewComments, fetchReviewDecision, summarizeReviewIssues } from "../services/github/diff-fetcher.ts";
import { parseDiff, chunkDiff } from "../services/diff/chunker.ts";
import { extractAllSymbols } from "../services/diff/symbol-extractor.ts";
import { fetchSymbolContexts } from "../services/codebase/symbol-fetcher.ts";
import { indexPRHistory } from "../services/qdrant/pr-history-indexer.ts";
import { indexCodePatterns } from "../services/qdrant/code-patterns-indexer.ts";
import type { PRMetadata } from "../services/github/diff-fetcher.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PRMergePayload {
  action: "closed";
  pull_request: {
    number: number;
    merged: boolean;
    merged_at: string | null;
    html_url: string;
    title: string;
    base: { ref: string; sha: string };
    head: { sha: string };
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

/**
 * Handle a pull_request.closed event.
 * No-ops if the PR was closed without merging.
 */
export async function handlePRMerge(
  payload: PRMergePayload,
  getToken: (owner: string, repo: string) => Promise<string>,
): Promise<void> {
  const pr = payload.pull_request;

  if (!pr.merged || !pr.merged_at) {
    // PR was closed without merging — nothing to index
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = pr.number;

  console.log(`[github-pr-merge] Processing merged PR #${prNumber} in ${owner}/${repo}`);

  const token = await getToken(owner, repo);

  const meta: PRMetadata = {
    owner,
    repo,
    prNumber,
    baseBranch: pr.base.ref,
    mergedAt: pr.merged_at,
    prUrl: pr.html_url,
    title: pr.title,
  };

  // Fetch diff, comments, and review decision in parallel
  const [diff, comments, decision] = await Promise.all([
    fetchPRDiff(meta, token),
    fetchReviewComments(meta, token),
    fetchReviewDecision(meta, token),
  ]);

  if (!diff) {
    console.warn(`[github-pr-merge] Empty diff for PR #${prNumber} — skipping indexing`);
    return;
  }

  const reviewIssues = summarizeReviewIssues(comments);
  const diffFiles = parseDiff(diff);
  const chunks = chunkDiff(diffFiles);
  const symbols = extractAllSymbols(diffFiles);

  // Index PR history
  await indexPRHistory({
    meta,
    chunks,
    decision,
    reviewIssues,
  });

  // Index code patterns (symbol contexts)
  if (symbols.length > 0) {
    const symbolContexts = await fetchSymbolContexts(owner, repo, pr.head.sha, symbols, token);
    if (symbolContexts.length > 0) {
      await indexCodePatterns(symbolContexts);
    }
  }

  console.log(
    `[github-pr-merge] Indexed PR #${prNumber} ${owner}/${repo}: ` +
    `${chunks.length} chunks, ${symbols.length} symbols, decision=${decision}`,
  );
}

/**
 * Parse and validate a raw GitHub webhook payload for the PR merge handler.
 * Returns null if the event is not a merged PR close event.
 */
export function parsePRMergePayload(
  event: string,
  payload: unknown,
): PRMergePayload | null {
  if (event !== "pull_request") return null;

  const p = payload as Record<string, unknown>;
  if (p.action !== "closed") return null;

  const pr = p.pull_request as Record<string, unknown> | undefined;
  if (!pr?.merged) return null;

  return payload as PRMergePayload;
}

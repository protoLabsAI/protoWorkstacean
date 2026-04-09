---
title: Context Injection — Quinn Codebase-Wide Review Context
---

# Context Injection — Quinn Codebase-Wide Review Context

Quinn's vector context pipeline injects a `CODEBASE CONTEXT` block into review prompts,
giving the LLM cross-repository awareness beyond the current diff.

## How It Works

```
PR review triggered
  → parseDiff(diff) — extract changed files and hunks
  → extractAllSymbols(files) — identify changed functions/classes/exports
  → [parallel]
      retrieveAllPastPRDecisions(repo, filePaths)   → quinn-pr-history
      findAllSimilarPatterns(symbols)               → quinn-code-patterns
  → formatCodebaseContext({ pastDecisions, similarPatterns })
  → applyTokenBudget(context, totalBudget)
  → assembleReviewPrompt({ diff, context, ... })
  → LLM call with enriched prompt
```

## CODEBASE CONTEXT Block Format

```
CODEBASE CONTEXT:

Past PR decisions on changed files:
  src/middleware/auth.ts:
    - PR #142 (2026-04-01): APPROVE — Token expiry not checked; consider adding clock skew tolerance
    - PR #138 (2026-03-15): REQUEST_CHANGES — JWT secret not validated at startup

Similar code patterns across the repository:
  `validateToken` in src/utils/jwt.ts:23 (protolabsai/protomaker)
    23: export function validateToken(token: string): boolean {
    24:   // Similar implementation without expiry check
    25: }
```

## Token Budget

The context block is capped at **20% of the total prompt token budget**.

Token estimation: `1 token ≈ 4 characters` (GPT-style approximation).

**Priority order when truncating:**
1. Past PR decisions — always kept (highest value, historically proven)
2. Similar code patterns — trimmed from lowest-scored pattern first

If the budget is too small to include any context, the block is omitted entirely
and the review proceeds with diff-only mode.

## Fallback Behavior

| Condition | Action |
|---|---|
| Qdrant unavailable | Log warning, skip context block, diff-only review |
| Embedding fails for a chunk | Skip that chunk, continue with remaining |
| No historical context found | Omit that section from the block |
| Context exceeds 20% token budget | Truncate low-priority items |

## PR History Indexing

On PR merge (`pull_request.closed` + `merged: true`):

```
fetch diff + comments + decision
  → parseDiff → chunkDiff (500-line blocks with 50-line overlap for large files)
  → embed each chunk via Ollama
  → upsert to quinn-pr-history with metadata
  → extractAllSymbols → fetchSymbolContexts (GitHub raw content API)
  → embed each symbol context
  → upsert to quinn-code-patterns
```

## Review Learning Loop

When a developer responds to a Quinn inline comment:

```
pull_request_review_comment.created (with in_reply_to_id)
  → isDismissalResponse(responseBody) — heuristic detection
  → trackCommentResponse({ repo, filePath, commentBody, dismissed, reason })
  → recordDismissalEvent → quinn-review-learnings
```

Before generating a comment, Quinn checks `isLowSignalPattern(repo, fileType, commentText)`.
If dismissal rate > 50% with at least 3 samples, the comment is skipped.

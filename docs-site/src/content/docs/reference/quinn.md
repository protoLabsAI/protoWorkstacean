---
title: Quinn — PR Review Bot Reference
---

# Quinn — PR Review Bot Reference

_This is a reference doc. It covers Quinn's review pipeline, vector context system, budget tracking, configuration, and bus topics._

See also:
- [`how-to/use-quinn-pr-review.md`](../how-to/use-quinn-pr-review.md) — setup and operation guide
- [`reference/bus-topics.md`](bus-topics.md) — full bus topic listing

---

## What Quinn does

Quinn is Workstacean's inline PR review bot, replacing CodeRabbit. It reviews every pull request automatically, posting structured inline comments directly on the diff via the GitHub Review API. Quinn reviews as `protoquinn[bot]` (GitHub App identity).

Unlike CodeRabbit:
- Quinn does **not** auto-fix code or open follow-up PRs
- Quinn does **not** support multi-turn review conversations
- Quinn uses **codebase-wide vector search** (Qdrant + Ollama) to inform reviews with past PR decisions and similar code patterns

---

## Triggers

Quinn's `pr_review` skill is triggered by `pull_request` GitHub webhook events:

| Event action | Behavior |
|---|---|
| `opened` | Full review posted automatically |
| `synchronize` | Review posted if new commits since last review |
| `ready_for_review` | Full review (draft → open transition) |

Draft PRs are skipped unless `force_review: true` is set. Incremental review: Quinn tracks `last_reviewed_sha` per PR and skips if no new commits have landed.

---

## Review pipeline

```
GitHub webhook (pull_request.opened / synchronize)
  │
  ▼
prReview skill
  │  check last_reviewed_sha — skip if no new commits
  │  skip draft PRs unless force_review
  ▼
review() orchestrator
  │
  ├─ Fetch PR diff from GitHub API
  │
  ├─ parseDiff() → diffFiles
  │   └─ extractAllSymbols() → TypeScript / Python / Go symbols
  │
  ├─ checkHealth() — Qdrant available?
  │   ├─ YES → parallel:
  │   │    ├─ retrieveAllPastPRDecisions(repo, filePaths)
  │   │    │    └─ queries quinn-pr-history (per changed file)
  │   │    └─ findAllSimilarPatterns(symbols)
  │   │         └─ queries quinn-code-patterns (per extracted symbol)
  │   └─ NO  → diff-only review (no CODEBASE CONTEXT block)
  │
  ├─ assembleReviewPrompt()
  │   ├─ applyTokenBudget() — cap context at 20% of prompt token budget
  │   ├─ formatCodebaseContext() — CODEBASE CONTEXT block
  │   └─ header (PR title, repo, URL) + diff
  │
  ├─ LLM call (claude-sonnet-4-6)
  │   └─ returns: event (APPROVE / REQUEST_CHANGES), summary, inline comments
  │
  └─ GitHubReviewSubmitter.submitReview()
      └─ POST /repos/{owner}/{repo}/pulls/{number}/reviews
```

### Patch position mapping

Inline comments require a `position` field — the line offset within the unified diff hunk, not the file line number. Quinn's diff chunker (`src/services/diff/chunker.ts`) maps each changed line to its patch position so comments land on the correct line in the GitHub UI.

### Fallback

If Qdrant is unavailable at any point during context retrieval, Quinn logs a warning and proceeds with a diff-only review. No error is surfaced to the PR author.

---

## Vector context

Quinn injects a `CODEBASE CONTEXT` block into review prompts, giving the LLM cross-repository awareness beyond the current diff.

### Context pipeline

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

### Collections

| Collection | Contents | Used for |
|---|---|---|
| `quinn-pr-history` | Embedded diff chunks from merged PRs | Past decisions for the same files |
| `quinn-code-patterns` | Symbol definitions + surrounding context | Similar code patterns across the codebase |
| `quinn-review-learnings` | Dismissed comment patterns | Low-signal comment filtering |

**Embedding model:** `nomic-embed-text` via Ollama (768-dimensional cosine vectors, configurable via `QDRANT_VECTOR_SIZE`).

Collections are created on first use via `initializeCollections()` from `src/services/qdrant/collections.ts`. Idempotent — safe to call on every startup.

### CODEBASE CONTEXT block format

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

### Token budget

The `CODEBASE CONTEXT` block is capped at **20% of the total prompt token budget** (default budget: 8,000 tokens → max 1,600 context tokens).

Token estimation: `1 token ≈ 4 characters` (GPT-style approximation). The conservative `maxCost` is 1.5× the estimate when heuristics are used.

**Truncation priority:**
1. Past PR decisions — always kept (highest value, historically proven)
2. Similar patterns — trimmed from lowest-scored first
3. If budget too small for any context, block is omitted and review proceeds diff-only

### Fallback behavior

| Condition | Action |
|---|---|
| Qdrant unavailable | Log warning, skip context block, diff-only review |
| Embedding fails for a chunk | Skip that chunk, continue with remaining |
| No historical context found | Omit that section from the block |
| Context exceeds 20% token budget | Truncate low-priority items |

### PR history indexing

After a PR merges (`pull_request.closed` + `merged: true`), `indexPRHistory()` (exported from `review-pipeline.ts`) runs:

```
fetch diff + comments + decision
  → parseDiff → chunkDiff (500-line blocks with 50-line overlap for large files)
  → embed each chunk via Ollama
  → upsert to quinn-pr-history with metadata
  → extractAllSymbols → fetchSymbolContexts (GitHub raw content API)
  → embed each symbol context
  → upsert to quinn-code-patterns
```

### Learning loop

When a developer responds to a Quinn inline comment:

```
pull_request_review_comment.created (with in_reply_to_id)
  → isDismissalResponse(responseBody) — heuristic detection
  → trackCommentResponse({ repo, filePath, commentBody, dismissed, reason })
  → recordDismissalEvent → quinn-review-learnings
```

`dismissal-tracker.ts` records the dismissal; `low-signal-filter.ts` uses `isLowSignalPattern(repo, fileType, commentText)` to suppress similar patterns in future reviews. If dismissal rate exceeds 50% with ≥ 3 samples, the comment is skipped.

---

## BudgetTracker

Quinn's LLM calls go through the system-wide `BudgetTracker` (`lib/plugins/budget-tracker.ts`), backed by SQLite (`budget.db`).

**Per-PR cost limits** are enforced via the BudgetPlugin tier system:

| Tier | Max estimated cost | Behavior |
|---|---|---|
| L0 | < $0.10 | Fully autonomous |
| L1 | < $1.00 | Proceeds, notifies ops channel |
| L2 | < $5.00 | Proceeds, logs warning |
| L3 | ≥ $5.00 | Blocked — escalates to HITL |

**Daily caps** (system-wide, not Quinn-specific):
- `$10` per project per day
- `$50` total across all projects per day

**Record ordering:** The ledger uses `ORDER BY timestamp DESC, rowid DESC` — in the case of two records with the same timestamp, the higher `rowid` (later insertion) is returned first. This matters when querying the `cost_trail` for L3 escalations.

**Fallback:** If SQLite is unavailable, BudgetTracker falls back to an in-memory map with a write-ahead log (WAL). Records are drained to SQLite on recovery.

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes (if no App) | PAT — enables GitHub plugin |
| `GITHUB_WEBHOOK_SECRET` | Recommended | Validates `X-Hub-Signature-256` |
| `GITHUB_WEBHOOK_PORT` | No | Webhook server port (default: `8082`) |
| `QUINN_APP_ID` | For bot identity | GitHub App ID — posts as `protoquinn[bot]` |
| `QUINN_APP_PRIVATE_KEY` | For bot identity | PKCS#1 PEM private key |
| `QUINN_API_KEY` | Agent auth | API key for Quinn agent endpoint |
| `QDRANT_URL` | For vector context | e.g. `http://qdrant:6333` |
| `QDRANT_VECTOR_SIZE` | No | Embedding dimensions (default: `768`) |
| `OLLAMA_URL` | For embeddings | e.g. `http://ollama:11434` |
| `OLLAMA_EMBED_MODEL` | No | Embedding model (default: `nomic-embed-text`) |

### Per-repo settings (`workspace/github.yaml`)

```yaml
mentionHandle: "@quinn"

skillHints:
  pull_request: pr_review           # auto-review on PR open/sync
  pull_request_review_comment: pr_review
  issue_comment: bug_triage
  issues: bug_triage
```

---

## Bus topics

Quinn consumes and emits via the GitHub plugin's standard topics:

| Topic | Direction | Description |
|---|---|---|
| `message.inbound.github.{owner}.{repo}.pull_request.{number}` | Consumed | Triggers `pr_review` skill |
| `message.outbound.github.{owner}.{repo}.{number}` | Emitted | Review comment posted via GitHub API |

Quinn does not publish custom bus topics. All output goes through RouterPlugin → GitHubPlugin using the standard `message.outbound.github.*` path.

---

## Limitations vs CodeRabbit

| Capability | Quinn | CodeRabbit |
|---|---|---|
| Inline diff comments | Yes | Yes |
| Repo-wide codebase context (vector search) | Yes | Limited |
| Auto-fix / follow-up PRs | No | Yes |
| Multi-turn review conversation | No | Yes |
| Config per repo (`.coderabbit.yaml`) | No (YAML skillHints only) | Yes |
| Review on draft PRs | No (unless `force_review`) | Configurable |
| IDE integration | No | Yes (some plans) |

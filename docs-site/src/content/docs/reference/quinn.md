---
title: Quinn — PR Review Bot Reference
---

# Quinn — PR Review Bot Reference

_This is a reference doc. It covers Quinn's review pipeline, vector context system, budget tracking, configuration, and bus topics._

See also:
- [`how-to/use-quinn-pr-review.md`](\1/) — setup and operation guide
- [`reference/bus-topics.md`](\1/) — full bus topic listing

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

Quinn uses three Qdrant collections to give reviews repo-wide awareness:

| Collection | Contents | Used for |
|---|---|---|
| `quinn-pr-history` | Embedded diff chunks from merged PRs | Past decisions for the same files |
| `quinn-code-patterns` | Symbol definitions + surrounding context | Similar code patterns across the codebase |
| `quinn-review-learnings` | Dismissed comment patterns | Low-signal comment filtering |

**Embedding model:** `nomic-embed-text` via Ollama (768-dimensional cosine vectors, configurable via `QDRANT_VECTOR_SIZE`).

**Token budget:** The assembled `CODEBASE CONTEXT` block is capped at **20% of the total prompt token budget** (default budget: 8,000 tokens → max 1,600 context tokens). Truncation priority:
1. Keep past PR decisions (highest value)
2. Trim similar patterns from lowest-scored first
3. Drop learnings summary last

### Learning loop

When a developer dismisses a Quinn review comment, `dismissal-tracker.ts` records the dismissal in `quinn-review-learnings`. `low-signal-filter.ts` uses this collection to suppress similar patterns in future reviews.

### PR history indexing

After a PR merges, `indexPRHistory()` (exported from `review-pipeline.ts`) embeds the merged diff and stores it in `quinn-pr-history`. This keeps the context collection current.

### Collection initialization

Collections are created on first use via `initializeCollections()` from `src/services/qdrant/collections.ts`. This is idempotent — safe to call on every startup.

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

Quinn does not publish custom bus topics. All output goes through A2APlugin → GitHubPlugin using the standard `message.outbound.github.*` path.

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

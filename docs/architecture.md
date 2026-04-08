# Architecture — protoWorkstacean

protoWorkstacean is a personal agent orchestration platform built on a hierarchical topic-based pub/sub message bus. It coordinates a fleet of specialized AI agents (Quinn, Ava, Frank, Jon, etc.) across GitHub, Discord, and Plane.

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     EventBus (in-process)                │
│           topic-based hierarchical pub/sub              │
└───────────┬────────────────────────────────┬────────────┘
            │                                │
   ┌────────▼────────┐              ┌────────▼────────┐
   │  Plugin Layer   │              │  Agent Layer    │
   │  (lib/plugins/) │              │  (workspace/)   │
   │                 │              │                 │
   │ • GitHubPlugin  │              │ • Quinn (PR     │
   │ • DiscordPlugin │              │   review, triage│
   │ • PlanePlugin   │              │ • Ava (features)│
   │ • A2APlugin     │              │ • Frank, Jon... │
   │ • CeremonyPlugin│              └─────────────────┘
   └─────────────────┘
```

## Plugin System

Plugins are instantiated with a `workspaceDir` and install themselves onto the EventBus:

```typescript
export class MyPlugin implements Plugin {
  readonly name = "my-plugin";
  install(bus: EventBus): void { /* subscribe + serve */ }
  uninstall(): void { /* cleanup */ }
}
```

Plugins use `Bun.serve()` for HTTP endpoints and `bus.subscribe()` / `bus.publish()` for internal routing.

## Quinn Vector Context Pipeline

Quinn's PR review pipeline extends beyond the diff with codebase-wide vector search via Qdrant:

```
PR opened/synchronize
  → GitHubPlugin → bus (message.inbound.github.*)
  → A2APlugin → Quinn agent (pr_review skill)
  → runReviewPipeline(diff, repo, pr)
      ├── parseDiff + extractSymbols
      ├── Qdrant: retrieveAllPastPRDecisions (quinn-pr-history)
      ├── Qdrant: findAllSimilarPatterns (quinn-code-patterns)
      ├── formatCodebaseContext + applyTokenBudget
      └── assembleReviewPrompt → LLM call

PR merged
  → GitHubPlugin → parsePRMergePayload → handlePRMerge
      ├── fetchPRDiff + fetchReviewDecision
      ├── chunkDiff → embed → quinn-pr-history
      └── extractSymbols → fetchSymbolContexts → quinn-code-patterns

Developer dismisses Quinn comment
  → GitHubPlugin → parseCommentResponsePayload
  → handleCommentResponse → trackCommentResponse
  → recordDismissalEvent → quinn-review-learnings
```

## Service Layer (`src/services/`)

| Package | Responsibility |
|---|---|
| `qdrant/client.ts` | Qdrant REST API client (5s timeout, fallback on error) |
| `qdrant/collections.ts` | Collection initialization (quinn-pr-history, quinn-code-patterns, quinn-review-learnings) |
| `qdrant/pr-history-indexer.ts` | Index PR diff chunks |
| `qdrant/code-patterns-indexer.ts` | Index symbol definitions |
| `qdrant/pattern-searcher.ts` | Search for similar code patterns |
| `qdrant/past-pr-retriever.ts` | Retrieve past PR decisions for a file |
| `qdrant/review-learnings-indexer.ts` | Store/update dismissed comment patterns |
| `embeddings/ollama-client.ts` | Ollama embedding API (nomic-embed-text) |
| `diff/chunker.ts` | Parse unified diff, chunk large files |
| `diff/symbol-extractor.ts` | Route to language-specific symbol extractors |
| `diff/symbols/typescript.ts` | TypeScript symbol extraction via regex |
| `diff/symbols/python.ts` | Python symbol extraction via regex |
| `diff/symbols/go.ts` | Go symbol extraction via regex |
| `github/diff-fetcher.ts` | Fetch PR diff, comments, and decision via GitHub API |
| `codebase/symbol-fetcher.ts` | Fetch symbol context via GitHub raw content API |
| `reviews/context-formatter.ts` | Format CODEBASE CONTEXT block |
| `reviews/token-budgeter.ts` | Enforce 20% token budget cap |
| `reviews/quinn-review-prompt.ts` | Assemble final review prompt |
| `reviews/review-pipeline.ts` | Orchestrate full context retrieval pipeline |
| `reviews/dismissal-tracker.ts` | Track developer responses to Quinn comments |
| `reviews/low-signal-filter.ts` | Filter low-signal comment patterns |

## External Services

| Service | URL | Purpose |
|---|---|---|
| Qdrant | `http://qdrant:6333` | Vector search and storage |
| Ollama | `http://ollama:11434` | Local LLM and embedding inference |
| GitHub API | `https://api.github.com` | PR data, diffs, comments |
| Plane | configured via `PLANE_API_URL` | Project management integration |
| Discord | bot token | Team notifications |

## Topic Conventions

```
message.inbound.github.<owner>.<repo>.<event>.<number>   — inbound from GitHub
message.outbound.github.<owner>.<repo>.<number>          — outbound to GitHub
message.inbound.discord.<channel>                        — inbound from Discord
message.outbound.discord.<channel>                       — outbound to Discord
```

## Configuration

All configuration is via environment variables. See `docs/CONFIGURATION_REFERENCE.md` for the full list.
Key variables for the Quinn vector context pipeline:

```
QDRANT_URL=http://qdrant:6333
QDRANT_VECTOR_SIZE=768
OLLAMA_URL=http://ollama:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
GITHUB_WEBHOOK_SECRET=<secret>
QUINN_APP_ID=<github-app-id>
QUINN_APP_PRIVATE_KEY=<pem-contents>
```

# Qdrant Schema — Quinn Vector Context

Quinn uses three Qdrant collections to store codebase history and review learnings.
All collections use cosine distance and 768-dimensional vectors from `nomic-embed-text` via Ollama.

## Collections

### `quinn-pr-history`

Stores embedded diff chunks from merged PRs with review decisions.

**Vector:** Diff chunk text (`File: <path>\n\n<diff lines>`), 768-dimensional.

**Metadata fields:**

| Field | Type | Description |
|---|---|---|
| `repo` | string | `owner/repo` slug, e.g. `protolabsai/protomaker` |
| `pr_number` | integer | GitHub PR number |
| `file` | string | Relative file path in the repository |
| `decision` | string | `APPROVE` or `REQUEST_CHANGES` |
| `merged_at` | string | ISO 8601 timestamp of merge |
| `pr_url` | string | Full GitHub URL to the PR |
| `chunk_index` | integer | Zero-based chunk index within the file |
| `line_start` | integer | First line number of the chunk |
| `line_end` | integer | Last line number of the chunk |
| `review_issues` | string | Comma-separated summary of Quinn-flagged issues |

**Query pattern:** Semantic search by file path + repo filter to retrieve past PR decisions on a file.

---

### `quinn-code-patterns`

Stores symbol definitions with surrounding context for cross-repo pattern matching.

**Vector:** `Symbol: <name> (<type>)\nFile: <path>\n\n<context lines>`, 768-dimensional.

**Metadata fields:**

| Field | Type | Description |
|---|---|---|
| `repo` | string | `owner/repo` slug |
| `file` | string | Relative file path |
| `symbol_name` | string | Function, class, or export name |
| `symbol_type` | string | `function`, `class`, `interface`, `export`, `method` |
| `language` | string | `typescript`, `python`, `go`, `unknown` |
| `line` | integer | Line number of the symbol definition |
| `context` | string | Definition + surrounding lines with line numbers |

**Query pattern:** Semantic search for similar symbols, optionally excluding the current file.

---

### `quinn-review-learnings`

Tracks dismissed comment patterns to prevent low-signal feedback repetition.

**Vector:** Quinn comment body text, 768-dimensional.

**Metadata fields:**

| Field | Type | Description |
|---|---|---|
| `repo` | string | `owner/repo` slug |
| `file_type` | string | File extension (`ts`, `py`, `go`, etc.) |
| `dismissed_count` | integer | Number of times this pattern was dismissed |
| `approval_count` | integer | Number of times this pattern led to a fix |
| `most_recent_reason` | string | Last developer-provided dismissal reason |
| `last_updated` | string | ISO 8601 timestamp of most recent update |

**Query pattern:** Semantic search by comment text + repo + file_type filter. Dismissal rate = `dismissed_count / (dismissed_count + approval_count)`.

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant service URL |
| `QDRANT_VECTOR_SIZE` | `768` | Vector dimensions (must match embedding model) |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama service URL |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |

## Failure Modes

- **Qdrant unavailable:** All Qdrant calls return empty results. Review falls back to diff-only mode.
- **Collection missing:** `initializeCollections()` auto-creates collections on startup.
- **Embedding failure:** Individual chunks are skipped. Warning logged if failure rate > 10%.
- **Timeout:** All Qdrant calls have a 5-second timeout. Embedding calls have a 30-second timeout.

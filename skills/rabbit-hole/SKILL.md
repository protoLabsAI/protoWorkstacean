---
name: rabbit-hole
description: Use the `rh` CLI (@protolabsai/rabbit-hole-cli) to search the web, search the user's ingested file corpus (recall), run multi-step deep research, and ingest documents/URLs/audio/video for parsing + embedding. Trigger whenever the agent needs external/web information, needs to look something up in previously-ingested files, wants a synthesized research report, or needs to add a document to the searchable corpus — and `rh` is available on PATH.
---

# Rabbit Hole (`rh`) — search, recall, research, ingest

`rh` is a small CLI a fleet agent shells out to for information retrieval. It
talks to a self-hosted stack: a web-search backend (SearXNG, Tavily fallback),
an LLM gateway (OpenAI-compatible), and a job-processor that parses/embeds files
into a pgvector corpus. **Every command prints JSON to stdout by default** —
parse that. Logs go to stderr.

## When to use which command

| Need | Command |
|---|---|
| Current/external facts from the web | `rh search` |
| Something from the **user's own ingested files** | `rh recall` |
| A synthesized, multi-source report on a topic | `rh research` |
| Add a file/URL/media to the searchable corpus | `rh ingest` |
| Check / wait on an ingest job | `rh status` |

Prefer `rh recall` over `rh search` when the answer is likely in the user's
documents. Use `rh search` for fresh/public info. Use `rh research` only when a
single search isn't enough and a written synthesis is wanted (it's slower — it
makes several LLM + search calls).

## Commands

### `rh search "<query>" [--text] [-m <n>]`
Web search (SearXNG, falling back to Tavily). JSON by default; `-m` caps results
(default 5). `--text` for human-readable markdown.
```bash
rh search "pgvector hnsw vs ivfflat" -m 3
```
```json
{ "query": "...", "provider": "searxng",
  "results": [ { "title": "...", "url": "https://...", "content": "snippet", "score": 0.9 } ] }
```
> Web results vary by query; an occasional empty `results` is a transient
> backend hiccup — retry or rephrase.

### `rh recall "<query>" [--text] [-k <n>]`
Vector search over the ingested corpus (cosine similarity, qwen3 embeddings).
`-k` sets how many chunks to return (default 8). Returns nothing useful if the
corpus is empty — ingest first.
```bash
rh recall "what did our spec say about retries" -k 5
```
```json
{ "query": "...", "count": 5,
  "hits": [ { "documentId": "<jobId>", "source": "https://… or filename",
              "chunkIndex": 3, "content": "…matching text…", "score": 0.66,
              "metadata": { } } ] }
```

### `rh research "<topic>" [-d <depth>] [--max-results <n>]`
Multi-step: the LLM plans `-d` sub-queries (default 2), searches each, then
synthesizes a **markdown report with inline `[n]` citations** (printed to
stdout). Pipe it to a file cleanly — logs are on stderr.
```bash
rh research "tradeoffs of HNSW vs IVFFlat in pgvector" -d 3 > report.md
```

### `rh ingest <path|url> [-m <mime-type>] [--wait]`
Queue a local file or URL for parse/transcribe → embed → store in the corpus.
Returns the **caller-tracked `jobId`** (a UUID). With `--wait`, blocks until the
job finishes (polls every ~2s) and exits non-zero on failure.
```bash
rh ingest ./contract.pdf --wait
rh ingest "https://example.com/article" -m text/html
```
```json
{ "success": true, "jobId": "e4b5…uuid", "sidequestId": "12", "queue": "media-ingestion" }
```
Use the returned **`jobId`** for `rh status` and as the `documentId` you'll see
in later `rh recall` hits.

### `rh status <job-id> [--wait] [--result]`
State of an ingest job: `queued` → `processing` → `completed` / `failed`.
`--wait` polls to a terminal state; `--result` also returns the stored
extraction once `completed`.
```bash
rh status e4b5…uuid --wait --result
```
```json
{ "jobId": "e4b5…uuid", "status": "completed", "category": "document",
  "textLength": 144, "artifactsCount": 0 }
```

## Typical workflow

```bash
# 1. Ingest a doc and wait for it to be searchable
jobid=$(rh ingest ./whitepaper.pdf | sed -n 's/.*"jobId": *"\([^"]*\)".*/\1/p')
rh status "$jobid" --wait
# 2. Now recall against it
rh recall "key findings on latency" -k 5
```

## Configuration

Config resolves: CLI flags → env vars (`RH_*`) → `~/.config/rh/config.yaml` →
defaults. The defaults assume you're **inside the stack's Docker network**
(service hostnames resolve). From outside, override the URLs.

| Env var | Default | Purpose |
|---|---|---|
| `RH_JOB_PROCESSOR_URL` | `http://job-processor:8680` | `ingest` / `status` / `recall` |
| `RH_SEARXNG_ENDPOINT` (or `SEARXNG_ENDPOINT`) | `http://searxng:8080` | web search (preferred) |
| `RH_TAVILY_API_KEY` (or `TAVILY_API_KEY`) | _optional_ | web-search fallback |
| `RH_LLM_BASE_URL` (or `OPENAI_BASE_URL`) | `http://gateway:4000/v1` | LLM gateway |
| `RH_LLM_KEY` (or `OPENAI_API_KEY`) | _required for recall/research_ | gateway key |
| `RH_LLM_MODEL` | `protolabs/smart` | research synthesis model |

If you're running from a host (not the docker network), a minimal setup:
```bash
export RH_JOB_PROCESSOR_URL=http://localhost:8680
export RH_LLM_BASE_URL=http://localhost:4000/v1
export RH_LLM_KEY=<gateway-key>
```

## Notes for agents

- **Parse JSON, not prose.** Default output is JSON; only pass `--text` when a
  human will read it.
- `recall` and `research` need a working LLM gateway key (`RH_LLM_KEY`);
  `search` and `ingest` do not.
- `recall` only finds what's been ingested — if it returns `count: 0`, either
  the corpus is empty or nothing matched; consider `rh search` instead.
- Treat `rh ingest --wait` as the way to ensure a doc is searchable before you
  `rh recall` it; without `--wait`, indexing finishes asynchronously.
- Run `rh --help` or `rh <command> --help` to confirm flags in your version.

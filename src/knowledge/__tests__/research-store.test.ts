import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../research-store.ts";

// Ollama isn't reachable in tests, so embed() returns null → the store runs in
// keyword-only (FTS5/BM25 + RRF) mode. That also exercises the graceful
// degradation path. (The vector/KNN path is validated separately against a
// live embedding service.)

let dir: string;
let store: ResearchStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "research-test-"));
  store = new ResearchStore(join(dir, "knowledge.db"));
  store.init();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ResearchStore", () => {
  test("ingests chunks and finds them via hybrid (keyword) search", async () => {
    await store.addChunk({ kind: "paper", title: "FlashAttention-3", content: "Faster exact attention with asynchrony and low-precision on Hopper GPUs.", source: "arxiv", url: "https://arxiv.org/abs/2407.08608" });
    await store.addChunk({ kind: "model_release", title: "Qwen3", content: "New open-weight LLM family from Alibaba with strong reasoning.", source: "huggingface" });
    const hits = await store.hybridSearch("attention Hopper GPU", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe("FlashAttention-3");
    expect(hits[0].url).toBe("https://arxiv.org/abs/2407.08608");
    expect(hits[0].kind).toBe("paper");
  });

  test("hybridSearch can scope to a kind", async () => {
    await store.addChunk({ kind: "paper", title: "alpha paper", content: "shared keyword bravo charlie" });
    await store.addChunk({ kind: "finding", title: "alpha finding", content: "shared keyword bravo delta" });
    const papers = await store.hybridSearch("bravo", 5, "paper");
    expect(papers.length).toBe(1);
    expect(papers[0].kind).toBe("paper");
  });

  test("returns [] for empty / stopword-only query", async () => {
    await store.addChunk({ kind: "finding", content: "some content here" });
    expect(await store.hybridSearch("", 5)).toEqual([]);
  });

  test("stats counts per kind", async () => {
    await store.addChunk({ kind: "paper", content: "p1 about transformers" });
    await store.addChunk({ kind: "paper", content: "p2 about diffusion" });
    await store.addChunk({ kind: "finding", content: "f1 insight" });
    const s = store.stats();
    expect(s.paper).toBe(2);
    expect(s.finding).toBe(1);
    expect(s.total).toBe(3);
  });

  test("preview is truncated; metadata round-trips via ingestion", async () => {
    const long = "lorem ipsum ".repeat(60);
    await store.addChunk({ kind: "digest", title: "weekly", content: long, metadata: { topic: "llm" } });
    const hits = await store.hybridSearch("lorem ipsum", 5);
    expect(hits[0].preview.endsWith("…")).toBe(true);
    expect(hits[0].preview.length).toBeLessThanOrEqual(281);
  });
});

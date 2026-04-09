/**
 * Pattern searcher — queries quinn-code-patterns for similar usages of changed
 * symbols across the repository.
 */

import { searchPoints } from "./client.ts";
import { COLLECTION_CODE_PATTERNS } from "./collections.ts";
import { embed } from "../embeddings/ollama-client.ts";
import type { ExtractedSymbol } from "../diff/symbol-extractor.ts";

const TOP_K = 5;

export interface SimilarPattern {
  repo: string;
  file: string;
  symbolName: string;
  symbolType: string;
  line: number;
  context: string;
  score: number;
}

/**
 * Find top-5 similar code patterns for a given symbol.
 * Returns empty array if Qdrant is unavailable or embedding fails.
 */
export async function findSimilarPatterns(
  symbol: ExtractedSymbol,
  excludeFile?: string,
): Promise<SimilarPattern[]> {
  const query = `${symbol.name} ${symbol.type} ${symbol.language}`;
  const vector = await embed(query);
  if (!vector) return [];

  const filter = excludeFile
    ? { must_not: [{ key: "file", match: { value: excludeFile } }] }
    : undefined;

  const results = await searchPoints(COLLECTION_CODE_PATTERNS, vector, TOP_K, filter);

  return results.map(r => ({
    repo: String(r.payload.repo ?? ""),
    file: String(r.payload.file ?? ""),
    symbolName: String(r.payload.symbol_name ?? ""),
    symbolType: String(r.payload.symbol_type ?? ""),
    line: Number(r.payload.line ?? 0),
    context: String(r.payload.context ?? ""),
    score: r.score,
  }));
}

/**
 * Find similar patterns for all extracted symbols.
 * Skips symbols that fail to embed — logs warning but continues.
 */
export async function findAllSimilarPatterns(
  symbols: ExtractedSymbol[],
): Promise<Map<string, SimilarPattern[]>> {
  const results = new Map<string, SimilarPattern[]>();

  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.filePath ?? ""}`;
    const patterns = await findSimilarPatterns(symbol, symbol.filePath);
    if (patterns.length > 0) {
      results.set(key, patterns);
    }
  }

  return results;
}

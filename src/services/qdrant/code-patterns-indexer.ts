/**
 * Code patterns indexer — indexes symbol definitions with surrounding context
 * into quinn-code-patterns.
 *
 * For each extracted symbol, embeds the definition + context lines and stores
 * to Qdrant for cross-repo pattern matching.
 */

import { upsertPoints } from "./client.ts";
import { COLLECTION_CODE_PATTERNS } from "./collections.ts";
import { embed } from "../embeddings/ollama-client.ts";
import type { SymbolContext } from "../codebase/symbol-fetcher.ts";

/**
 * Index symbol contexts into quinn-code-patterns.
 * Returns number of points successfully indexed.
 */
export async function indexCodePatterns(symbolContexts: SymbolContext[]): Promise<number> {
  let indexed = 0;
  let failures = 0;

  for (const sc of symbolContexts) {
    const text = `Symbol: ${sc.symbol.name} (${sc.symbol.type})\nFile: ${sc.filePath}\n\n${sc.context}`;
    const vector = await embed(text);

    if (!vector) {
      failures++;
      const total = indexed + failures;
      if (total >= 10 && failures / total > 0.1) {
        console.warn(`[code-patterns-indexer] High embedding failure rate: ${failures}/${total}`);
      }
      continue;
    }

    const id = `${sc.repo}-${sc.filePath.replace(/\//g, "_")}-${sc.symbol.name}-${sc.symbol.line}`;
    const pointId = hashString(id);

    const success = await upsertPoints(COLLECTION_CODE_PATTERNS, [{
      id: pointId,
      vector,
      payload: {
        repo: sc.repo,
        file: sc.filePath,
        symbol_name: sc.symbol.name,
        symbol_type: sc.symbol.type,
        language: sc.symbol.language,
        line: sc.symbol.line,
        context: sc.context,
      },
    }]);

    if (success) indexed++;
  }

  console.log(`[code-patterns-indexer] ${indexed} symbol contexts indexed, ${failures} failed`);
  return indexed;
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0;
  }
  return h;
}

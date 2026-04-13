/**
 * Symbol fetcher — retrieves the definition and surrounding context for a
 * changed symbol from the GitHub raw content API.
 *
 * Used by the code-patterns indexer to embed real symbol context (not just
 * the diff line) into quinn-code-patterns.
 */

import type { ExtractedSymbol } from "../diff/symbol-extractor.ts";
import { HttpClient } from "../http-client.ts";

const CONTEXT_LINES = 10; // lines before and after the symbol definition

const githubRawHttp = new HttpClient({
  baseUrl: "https://raw.githubusercontent.com",
  headers: { "User-Agent": "protoWorkstacean/1.0" },
});

export interface SymbolContext {
  symbol: ExtractedSymbol;
  context: string;
  filePath: string;
  repo: string;
}

/**
 * Fetch lines around a symbol from a GitHub repo at a given ref.
 *
 * Returns null if the file cannot be fetched.
 */
export async function fetchSymbolContext(
  owner: string,
  repo: string,
  ref: string,
  symbol: ExtractedSymbol,
  token: string,
): Promise<SymbolContext | null> {
  const filePath = symbol.filePath ?? "";
  if (!filePath) return null;

  try {
    const text = await githubRawHttp.get(`/${owner}/${repo}/${ref}/${filePath}`, {
      auth: { type: "bearer", token },
      responseType: "text",
    }) as string;
    const lines = text.split("\n");
    const targetLine = symbol.line - 1; // convert to 0-based index

    const start = Math.max(0, targetLine - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, targetLine + CONTEXT_LINES);
    const contextLines = lines.slice(start, end + 1);

    // Prefix with line numbers for clarity
    const context = contextLines
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n");

    return {
      symbol,
      context,
      filePath,
      repo: `${owner}/${repo}`,
    };
  } catch (err) {
    console.error(`[symbol-fetcher] fetchSymbolContext error for ${filePath}:`, err);
    return null;
  }
}

/**
 * Fetch context for multiple symbols, skipping any that fail.
 */
export async function fetchSymbolContexts(
  owner: string,
  repo: string,
  ref: string,
  symbols: ExtractedSymbol[],
  token: string,
): Promise<SymbolContext[]> {
  const results = await Promise.allSettled(
    symbols.map(sym => fetchSymbolContext(owner, repo, ref, sym, token)),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<SymbolContext> =>
      r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}
